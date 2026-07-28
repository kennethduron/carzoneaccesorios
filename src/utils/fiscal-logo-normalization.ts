import sharp from "sharp";

export type FiscalLogoNormalizationErrorCode =
  | "invalid_format"
  | "too_many_pixels"
  | "empty_image"
  | "unsafe_crop";

export class FiscalLogoNormalizationError extends Error {
  readonly code: FiscalLogoNormalizationErrorCode;

  constructor(code: FiscalLogoNormalizationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "FiscalLogoNormalizationError";
  }
}

export type FiscalLogoBoundingBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type FiscalLogoNormalizationResult = {
  buffer: Buffer;
  originalWidth: number;
  originalHeight: number;
  boundingBox: FiscalLogoBoundingBox;
  padding: number;
  croppedWidth: number;
  croppedHeight: number;
  finalWidth: number;
  finalHeight: number;
  hadAlpha: boolean;
  backgroundDetection: "alpha" | "edge_connected_near_white";
};

type NormalizeFiscalLogoOptions = {
  maxInputPixels: number;
  maxOutputWidth: number;
};

const supportedFormats = new Set(["jpeg", "jpg", "png", "webp"]);
const transparentAlphaThreshold = 8;
const nearWhiteChannelThreshold = 245;
const nearWhiteMaximumChannelSpread = 12;
const paddingRatio = 0.03;
const minimumContentDimension = 8;
const minimumContentBoxAreaRatio = 0.005;
const minimumAspectRatio = 0.1;
const maximumAspectRatio = 20;

function isNearWhite(red: number, green: number, blue: number) {
  const minimum = Math.min(red, green, blue);
  const maximum = Math.max(red, green, blue);
  return minimum >= nearWhiteChannelThreshold && maximum - minimum <= nearWhiteMaximumChannelSpread;
}

function hasTransparentBorderPixel(data: Buffer, width: number, height: number) {
  const isTransparent = (x: number, y: number) => data[(y * width + x) * 4 + 3] <= transparentAlphaThreshold;

  for (let x = 0; x < width; x += 1) {
    if (isTransparent(x, 0) || isTransparent(x, height - 1)) return true;
  }
  for (let y = 0; y < height; y += 1) {
    if (isTransparent(0, y) || isTransparent(width - 1, y)) return true;
  }
  return false;
}

function alphaBoundingBox(data: Buffer, width: number, height: number): { box: FiscalLogoBoundingBox | null; count: number } {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= transparentAlphaThreshold) continue;

      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      count += 1;
    }
  }

  if (right < left || bottom < top) return { box: null, count: 0 };
  return {
    box: { left, top, width: right - left + 1, height: bottom - top + 1 },
    count,
  };
}

function opaqueBoundingBox(data: Buffer, width: number, height: number): { box: FiscalLogoBoundingBox | null; count: number } {
  const pixels = width * height;
  const outsideBackground = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  let queueStart = 0;
  let queueEnd = 0;

  const isBackground = (pixelIndex: number) => {
    const offset = pixelIndex * 4;
    return isNearWhite(data[offset], data[offset + 1], data[offset + 2]);
  };

  const enqueue = (pixelIndex: number) => {
    if (outsideBackground[pixelIndex] || !isBackground(pixelIndex)) return;
    outsideBackground[pixelIndex] = 1;
    queue[queueEnd] = pixelIndex;
    queueEnd += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (queueStart < queueEnd) {
    const pixelIndex = queue[queueStart];
    queueStart += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);

    if (x > 0) enqueue(pixelIndex - 1);
    if (x + 1 < width) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - width);
    if (y + 1 < height) enqueue(pixelIndex + width);
  }

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let count = 0;

  for (let pixelIndex = 0; pixelIndex < pixels; pixelIndex += 1) {
    if (outsideBackground[pixelIndex]) continue;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
    count += 1;
  }

  if (right < left || bottom < top) return { box: null, count: 0 };
  return {
    box: { left, top, width: right - left + 1, height: bottom - top + 1 },
    count,
  };
}

function validateBoundingBox(box: FiscalLogoBoundingBox | null, foregroundPixels: number, sourcePixels: number) {
  if (!box || foregroundPixels === 0) {
    throw new FiscalLogoNormalizationError("empty_image", "El logo no contiene contenido visible.");
  }

  const aspectRatio = box.width / box.height;
  const contentBoxAreaRatio = (box.width * box.height) / sourcePixels;
  if (
    box.width < minimumContentDimension ||
    box.height < minimumContentDimension ||
    contentBoxAreaRatio < minimumContentBoxAreaRatio ||
    aspectRatio < minimumAspectRatio ||
    aspectRatio > maximumAspectRatio
  ) {
    throw new FiscalLogoNormalizationError(
      "unsafe_crop",
      "No se pudo recortar el logo de forma segura. Usa una imagen con el logotipo claramente visible.",
    );
  }
}

export async function normalizeFiscalLogo(
  input: Buffer,
  options: NormalizeFiscalLogoOptions,
): Promise<FiscalLogoNormalizationResult> {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input, {
      animated: false,
      limitInputPixels: options.maxInputPixels + 1,
    }).metadata();
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("pixel")) {
      throw new FiscalLogoNormalizationError("too_many_pixels", "El logo supera el limite de pixeles permitido.");
    }
    throw new FiscalLogoNormalizationError("invalid_format", "No se pudo leer el archivo de imagen.");
  }

  const format = metadata.format?.toLowerCase();
  const originalWidth = metadata.width ?? 0;
  const originalHeight = metadata.height ?? 0;
  if (!format || !supportedFormats.has(format) || !originalWidth || !originalHeight) {
    throw new FiscalLogoNormalizationError("invalid_format", "No se pudo leer el archivo de imagen.");
  }
  if (originalWidth * originalHeight > options.maxInputPixels) {
    throw new FiscalLogoNormalizationError("too_many_pixels", "El logo supera el limite de pixeles permitido.");
  }

  let rawData: Buffer;
  let rawInfo: { width: number; height: number };
  try {
    const rawResult = await sharp(input, {
      animated: false,
      limitInputPixels: options.maxInputPixels + 1,
    })
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    rawData = rawResult.data;
    rawInfo = rawResult.info;
  } catch {
    throw new FiscalLogoNormalizationError("invalid_format", "No se pudo leer el archivo de imagen.");
  }

  const hadAlpha = Boolean(metadata.hasAlpha);
  const usesAlphaBackground = hadAlpha && hasTransparentBorderPixel(rawData, rawInfo.width, rawInfo.height);
  const detected = usesAlphaBackground
    ? alphaBoundingBox(rawData, rawInfo.width, rawInfo.height)
    : opaqueBoundingBox(rawData, rawInfo.width, rawInfo.height);
  validateBoundingBox(detected.box, detected.count, rawInfo.width * rawInfo.height);
  const boundingBox = detected.box!;
  const padding = Math.max(2, Math.min(24, Math.ceil(boundingBox.width * paddingRatio)));
  const croppedWidth = boundingBox.width + padding * 2;
  const croppedHeight = boundingBox.height + padding * 2;

  let buffer: Buffer;
  try {
    buffer = await sharp(input, {
      animated: false,
      limitInputPixels: options.maxInputPixels + 1,
    })
      .rotate()
      .extract(boundingBox)
      .extend({
        top: padding,
        bottom: padding,
        left: padding,
        right: padding,
        background: usesAlphaBackground
          ? { r: 255, g: 255, b: 255, alpha: 0 }
          : { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .resize({
        width: options.maxOutputWidth,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 90, effort: 5, alphaQuality: 100 })
      .toBuffer();
  } catch {
    throw new FiscalLogoNormalizationError("unsafe_crop", "No se pudo normalizar el logo de forma segura.");
  }

  const finalMetadata = await sharp(buffer).metadata();
  const finalWidth = finalMetadata.width ?? 0;
  const finalHeight = finalMetadata.height ?? 0;
  if (!finalWidth || !finalHeight) {
    throw new FiscalLogoNormalizationError("unsafe_crop", "El resultado del logo no es valido.");
  }

  return {
    buffer,
    originalWidth,
    originalHeight,
    boundingBox,
    padding,
    croppedWidth,
    croppedHeight,
    finalWidth,
    finalHeight,
    hadAlpha,
    backgroundDetection: usesAlphaBackground ? "alpha" : "edge_connected_near_white",
  };
}
