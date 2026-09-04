const MAX_GENERATED_BYTES = 10 * 1024 * 1024;
const MIN_GENERATED_BYTES = 1_024;
const MAX_GENERATED_PIXELS = 2_048 * 2_048;

export type ImageInfo = {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
};

export class ImageValidationError extends Error {}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function parsePng(bytes: Uint8Array): ImageInfo | undefined {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    mimeType: "image/png",
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
  };
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function parseJpeg(bytes: Uint8Array): ImageInfo | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  let offset = 2;
  while (offset + 8 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker) && segmentLength >= 7) {
      return {
        mimeType: "image/jpeg",
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += segmentLength;
  }
  return undefined;
}

function parseWebp(bytes: Uint8Array): ImageInfo | undefined {
  if (
    bytes.length < 30 ||
    String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" ||
    String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP"
  ) {
    return undefined;
  }

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunk = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const data = offset + 8;
    if (data + size > bytes.length) break;
    if (chunk === "VP8X" && size >= 10) {
      return {
        mimeType: "image/webp",
        width: readUint24LE(bytes, data + 4) + 1,
        height: readUint24LE(bytes, data + 7) + 1,
      };
    }
    if (chunk === "VP8L" && size >= 5 && bytes[data] === 0x2f) {
      const b1 = bytes[data + 1];
      const b2 = bytes[data + 2];
      const b3 = bytes[data + 3];
      const b4 = bytes[data + 4];
      return {
        mimeType: "image/webp",
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      };
    }
    if (
      chunk === "VP8 " &&
      size >= 10 &&
      bytes[data + 3] === 0x9d &&
      bytes[data + 4] === 0x01 &&
      bytes[data + 5] === 0x2a
    ) {
      return {
        mimeType: "image/webp",
        width: (bytes[data + 6] | (bytes[data + 7] << 8)) & 0x3fff,
        height: (bytes[data + 8] | (bytes[data + 9] << 8)) & 0x3fff,
      };
    }
    offset = data + size + (size % 2);
  }
  return undefined;
}

export function inspectImage(bytes: Uint8Array): ImageInfo {
  const info = parsePng(bytes) ?? parseJpeg(bytes) ?? parseWebp(bytes);
  if (!info) throw new ImageValidationError("Unsupported or malformed image data");
  return info;
}

export function validateGeneratedImage(
  bytes: Uint8Array,
  expectedDimensions?: { width: number; height: number },
): ImageInfo {
  if (bytes.byteLength < MIN_GENERATED_BYTES || bytes.byteLength > MAX_GENERATED_BYTES) {
    throw new ImageValidationError("Generated image has an invalid byte size");
  }
  const info = inspectImage(bytes);
  if (
    info.width < 256 ||
    info.height < 256 ||
    info.width > 2_048 ||
    info.height > 2_048 ||
    info.width * info.height > MAX_GENERATED_PIXELS
  ) {
    throw new ImageValidationError("Generated image has invalid dimensions");
  }
  if (
    expectedDimensions &&
    (info.width !== expectedDimensions.width || info.height !== expectedDimensions.height)
  ) {
    throw new ImageValidationError("Generated image dimensions do not match the requested artwork type");
  }
  return info;
}

export function validateReferenceImage(
  bytes: Uint8Array,
  declaredMimeType: string,
): ImageInfo {
  const info = inspectImage(bytes);
  if (info.mimeType !== declaredMimeType) {
    throw new ImageValidationError("Reference image type does not match its contents");
  }
  if (
    info.width < 64 ||
    info.height < 64 ||
    info.width > 4_096 ||
    info.height > 4_096 ||
    info.width * info.height > 8_000_000
  ) {
    throw new ImageValidationError("Reference image has invalid dimensions");
  }
  return info;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
