/**
 * compute-audio-renderer.js
 *
 * Runs a WGSL *compute* shader to synthesize PCM audio samples into a
 * storage buffer, then reads them back as Float32 samples in [-1, 1].
 *
 * This is a genuinely different shape of problem than fragment
 * rendering: there's no rasterization, no texture, just a compute
 * dispatch writing into a linear buffer. The library does not attempt
 * to convert *arbitrary* WGSL (fragment/vertex shaders) into audio —
 * only WGSL written as a compute kernel that emits samples, since
 * that's the only case where "shader to audio" is a well-defined
 * operation rather than a category error.
 *
 * Contract expected of the user's WGSL:
 *   @group(0) @binding(0) var<uniform> params: AudioParams;
 *   @group(0) @binding(1) var<storage, read_write> samples: array<f32>;
 *
 *   struct AudioParams {
 *     sampleRate: f32,
 *     totalSamples: u32,
 *     channels: u32,
 *     _pad: u32,
 *   };
 *
 *   @compute @workgroup_size(64)
 *   fn cs_main(@builtin(global_invocation_id) id: vec3u) {
 *     let i = id.x;
 *     if (i >= params.totalSamples) { return; }
 *     let t = f32(i) / params.sampleRate;
 *     samples[i] = sin(2.0 * 3.14159265 * 440.0 * t); // e.g. 440Hz tone
 *   }
 *
 * The library supplies the uniform buffer and the storage buffer; the
 * user's WGSL supplies the synthesis logic. This mirrors the fragment
 * renderer's division of responsibility (library owns plumbing/uniforms,
 * caller owns the actual shader logic) and avoids silently inventing
 * synthesis semantics the caller didn't ask for.
 */

import { getGpuDevice } from './gpu-backend.js';

const WORKGROUP_SIZE = 64;
const MAX_STORAGE_BUFFER_FLOATS = 64 * 1024 * 1024; // ~256MB worth of f32, generous safety cap

export class ComputeAudioRenderer {
  /**
   * @param {object} opts
   * @param {string} opts.computeWgsl - Must define `cs_main` per the
   *   contract in this file's header comment.
   * @param {number} [opts.sampleRate=44100]
   * @param {number} [opts.channels=1] - Only 1 (mono) is currently
   *   supported end-to-end for encoding; higher channel counts can be
   *   synthesized but interleaving/encoding is the caller's job for now.
   */
  constructor({ computeWgsl, sampleRate = 44100, channels = 1 }) {
    if (!computeWgsl || typeof computeWgsl !== 'string') {
      throw new TypeError('computeWgsl (string) is required');
    }
    if (channels !== 1) {
      throw new Error(
        `channels=${channels} requested, but only mono (channels=1) is ` +
        'currently supported by the audio encoders in this library. ' +
        'Run separate synthesis passes per channel and interleave yourself ' +
        'if you need stereo.'
      );
    }
    this.computeWgsl = computeWgsl;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;
    const { device } = await getGpuDevice();
    this.device = device;

    let computeModule;
    try {
      computeModule = device.createShaderModule({ code: this.computeWgsl });
    } catch (err) {
      throw new Error(`WGSL compute shader compilation failed: ${err.message}`);
    }
    this.computeModule = computeModule;
    this._initialized = true;
  }

  /**
   * Synthesizes `durationSeconds` of audio.
   * @param {number} durationSeconds
   * @returns {Promise<Float32Array>} samples in [-1, 1], length = round(durationSeconds * sampleRate)
   */
  async render(durationSeconds) {
    if (!durationSeconds || durationSeconds <= 0) throw new TypeError('durationSeconds must be positive');
    if (!this._initialized) await this.init();

    const device = this.device;
    const totalSamples = Math.round(durationSeconds * this.sampleRate);

    if (totalSamples > MAX_STORAGE_BUFFER_FLOATS) {
      throw new Error(
        `Requested ${totalSamples} samples exceeds the safety cap of ` +
        `${MAX_STORAGE_BUFFER_FLOATS}. Render in chunks and concatenate ` +
        'if you need longer audio.'
      );
    }

    const uniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const uniformData = new ArrayBuffer(16);
    const uniformView = new DataView(uniformData);
    uniformView.setFloat32(0, this.sampleRate, true);
    uniformView.setUint32(4, totalSamples, true);
    uniformView.setUint32(8, this.channels, true);
    uniformView.setUint32(12, 0, true);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const storageByteLength = totalSamples * 4; // f32
    const storageBuffer = device.createBuffer({
      size: storageByteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const readbackBuffer = device.createBuffer({
      size: storageByteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: storageBuffer } },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

    let pipeline;
    try {
      pipeline = device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module: this.computeModule, entryPoint: 'cs_main' },
      });
    } catch (err) {
      throw new Error(
        `Failed to create compute pipeline — check that your WGSL defines ` +
        `'cs_main' with the expected bindings (see compute-audio-renderer.js ` +
        `header for the required contract). Original error: ${err.message}`
      );
    }

    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    const workgroupCount = Math.ceil(totalSamples / WORKGROUP_SIZE);
    passEncoder.dispatchWorkgroups(workgroupCount);
    passEncoder.end();

    commandEncoder.copyBufferToBuffer(storageBuffer, 0, readbackBuffer, 0, storageByteLength);
    device.queue.submit([commandEncoder.finish()]);

    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const samples = new Float32Array(readbackBuffer.getMappedRange().slice(0));
    readbackBuffer.unmap();

    uniformBuffer.destroy();
    storageBuffer.destroy();
    readbackBuffer.destroy();

    return samples;
  }
}
