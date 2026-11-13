/**
 * Dependency-free image dimension reader.
 *
 * pi-gui used Electron's `nativeImage` purely to (a) reject unreadable images and
 * (b) enforce the composer pixel cap. Neither needs a decoder, so this parses the
 * container headers directly — which also removes an Electron import from the
 * host core and keeps the sidecar bundle free of native image codecs.
 */
export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function pngSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 24) {
    return undefined;
  }
  for (let index = 0; index < pngSignature.length; index += 1) {
    if (bytes[index] !== pngSignature[index]) {
      return undefined;
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function gifSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 10) {
    return undefined;
  }
  const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
  if (!isGif) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function bmpSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 26) {
    return undefined;
  }
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
}

function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (length < 2) {
      return undefined;
    }
    // SOF0..SOF15 except DHT(C4), JPG(C8) and DAC(CC) carry the frame dimensions.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
      return { width, height };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 30) {
    return undefined;
  }
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP") {
    return undefined;
  }
  const chunk = ascii(12, 16);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (chunk === "VP8X") {
    const width = 1 + (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16));
    const height = 1 + (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16));
    return { width, height };
  }
  if (chunk === "VP8L") {
    const bits =
      view.getUint8(21) | (view.getUint8(22) << 8) | (view.getUint8(23) << 16) | (view.getUint8(24) << 24);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === "VP8 ") {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  return undefined;
}

/** Returns the encoded pixel size, or undefined when the bytes are not a readable image. */
export function readImageSize(data: Uint8Array): ImageSize | undefined {
  const size = pngSize(data) ?? gifSize(data) ?? bmpSize(data) ?? jpegSize(data) ?? webpSize(data);
  if (!size || size.width <= 0 || size.height <= 0) {
    return undefined;
  }
  return size;
}

export function readImageSizeFromBase64(base64: string): ImageSize | undefined {
  try {
    return readImageSize(Buffer.from(base64, "base64"));
  } catch {
    return undefined;
  }
}
