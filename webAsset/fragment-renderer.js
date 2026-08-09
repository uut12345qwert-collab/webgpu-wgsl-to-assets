/**
 * fragment-renderer.js
 *
 * Renders a WGSL fragment shader across a full-screen triangle into an
 * offscreen texture, then reads the pixels back to a Buffer (RGBA8,
 * row-major, top-to-bottom). This is the shared primitive for both
 * still-image export and frame-sequence (video) export.
 *
 * Assumptions this makes explicit, since they constrain what "WGSL to
 * image" can mean:
 *  - The shader must expose a fragment entry point compatible with a
 *    full-screen triangle vertex stage (we supply a standard one unless
 *    the caller passes their own vertex WGSL).
 *  - Uniforms available to the shader by default: resolution (vec2f),
 *    time (f32, seconds). Additional uniforms can be passed via
 *    `uniformBufferData` + a matching `@group(0) @binding(1)` struct in
 *    the user's WGSL — this library does not attempt to infer bindings
 *    from arbitrary WGSL, since that's a much larger reflection problem.
 */

import { getGpuDevice } from './gpu-backend.js';

const DEFAULT_VERTEX_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var out: VertexOutput;
  out.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  out.uv = uvs[vertexIndex];
  return out;
}
`;

const BUILTIN_UNIFORMS_WGSL_HEADER = /* wgsl */ `
struct BuiltinUniforms {
  resolution: vec2f,
  time: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> builtin: BuiltinUniforms;
`;

export class FragmentRenderer {
  /**
   * @param {object} opts
   * @param {string} opts.fragmentWgsl - WGSL source with an `fs_main` entry
   *   point returning vec4f. The renderer prepends a builtin uniform
   *   struct bound at (0,0): `resolution: vec2f, time: f32`.
   * @param {string} [opts.vertexWgsl] - Optional custom vertex stage.
   *   Defaults to a full-screen triangle with UV output at location 0.
   * @param {number} opts.width
   * @param {number} opts.height
   * @param {GPUTextureFormat} [opts.format='rgba8unorm']
   */
  constructor({ fragmentWgsl, vertexWgsl = DEFAULT_VERTEX_WGSL, width, height, format = 'rgba8unorm' }) {
    if (!fragmentWgsl || typeof fragmentWgsl !== 'string') {
      throw new TypeError('fragmentWgsl (string) is required');
    }
    if (!width || !height || width <= 0 || height <= 0) {
      throw new TypeError('width and height must be positive numbers');
    }
    this.fragmentWgsl = BUILTIN_UNIFORMS_WGSL_HEADER + '\n' + fragmentWgsl;
    this.vertexWgsl = vertexWgsl;
    this.width = width;
    this.height = height;
    this.format = format;
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;

    const { device } = await getGpuDevice();
    this.device = device;

    // Bytes-per-row for texture-to-buffer copy must be a multiple of 256.
    this.bytesPerPixel = 4; // rgba8unorm
    this.unpaddedBytesPerRow = this.width * this.bytesPerPixel;
    this.paddedBytesPerRow = Math.ceil(this.unpaddedBytesPerRow / 256) * 256;

    this.renderTexture = device.createTexture({
      size: { width: this.width, height: this.height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    this.readbackBuffer = device.createBuffer({
      size: this.paddedBytesPerRow * this.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    this.uniformBuffer = device.createBuffer({
      size: 16, // vec2f + f32 + f32 padding, aligned to 16
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    let vertexModule, fragmentModule;
    try {
      vertexModule = device.createShaderModule({ code: this.vertexWgsl });
      fragmentModule = device.createShaderModule({ code: this.fragmentWgsl });
    } catch (err) {
      throw new Error(`WGSL shader module compilation failed: ${err.message}`);
    }

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: vertexModule, entryPoint: 'vs_main' },
      fragment: {
        module: fragmentModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this._initialized = true;
  }

  /**
   * Renders one frame at the given time (seconds) and returns raw RGBA8
   * pixels as a Buffer, unpadded (width*height*4 bytes, row-major).
   * @param {number} timeSeconds
   * @returns {Promise<Buffer>}
   */
  async renderFrame(timeSeconds = 0) {
    if (!this._initialized) await this.init();
    const device = this.device;

    const uniformData = new Float32Array([this.width, this.height, timeSeconds, 0]);
    device.queue.writeBuffer(this.uniformBuffer, 0, uniformData.buffer);

    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.renderTexture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.draw(3);
    passEncoder.end();

    commandEncoder.copyTextureToBuffer(
      { texture: this.renderTexture },
      { buffer: this.readbackBuffer, bytesPerRow: this.paddedBytesPerRow, rowsPerImage: this.height },
      { width: this.width, height: this.height }
    );

    device.queue.submit([commandEncoder.finish()]);

    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    const paddedData = new Uint8Array(this.readbackBuffer.getMappedRange().slice(0));
    this.readbackBuffer.unmap();

    // Strip row padding if bytesPerRow was rounded up to the 256-byte alignment.
    if (this.paddedBytesPerRow === this.unpaddedBytesPerRow) {
      return Buffer.from(paddedData.buffer, paddedData.byteOffset, paddedData.byteLength);
    }
    const unpadded = Buffer.alloc(this.unpaddedBytesPerRow * this.height);
    for (let row = 0; row < this.height; row++) {
      const srcStart = row * this.paddedBytesPerRow;
      const dstStart = row * this.unpaddedBytesPerRow;
      paddedData
        .subarray(srcStart, srcStart + this.unpaddedBytesPerRow)
        .forEach((byte, i) => { unpadded[dstStart + i] = byte; });
    }
    return unpadded;
  }

  /**
   * Renders a sequence of frames at evenly-spaced timestamps.
   * @param {object} opts
   * @param {number} opts.durationSeconds
   * @param {number} opts.fps
   * @param {(frameIndex: number, total: number) => void} [opts.onProgress]
   * @returns {Promise<Buffer[]>} array of raw RGBA8 frame buffers
   */
  async renderSequence({ durationSeconds, fps, onProgress } = {}) {
    if (!durationSeconds || durationSeconds <= 0) throw new TypeError('durationSeconds must be positive');
    if (!fps || fps <= 0) throw new TypeError('fps must be positive');

    const totalFrames = Math.round(durationSeconds * fps);
    const frames = [];
    for (let i = 0; i < totalFrames; i++) {
      const t = i / fps;
      frames.push(await this.renderFrame(t));
      if (onProgress) onProgress(i + 1, totalFrames);
    }
    return frames;
  }

  destroy() {
    this.renderTexture?.destroy?.();
    this.readbackBuffer?.destroy?.();
    this.uniformBuffer?.destroy?.();
    this._initialized = false;
  }
}
