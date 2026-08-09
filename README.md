# webgpu-asset-exporter

Turn WGSL / WebGPU shaders into standard asset files.

**Supported conversions:**

| Source | Target formats |
|--------|----------------|
| WGSL fragment shader | PNG, JPEG, WebP, AVIF, GIF (still), ICO (favicon) |
| WGSL fragment shader | MP4, WebM, OGV, animated GIF |
| WGSL compute shader | WAV, MP3, OGG |

## Install

```bash
npm install webgpu-asset-exporter
```

Optional peer dependencies (install only what you need):

```bash
# Still images + favicons
npm install sharp

# Video + animated GIF + compressed audio (mp3/ogg)
npm install @ffmpeg-installer/ffmpeg

# Headless WebGPU (required for any rendering)
npm install webgpu
```

> **Note on `webgpu`:** The current native binding is platform-sensitive.  
> You may need a software renderer (SwiftShader / lavapipe) or a GPU-enabled environment.

## Quick start

```js
import { exportImage, exportVideo, exportAudio } from 'webgpu-asset-exporter';

// 1. Fragment shader → PNG
const png = await exportImage({
  wgsl: `
    @fragment
    fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
      return vec4f(uv.x, uv.y, 0.5, 1.0);
    }
  `,
  width: 512,
  height: 512,
  format: 'png',
  time: 0,
});

// 2. Fragment shader → MP4
const mp4 = await exportVideo({
  wgsl: `/* same shape as above */`,
  width: 640,
  height: 360,
  format: 'mp4',
  durationSeconds: 2,
  fps: 30,
});

// 3. Compute shader → WAV
const wav = await exportAudio({
  wgsl: `
    struct AudioParams {
      sampleRate: f32,
      totalSamples: u32,
      channels: u32,
      _pad: u32,
    };
    @group(0) @binding(0) var<uniform> params: AudioParams;
    @group(0) @binding(1) var<storage, read_write> samples: array<f32>;

    @compute @workgroup_size(64)
    fn cs_main(@builtin(global_invocation_id) id: vec3u) {
      let i = id.x;
      if (i >= params.totalSamples) { return; }
      let t = f32(i) / params.sampleRate;
      samples[i] = sin(2.0 * 3.14159265 * 440.0 * t) * 0.3;
    }
  `,
  durationSeconds: 1,
  format: 'wav',
});
```

## API

### `exportImage(opts)`
Renders one frame of a fragment shader to a still image.

| Option | Type | Description |
|--------|------|-------------|
| `wgsl` | string | Fragment shader with `fs_main` entry point |
| `width` / `height` | number | Output size |
| `format` | string | `png` \| `jpeg` \| `jpg` \| `webp` \| `avif` \| `gif` |
| `time` | number | Seconds (passed as `builtin.time`) |
| `vertexWgsl` | string | Optional custom vertex stage |
| `encodeOptions` | object | Passed to sharp |

### `exportFavicon(opts)`
Same as above but packs multiple sizes into a single `.ico`.

### `exportVideo(opts)`
Renders a sequence of frames and encodes to video or animated GIF.

| Option | Type | Description |
|--------|------|-------------|
| `wgsl` | string | Fragment shader |
| `width` / `height` | number | Frame size |
| `format` | string | `mp4` \| `webm` \| `ogv` \| `gif` |
| `durationSeconds` | number | Length of the video |
| `fps` | number | Default 30 |
| `onProgress` | function | `(rendered, total) => void` |

### `exportAudio(opts)`
Runs a compute shader and encodes the resulting samples.

| Option | Type | Description |
|--------|------|-------------|
| `wgsl` | string | Compute shader with `cs_main` (see contract below) |
| `durationSeconds` | number | Length of the audio |
| `format` | string | `wav` \| `mp3` \| `ogg` |
| `sampleRate` | number | Default 44100 |

## Shader contracts

### Fragment shaders
The library injects this uniform automatically — **do not declare it yourself**:

```wgsl
struct BuiltinUniforms {
  resolution: vec2f,
  time: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> builtin: BuiltinUniforms;
```

A full-screen triangle is supplied by default. UV is available at `@location(0)`.

### Compute shaders (audio)
Your WGSL must follow this binding contract:

```wgsl
struct AudioParams {
  sampleRate: f32,
  totalSamples: u32,
  channels: u32,
  _pad: u32,
};
@group(0) @binding(0) var<uniform> params: AudioParams;
@group(0) @binding(1) var<storage, read_write> samples: array<f32>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) id: vec3u) { ... }
```

Only mono (`channels: 1`) is fully supported end-to-end at the moment.

## What is deliberately **not** supported

- SVG, fonts, CSS, JS, PDF, etc. from shaders  
  These are not coherent source→target operations (a shader is an imperative program, not vector path or glyph data).

## Project structure

```
src/
  index.js                  # Public API
  core/
    gpu-backend.js          # Headless WebGPU device acquisition
    fragment-renderer.js    # Full-screen triangle → RGBA
    compute-audio-renderer.js
  image/
    encode-image.js         # sharp + ICO packer
  video/
    encode-video.js         # ffmpeg (mp4/webm/ogv/gif)
  audio/
    encode-audio.js         # WAV (pure JS) + mp3/ogg (ffmpeg)
```

## Development

```bash
git clone https://github.com/uut12345qwert-collab/webgpu-wgsl-to-assets.git
cd webgpu-wgsl-to-assets
npm install
npm test
```

## License

MIT
