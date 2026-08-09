/**
 * webgpu-asset-exporter
 *
 * Scope (deliberately, not by omission — see README for what this
 * library does NOT attempt, e.g. fonts/CSS/documents from WGSL):
 *   1. WGSL fragment shader -> still image (PNG/JPEG/WebP/AVIF/GIF/ICO)
 *   2. WGSL fragment shader -> video (MP4/WebM/OGV) or animated GIF
 *   5. WGSL compute shader  -> audio (WAV/MP3/OGG)
 */

import { FragmentRenderer } from './core/fragment-renderer.js';
import { ComputeAudioRenderer } from './core/compute-audio-renderer.js';
// encode-image.js (sharp) and encode-video.js (@ffmpeg-installer/ffmpeg)
// are intentionally NOT imported at top level here. If they were, every
// consumer of this package — even one who only calls exportAudio() with
// format:'wav', which has zero external dependencies — would fail to
// even load the package unless sharp AND ffmpeg were both installed.
// Each export* function below dynamic-imports only the encoder it
// actually needs, at call time.

const STILL_IMAGE_FORMATS = new Set(['png', 'jpeg', 'jpg', 'webp', 'avif', 'gif']);
const VIDEO_FORMATS = new Set(['mp4', 'webm', 'ogv']);

/**
 * Renders a WGSL fragment shader to a still image.
 *
 * @param {object} opts
 * @param {string} opts.wgsl - fragment shader source (fs_main entry point)
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {'png'|'jpeg'|'jpg'|'webp'|'avif'|'gif'} opts.format
 * @param {number} [opts.time=0] - time uniform (seconds) passed to the shader
 * @param {string} [opts.vertexWgsl] - optional custom vertex stage
 * @param {object} [opts.encodeOptions] - passed to the underlying sharp encoder
 * @returns {Promise<Buffer>}
 */
export async function exportImage({ wgsl, width, height, format, time = 0, vertexWgsl, encodeOptions = {} }) {
  if (!STILL_IMAGE_FORMATS.has(format?.toLowerCase())) {
    throw new Error(
      `exportImage: unsupported format "${format}". Supported: ${[...STILL_IMAGE_FORMATS].join(', ')}. ` +
      'For animated GIF, use exportVideo with format "gif" instead — a single ' +
      'frame and an animation are different problems.'
    );
  }

  const { encodeImage } = await import('./image/encode-image.js');
  const renderer = new FragmentRenderer({ fragmentWgsl: wgsl, vertexWgsl, width, height });
  try {
    const rgba = await renderer.renderFrame(time);
    return await encodeImage(rgba, width, height, format, encodeOptions);
  } finally {
    renderer.destroy();
  }
}

/**
 * Renders a WGSL fragment shader to a multi-resolution .ico favicon.
 *
 * @param {object} opts
 * @param {string} opts.wgsl
 * @param {number} [opts.sourceSize=256] - render resolution before downscaling
 * @param {number} [opts.time=0]
 * @param {number[]} [opts.sizes=[16,32,48,64]]
 * @param {string} [opts.vertexWgsl]
 * @returns {Promise<Buffer>}
 */
export async function exportFavicon({ wgsl, sourceSize = 256, time = 0, sizes = [16, 32, 48, 64], vertexWgsl }) {
  const { encodeIco } = await import('./image/encode-image.js');
  const renderer = new FragmentRenderer({ fragmentWgsl: wgsl, vertexWgsl, width: sourceSize, height: sourceSize });
  try {
    const rgba = await renderer.renderFrame(time);
    return await encodeIco(rgba, sourceSize, sourceSize, sizes);
  } finally {
    renderer.destroy();
  }
}

/**
 * Renders a WGSL fragment shader across time to a video or animated GIF.
 *
 * @param {object} opts
 * @param {string} opts.wgsl
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {'mp4'|'webm'|'ogv'|'gif'} opts.format
 * @param {number} opts.durationSeconds
 * @param {number} [opts.fps=30]
 * @param {string} [opts.vertexWgsl]
 * @param {(rendered: number, total: number) => void} [opts.onProgress]
 * @param {object} [opts.encodeOptions] - passed to the ffmpeg encoder (e.g. { crf })
 * @returns {Promise<Buffer>}
 */
export async function exportVideo({
  wgsl, width, height, format, durationSeconds, fps = 30,
  vertexWgsl, onProgress, encodeOptions = {},
}) {
  const normalizedFormat = format?.toLowerCase();
  const isGif = normalizedFormat === 'gif';
  if (!isGif && !VIDEO_FORMATS.has(normalizedFormat)) {
    throw new Error(
      `exportVideo: unsupported format "${format}". Supported: ` +
      `${[...VIDEO_FORMATS, 'gif'].join(', ')}`
    );
  }

  const { encodeVideo, encodeAnimatedGif } = await import('./video/encode-video.js');
  const renderer = new FragmentRenderer({ fragmentWgsl: wgsl, vertexWgsl, width, height });
  try {
    const frames = await renderer.renderSequence({ durationSeconds, fps, onProgress });
    if (isGif) {
      return await encodeAnimatedGif(frames, width, height, fps);
    }
    return await encodeVideo(frames, width, height, fps, normalizedFormat, encodeOptions);
  } finally {
    renderer.destroy();
  }
}

/**
 * Synthesizes audio from a WGSL compute shader (see
 * core/compute-audio-renderer.js for the required WGSL binding contract)
 * and encodes it to WAV, MP3, or OGG.
 *
 * @param {object} opts
 * @param {string} opts.wgsl - compute shader source (cs_main entry point)
 * @param {number} opts.durationSeconds
 * @param {'wav'|'mp3'|'ogg'} opts.format
 * @param {number} [opts.sampleRate=44100]
 * @param {object} [opts.encodeOptions] - e.g. { bitrateKbps: 192 } for mp3
 * @returns {Promise<Buffer>}
 */
export async function exportAudio({ wgsl, durationSeconds, format, sampleRate = 44100, encodeOptions = {} }) {
  const normalizedFormat = format?.toLowerCase();
  if (!['wav', 'mp3', 'ogg'].includes(normalizedFormat)) {
    throw new Error(`exportAudio: unsupported format "${format}". Supported: wav, mp3, ogg`);
  }

  const renderer = new ComputeAudioRenderer({ computeWgsl: wgsl, sampleRate });
  const samples = await renderer.render(durationSeconds);

  // encodeWav has zero external dependencies; encodeCompressedAudio needs
  // ffmpeg. Both come from the same file, but encode-audio.js itself
  // defers its ffmpeg import to inside encodeCompressedAudio() (see that
  // file), so importing it here is safe even for WAV-only callers.
  const { encodeWav, encodeCompressedAudio } = await import('./audio/encode-audio.js');

  if (normalizedFormat === 'wav') {
    return encodeWav(samples, sampleRate, encodeOptions.bitDepth ?? 16);
  }
  return encodeCompressedAudio(samples, sampleRate, normalizedFormat, encodeOptions);
}

// Lower-level exports for callers who want to render once and encode to
// multiple formats without re-running the shader (e.g. PNG + WebP + AVIF
// from one render, or MP4 + WebM from one frame sequence).
//
// FragmentRenderer and ComputeAudioRenderer are safe as static re-exports
// — they only touch the GPU backend, which is itself dynamic-imported
// inside gpu-backend.js (see that file). The encode* functions are
// deliberately NOT re-exported here as static bindings, since doing so
// would reintroduce the eager sharp/ffmpeg load this file exists to
// avoid. Import them directly from their submodules if you need them:
//   import { encodeImage } from 'webgpu-asset-exporter/src/image/encode-image.js'
//   import { encodeVideo } from 'webgpu-asset-exporter/src/video/encode-video.js'
//   import { encodeWav } from 'webgpu-asset-exporter/src/audio/encode-audio.js'
export { FragmentRenderer } from './core/fragment-renderer.js';
export { ComputeAudioRenderer } from './core/compute-audio-renderer.js';
