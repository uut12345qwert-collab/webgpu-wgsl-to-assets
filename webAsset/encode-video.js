/**
 * encode-video.js
 *
 * Encodes a sequence of raw RGBA8 frames (as produced by
 * FragmentRenderer.renderSequence) into MP4, WebM, or OGV.
 *
 * Uses a real ffmpeg binary (via @ffmpeg-installer/ffmpeg, which bundles
 * a platform-appropriate static build) rather than a WASM ffmpeg, because
 * Node has direct filesystem/process access and a native binary is
 * faster and more reliable here than a WASM build meant for browsers.
 * This is a deliberate difference from what you might reach for in a
 * browser context — flagging it since "ffmpeg" is sometimes assumed to
 * mean the WASM build specifically.
 *
 * Animated GIF is implemented here (not in the image module) because an
 * animated GIF is a frame-sequence + timing format, the same shape of
 * problem as MP4/WebM, not a single-frame image.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';

const CONTAINER_CONFIG = {
  mp4: { vcodec: 'libx264', extraArgs: ['-pix_fmt', 'yuv420p', '-movflags', '+faststart'] },
  webm: { vcodec: 'libvpx-vp9', extraArgs: ['-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', '30'] },
  ogv: { vcodec: 'libtheora', extraArgs: [] },
};

/**
 * @param {Buffer[]} rgbaFrames - raw RGBA8 buffers, each width*height*4 bytes
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @param {'mp4'|'webm'|'ogv'} format
 * @param {object} [options]
 * @param {number} [options.crf] - override default quality (lower = better for h264/theora)
 * @returns {Promise<Buffer>} encoded file bytes
 */
export async function encodeVideo(rgbaFrames, width, height, fps, format, options = {}) {
  const normalizedFormat = format.toLowerCase();
  const config = CONTAINER_CONFIG[normalizedFormat];
  if (!config) {
    throw new Error(`Unsupported video format "${format}". Supported: ${Object.keys(CONTAINER_CONFIG).join(', ')}`);
  }
  if (!Array.isArray(rgbaFrames) || rgbaFrames.length === 0) {
    throw new Error('rgbaFrames must be a non-empty array of Buffers');
  }
  const expectedFrameLength = width * height * 4;
  for (let i = 0; i < rgbaFrames.length; i++) {
    if (rgbaFrames[i].length !== expectedFrameLength) {
      throw new Error(
        `Frame ${i} has length ${rgbaFrames[i].length}, expected ${expectedFrameLength} ` +
        `for ${width}x${height}. All frames must be the same, correctly-sized RGBA8 buffer.`
      );
    }
  }

  const workDir = await mkdtemp(join(tmpdir(), 'webgpu-asset-exporter-'));
  const rawFramesPath = join(workDir, 'frames.rgba');
  const outputPath = join(workDir, `output.${normalizedFormat}`);

  try {
    // Concatenate all frames into a single raw stream file — ffmpeg's
    // rawvideo demuxer reads this as a flat sequence given -s/-pix_fmt/-r.
    await writeFile(rawFramesPath, Buffer.concat(rgbaFrames));

    const args = [
      '-y',
      '-f', 'rawvideo',
      '-pixel_format', 'rgba',
      '-video_size', `${width}x${height}`,
      '-framerate', String(fps),
      '-i', rawFramesPath,
      '-c:v', config.vcodec,
      ...(options.crf !== undefined ? ['-crf', String(options.crf)] : []),
      ...config.extraArgs,
      outputPath,
    ];

    await runFfmpeg(args);
    const { readFile } = await import('node:fs/promises');
    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Encodes an animated GIF from a frame sequence. Palette generation is a
 * two-pass ffmpeg filter (palettegen + paletteuse) rather than a naive
 * single-pass encode, since naive GIF encoding produces visibly banded/
 * dithered output that misrepresents what the shader actually rendered.
 * @param {Buffer[]} rgbaFrames
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @returns {Promise<Buffer>}
 */
export async function encodeAnimatedGif(rgbaFrames, width, height, fps) {
  if (!Array.isArray(rgbaFrames) || rgbaFrames.length === 0) {
    throw new Error('rgbaFrames must be a non-empty array of Buffers');
  }
  const expectedFrameLength = width * height * 4;
  for (let i = 0; i < rgbaFrames.length; i++) {
    if (rgbaFrames[i].length !== expectedFrameLength) {
      throw new Error(`Frame ${i} has unexpected length for ${width}x${height} RGBA8`);
    }
  }

  const workDir = await mkdtemp(join(tmpdir(), 'webgpu-asset-exporter-gif-'));
  const rawFramesPath = join(workDir, 'frames.rgba');
  const outputPath = join(workDir, 'output.gif');

  try {
    await writeFile(rawFramesPath, Buffer.concat(rgbaFrames));

    const filterComplex =
      '[0:v] split [a][b];' +
      '[a] palettegen [p];' +
      '[b][p] paletteuse';

    const args = [
      '-y',
      '-f', 'rawvideo',
      '-pixel_format', 'rgba',
      '-video_size', `${width}x${height}`,
      '-framerate', String(fps),
      '-i', rawFramesPath,
      '-filter_complex', filterComplex,
      outputPath,
    ];

    await runFfmpeg(args);
    const { readFile } = await import('node:fs/promises');
    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath.path, args);
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      reject(new Error(
        `Failed to spawn ffmpeg binary at ${ffmpegPath.path}: ${err.message}. ` +
        'Verify @ffmpeg-installer/ffmpeg installed correctly for your platform.'
      ));
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}. stderr:\n${stderr.slice(-2000)}`));
      }
    });
  });
}
