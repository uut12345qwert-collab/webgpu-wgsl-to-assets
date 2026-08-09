/**
 * encode-image.js
 *
 * Encodes a raw RGBA8 pixel buffer (as produced by FragmentRenderer)
 * into standard still-image formats via `sharp` (libvips).
 *
 * GIF here means single-frame GIF. Animated GIF is a video-sequence
 * concern and lives in the video module (see video/encode-video.js),
 * since it needs multiple frames + timing, not a single-frame encoder.
 *
 * ICO is a multi-resolution container: we resize the source frame to
 * each requested size and pack them together, since Windows favicons
 * are conventionally multi-size (16/32/48px etc.), not a single-size
 * image with an .ico extension slapped on.
 *
 * `sharp` is dynamically imported so that consumers who only need
 * audio (WAV) or pure rendering do not require sharp to be installed.
 */

const SUPPORTED_STILL_FORMATS = new Set(['png', 'jpeg', 'jpg', 'webp', 'avif', 'gif']);

async function loadSharp() {
  try {
    const mod = await import('sharp');
    return mod.default;
  } catch (err) {
    throw new Error(
      'sharp is required for image encoding but failed to load. ' +
      'Install it with: npm install sharp\nOriginal error: ' + err.message
    );
  }
}

/**
 * @param {Buffer} rgbaBuffer - raw RGBA8, width*height*4 bytes
 * @param {number} width
 * @param {number} height
 * @param {'png'|'jpeg'|'jpg'|'webp'|'avif'|'gif'} format
 * @param {object} [options] - passed through to sharp's format-specific encoder
 *   (e.g. { quality: 80 } for jpeg/webp/avif)
 * @returns {Promise<Buffer>} encoded file bytes
 */
export async function encodeImage(rgbaBuffer, width, height, format, options = {}) {
  const normalizedFormat = format.toLowerCase();
  if (!SUPPORTED_STILL_FORMATS.has(normalizedFormat)) {
    throw new Error(
      `Unsupported still-image format "${format}". Supported: ${[...SUPPORTED_STILL_FORMATS].join(', ')}`
    );
  }
  if (!Buffer.isBuffer(rgbaBuffer)) {
    throw new TypeError('rgbaBuffer must be a Buffer');
  }
  const expectedLength = width * height * 4;
  if (rgbaBuffer.length !== expectedLength) {
    throw new Error(
      `rgbaBuffer length ${rgbaBuffer.length} does not match width*height*4 ` +
      `(${expectedLength}) for ${width}x${height}. This usually means a ` +
      'stride/padding mismatch upstream.'
    );
  }

  const sharp = await loadSharp();
  const image = sharp(rgbaBuffer, { raw: { width, height, channels: 4 } });

  switch (normalizedFormat) {
    case 'png':
      return image.png(options).toBuffer();
    case 'jpeg':
    case 'jpg':
      // JPEG has no alpha channel; flatten onto a background color first
      // (default white) so transparent pixels don't produce undefined results.
      return image
        .flatten({ background: options.background ?? { r: 255, g: 255, b: 255 } })
        .jpeg({ quality: options.quality ?? 90, ...options })
        .toBuffer();
    case 'webp':
      return image.webp({ quality: options.quality ?? 90, ...options }).toBuffer();
    case 'avif':
      return image.avif({ quality: options.quality ?? 60, ...options }).toBuffer();
    case 'gif':
      return image.gif(options).toBuffer();
    default:
      // Unreachable given the Set check above; kept for exhaustiveness.
      throw new Error(`Unhandled format ${normalizedFormat}`);
  }
}

/**
 * Packs one source frame into a multi-resolution .ico favicon.
 * @param {Buffer} rgbaBuffer
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number[]} [sizes=[16,32,48,64]]
 * @returns {Promise<Buffer>}
 */
export async function encodeIco(rgbaBuffer, sourceWidth, sourceHeight, sizes = [16, 32, 48, 64]) {
  if (sourceWidth !== sourceHeight) {
    // Not a hard technical requirement of ICO, but square source avoids
    // silent distortion when resizing to square favicon sizes, and is
    // what every consumer of a favicon actually expects.
    console.warn(
      `[webgpu-asset-exporter] encodeIco: source is ${sourceWidth}x${sourceHeight} ` +
      '(non-square). Favicon sizes are square, so output will be stretched. ' +
      'Consider rendering a square source frame instead.'
    );
  }

  const sharp = await loadSharp();
  const pngBuffers = await Promise.all(
    sizes.map((size) =>
      sharp(rgbaBuffer, { raw: { width: sourceWidth, height: sourceHeight, channels: 4 } })
        .resize(size, size, { fit: 'cover' })
        .png()
        .toBuffer()
    )
  );

  return packIco(pngBuffers, sizes);
}

/**
 * Minimal ICO container packer (PNG-compressed entries, which is valid
 * per the ICO spec and what modern browsers/OSes expect). Implemented
 * directly rather than pulling in a dependency, since the format itself
 * is a small, stable, well-documented binary layout.
 * @param {Buffer[]} pngBuffers
 * @param {number[]} sizes
 * @returns {Buffer}
 */
function packIco(pngBuffers, sizes) {
  const numImages = pngBuffers.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * numImages;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(numImages, 4);

  const dirEntries = [];
  let offset = headerSize + dirSize;

  for (let i = 0; i < numImages; i++) {
    const size = sizes[i];
    const pngBuffer = pngBuffers[i];
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 = 256)
    entry.writeUInt8(0, 2); // color palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(pngBuffer.length, 8); // size of image data
    entry.writeUInt32LE(offset, 12); // offset of image data
    dirEntries.push(entry);
    offset += pngBuffer.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers]);
}
