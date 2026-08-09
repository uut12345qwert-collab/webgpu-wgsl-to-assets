# webgpu-asset-exporter

Renders WGSL/WebGPU shader output to standard asset files. Covers three
specific, well-defined transformations:

1. **WGSL fragment shader → still image** (PNG, JPEG, WebP, AVIF, GIF, ICO/favicon)
2. **WGSL fragment shader → video** (MP4, WebM, OGV) or animated GIF
5. **WGSL compute shader → audio** (WAV, MP3, OGG)

(Numbering matches the original task list this was scoped against — tasks
3/4/6/7 from that list, e.g. SVG-from-shader or fonts-from-shader, were
excluded because they aren't well-defined operations; see "Why not
everything" below.)

## Install

```bash
npm install webgpu-asset-exporter
```

Image export needs `sharp`; video and compressed-audio export need
`@ffmpeg-installer/ffmpeg`. Both are peer dependencies — install whichever
your usage needs:

```bash
npm install sharp                      # for exportImage / exportFavicon
npm install @ffmpeg-installer/ffmpeg   # for exportVideo / exportAudio (mp3/ogg)
```

`exportAudio` with `format: 'wav'` needs neither — WAV encoding is
implemented directly with no external dependency.

## API

```js
import { exportImage, exportFavicon, exportVideo, exportAudio } from 'webgpu-asset-exporter';

// 1. Fragment shader -> image
const png = await exportImage({
  wgsl: `
    @fragment
    fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
      return vec4f(uv.x, uv.y, sin(builtin.time), 1.0);
    }
  `,
  width: 512,
  height: 512,
  format: 'png', // png | jpeg | jpg | webp | avif | gif
  time: 0,       // seconds, passed as builtin.time uniform
});

// Favicon (multi-resolution .ico)
const ico = await exportFavicon({
  wgsl: /* same fragment shader shape */ '...',
  sourceSize: 256,
  sizes: [16, 32, 48, 64],
});

// 2. Fragment shader -> video / animated GIF
const mp4 = await exportVideo({
  wgsl: /* ... */ '...',
  width: 640,
  height: 360,
  format: 'mp4', // mp4 | webm | ogv | gif
  durationSeconds: 3,
  fps: 30,
  onProgress: (rendered, total) => console.log(`${rendered}/${total}`),
});

// 5. Compute shader -> audio
const wav = await exportAudio({
  wgsl: `
    struct AudioParams { sampleRate: f32, totalSamples: u32, channels: u32, _pad: u32 };
    @group(0) @binding(0) var<uniform> params: AudioParams;
    @group(0) @binding(1) var<storage, read_write> samples: array<f32>;

    @compute @workgroup_size(64)
    fn cs_main(@builtin(global_invocation_id) id: vec3u) {
      let i = id.x;
      if (i >= params.totalSamples) { return; }
      let t = f32(i) / params.sampleRate;
      samples[i] = sin(2.0 * 3.14159265 * 440.0 * t) * 0.3; // 440Hz tone
    }
  `,
  durationSeconds: 2,
  format: 'wav', // wav | mp3 | ogg
});
```

### Fragment shader uniform contract

Every fragment shader gets a builtin uniform struct at `@group(0) @binding(0)`:

```wgsl
struct BuiltinUniforms {
  resolution: vec2f,
  time: f32,
};
@group(0) @binding(0) var<uniform> builtin: BuiltinUniforms;
```

This is injected automatically — don't declare it yourself. The default
vertex stage supplies a full-screen triangle with `uv: vec2f` at
`@location(0)`; pass `vertexWgsl` to override it.

### Compute shader (audio) binding contract

See the JSDoc header in `src/core/compute-audio-renderer.js` for the full
contract. In short: your WGSL owns `cs_main` and the synthesis math; the
library owns the uniform buffer (`sampleRate`, `totalSamples`) and the
output storage buffer. Only mono (`channels: 1`) is supported end-to-end.

## Why not everything on the original asset list

The original request listed PNG/JPEG/GIF/WebP/AVIF/SVG/ICO, MP3/WAV/OGG,
MP4/WebM/OGV, CSS/JS/JSON/XML/PDF/text, and WOFF/WOFF2/TTF/OTF/EOT as
conversion targets from WebGPU/WGSL. Most of that list isn't a coherent
source→target relationship:

- **SVG**: WGSL is an imperative program, not vector path data. There's
  no general way to "vectorize" arbitrary shader output. Excluded.
- **Fonts (WOFF/WOFF2/TTF/OTF/EOT)**: These encode glyph outlines. Nothing
  about a shader program is glyph data. Excluded — there's no operation
  to implement here, not a missing feature.
- **CSS/JS/JSON/XML/PDF/text**: A shader doesn't "contain" any of these.
  The closest real thing is exporting a JSON *manifest* describing render
  parameters, or a CSS snippet embedding an exported image as a
  background — those are documentation/tooling features, not conversions,
  and weren't built here since they weren't confirmed as the actual ask.

Implementing stubs for these would produce something that looks complete
but silently does the wrong thing (or nothing) the first time someone
calls it. Better to leave them out and say why.

## Verification status — read this before trusting the untested paths

This library was built in a sandboxed environment with **no network
egress** (confirmed via a blocked `npm install` — the registry returned
`403 host_not_allowed`). That materially limits what could actually be
verified before delivery:

**Actually executed and passing** (`test/audio-encoder.test.js`, 7/7):
- `encodeWav()` — RIFF/WAVE header correctness, PCM sample byte layout,
  clamping behavior, 16-bit and 32-bit float modes, all verified against
  real byte-level output, not just read as correct.
- `src/index.js` loads and exports the expected functions with **neither
  sharp nor ffmpeg installed**, confirming the dynamic-import fix (see
  below) actually works, not just that it looks right on paper.
- `exportAudio({ format: 'wav' })` was run against the full call path and
  confirmed it reaches GPU device acquisition — the one dependency this
  sandbox cannot provide — without ever touching sharp or ffmpeg.

**Written but NOT executed** (blocked by missing network access):
- `encodeImage()` / `encodeIco()` (`src/image/encode-image.js`) — sharp's
  raw-pixel API usage, the ICO binary packer's byte layout, and the
  JPEG-alpha-flattening logic are all unverified by execution. Syntax-
  checked only.
- `encodeVideo()` / `encodeAnimatedGif()` (`src/video/encode-video.js`) —
  the ffmpeg rawvideo-demuxer argument list and the two-pass palette
  filter for GIF are unverified by execution.
- `encodeCompressedAudio()` (mp3/ogg path) — same, ffmpeg args unverified.
- **Anything touching actual WebGPU** (`FragmentRenderer`,
  `ComputeAudioRenderer`, `gpu-backend.js`) — there is no GPU adapter
  available in the build sandbox at all, headless or otherwise. The
  entire rendering pipeline — shader compilation, uniform buffer layout,
  the 256-byte row-padding logic in `FragmentRenderer`, the compute
  dispatch/readback in `ComputeAudioRenderer` — rests on my knowledge of
  the WebGPU spec and API shape, not on anything that ran in this
  session. This is the highest-risk, least-verified part of the library.

**What this means practically**: run `npm install && npm test` yourself
before depending on this in anything real, and treat the image/video/GPU
code paths as a first draft that needs to survive contact with an actual
adapter and an actual sharp/ffmpeg install — not as pre-verified.
One specific thing worth checking first if `FragmentRenderer` fails: the
256-byte-row-alignment unpadding loop in `renderFrame()` is exactly the
kind of off-by-one-prone code that most needs a real GPU readback to
confirm, and I could not get that far here.

## Architecture notes

- **`src/core/gpu-backend.js`** isolates the headless-WebGPU dependency
  (the `webgpu` npm package, wrapping Dawn) behind one function,
  `getGpuDevice()`. This is flagged in-code as the least portable part of
  the stack — expect to need a version pin or a different binding package
  depending on your platform and Node version.
- **`src/index.js`** dynamic-imports `encode-image.js` and
  `encode-video.js` inside each `export*` function rather than at module
  top level. This was a real bug I found and fixed during review, not a
  design decision from the start: a static top-level import would mean
  installing this package requires sharp AND ffmpeg even if you only ever
  call `exportAudio({ format: 'wav' })`. The tradeoff: advanced consumers
  who want direct access to `encodeImage` etc. must import from the
  submodule path (`webgpu-asset-exporter/src/image/encode-image.js`)
  rather than the package root — see the comment block at the bottom of
  `src/index.js`.
- **`encode-audio.js`** applies the same fix internally: `encodeWav` has
  zero dependencies, `encodeCompressedAudio` dynamic-imports ffmpeg only
  when called.
- Animated GIF lives in the **video** module, not the image module —
  it's a frame-sequence + timing format, the same shape of problem as
  MP4/WebM, not a single-frame image with a different extension.
