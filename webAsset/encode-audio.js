/**
 * encode-audio.js
 *
 * Encodes Float32 PCM samples (as produced by ComputeAudioRenderer,
 * range [-1, 1], mono) into WAV, MP3, or OGG.
 *
 * WAV is encoded directly (no external dependency) since it's a
 * trivial, fully-specified container — reaching for ffmpeg for WAV
 * would be adding a subprocess dependency for something ~30 lines of
 * buffer math handles correctly and deterministically.
 *
 * MP3 and OGG go through the same ffmpeg binary used for video, since
 * both are genuinely compressed formats with real encoder complexity
 * (psychoacoustic modeling, etc.) that shouldn't be reimplemented here.
 */

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ffmpeg-installer/ffmpeg and node:child_process are dynamically imported
// inside encodeCompressedAudio() rather than at module top-level. WAV
// encoding is pure buffer math with zero external dependencies; a caller
// who only wants encodeWav() should not be forced to have ffmpeg
// installed just because it lives in the same file. Static top-level
// imports would have made that coupling unavoidable.

/**
 * @param {Float32Array} samples - PCM samples in [-1, 1]
 * @param {number} sampleRate
 * @param {number} [bitDepth=16] - 16 or 32
 * @returns {Buffer} complete .wav file
 */
export function encodeWav(samples, sampleRate, bitDepth = 16) {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError('samples must be a Float32Array');
  }
  if (bitDepth !== 16 && bitDepth !== 32) {
    throw new Error(`Unsupported bitDepth ${bitDepth}; use 16 or 32`);
  }

  const numChannels = 1;
  const bytesPerSample = bitDepth / 8;
  const dataSize = samples.length * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');

  // fmt chunk
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(bitDepth === 32 ? 3 : 1, 20); // audio format: 1=PCM int, 3=IEEE float
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);

  // data chunk
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  if (bitDepth === 16) {
    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      const intSample = Math.round(clamped * 32767);
      buffer.writeInt16LE(intSample, offset);
      offset += 2;
    }
  } else {
    for (let i = 0; i < samples.length; i++) {
      buffer.writeFloatLE(samples[i], offset);
      offset += 4;
    }
  }

  return buffer;
}

/**
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {'mp3'|'ogg'} format
 * @param {object} [options]
 * @param {number} [options.bitrateKbps] - e.g. 192 for mp3
 * @returns {Promise<Buffer>}
 */
export async function encodeCompressedAudio(samples, sampleRate, format, options = {}) {
  const normalizedFormat = format.toLowerCase();
  if (normalizedFormat !== 'mp3' && normalizedFormat !== 'ogg') {
    throw new Error(`Unsupported compressed audio format "${format}". Supported: mp3, ogg`);
  }

  const { spawn } = await import('node:child_process');
  let ffmpegPath;
  try {
    ({ default: ffmpegPath } = await import('@ffmpeg-installer/ffmpeg'));
  } catch (err) {
    throw new Error(
      '@ffmpeg-installer/ffmpeg is required for mp3/ogg encoding but failed ' +
      `to load (${err.message}). If you only need WAV output, use encodeWav() ` +
      'directly — it has no external dependencies.'
    );
  }

  // Feed ffmpeg the WAV we already know how to build correctly, rather
  // than piping raw PCM with format flags — one less place to get the
  // byte layout wrong.
  const wavBuffer = encodeWav(samples, sampleRate, 16);

  const workDir = await mkdtemp(join(tmpdir(), 'webgpu-asset-exporter-audio-'));
  const inputPath = join(workDir, 'input.wav');
  const outputPath = join(workDir, `output.${normalizedFormat}`);

  try {
    await writeFile(inputPath, wavBuffer);

    const codecArgs = normalizedFormat === 'mp3'
      ? ['-c:a', 'libmp3lame', '-b:a', `${options.bitrateKbps ?? 192}k`]
      : ['-c:a', 'libvorbis', '-q:a', String(options.vorbisQuality ?? 5)];

    const args = ['-y', '-i', inputPath, ...codecArgs, outputPath];
    await runFfmpeg(spawn, ffmpegPath.path, args);
    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(spawn, ffmpegBinaryPath, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBinaryPath, args);
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg binary: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}. stderr:\n${stderr.slice(-2000)}`));
    });
  });
}
