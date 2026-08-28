import "server-only";

import { configureCloudinary } from "@/lib/cloudinary";
import {
  productImageAngles,
  productImageUploadRequestIdPattern,
  type ProductImageAngle,
  type ProductImageUploadServiceResult,
} from "@/lib/product-image-upload-contract";
import {
  createProductImageSharpImportDiagnostic,
  productImageSharpImportFailureEvent,
} from "@/lib/product-image-sharp-diagnostic";
import {
  formatMegapixels,
  isAllowedProductImageMimeType,
  productImageInvalidFormatMessage,
  productImageMaxBytes,
  productImageMaxDisplayDimension,
  productImageMaxPixels,
  productImageTooLargeMessage,
  productImageTooManyPixelsMessage,
} from "@/utils/product-image-rules";

const cloudinaryUploadTimeoutMs = 20_000;

type SharpMetadata = { width?: number; height?: number };
type SharpPipeline = {
  rotate(): SharpPipeline;
  metadata(): Promise<SharpMetadata>;
  resize(options: {
    width: number;
    height: number;
    fit: "inside";
    withoutEnlargement: boolean;
  }): SharpPipeline;
  webp(options: { quality: number; effort: number }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
};
type SharpFactory = (
  input: Buffer,
  options?: { animated: boolean; limitInputPixels?: number },
) => SharpPipeline;

type CloudinaryUploadResult = { secure_url?: string; public_id?: string };
type CloudinaryClient = {
  uploader: {
    upload_stream(
      options: Record<string, unknown>,
      callback: (error: unknown, result?: CloudinaryUploadResult) => void,
    ): { end(buffer: Buffer): void };
  };
};

export type ProductImageUploadServiceInput = {
  file: File;
  productSlug: string;
  angle: ProductImageAngle;
  requestId: string;
};

export type ProductImageUploadServiceDependencies = {
  loadSharp?: () => Promise<SharpFactory>;
  getCloudinary?: () => CloudinaryClient;
  cloudinaryTimeoutMs?: number;
};

function normalizeProductPathSegment(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "producto";
}

export function productImageRemoteIdentity(input: Pick<ProductImageUploadServiceInput, "productSlug" | "angle" | "requestId">) {
  const folder = `car-zone/productos/${normalizeProductPathSegment(input.productSlug)}`;
  const leafPublicId = `${input.angle}-${input.requestId}`;
  return {
    folder,
    leafPublicId,
    fullPublicId: `${folder}/${leafPublicId}`,
  };
}

async function loadSharpDynamically(): Promise<SharpFactory> {
  const sharpModule = await import("sharp");
  return sharpModule.default as unknown as SharpFactory;
}

function defaultCloudinaryClient() {
  return configureCloudinary() as unknown as CloudinaryClient;
}

function uploadToCloudinary(
  cloudinary: CloudinaryClient,
  optimizedBuffer: Buffer,
  options: Record<string, unknown>,
  timeoutMs: number,
) {
  return new Promise<CloudinaryUploadResult>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error("CLOUDINARY_UPLOAD_TIMEOUT"));
    }, timeoutMs);
    const complete = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    try {
      const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
        complete(() => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result ?? {});
        });
      });
      stream.end(optimizedBuffer);
    } catch (error) {
      complete(() => reject(error));
    }
  });
}

export async function uploadProductImageToCloudinary(
  input: ProductImageUploadServiceInput,
  dependencies: ProductImageUploadServiceDependencies = {},
): Promise<ProductImageUploadServiceResult> {
  if (
    !productImageUploadRequestIdPattern.test(input.requestId)
    || !productImageAngles.includes(input.angle)
    || input.productSlug.trim().length === 0
  ) {
    return {
      ok: false,
      code: "INVALID_UPLOAD_INPUT",
      message: "La identidad o los datos de la carga no son válidos.",
      status: 400,
      stage: "upload",
    };
  }
  if (input.file.size === 0) {
    return {
      ok: false,
      code: "EMPTY_IMAGE_FILE",
      message: "Selecciona una imagen válida antes de subirla.",
      status: 400,
      stage: "upload",
    };
  }
  if (!isAllowedProductImageMimeType(input.file.type)) {
    return {
      ok: false,
      code: "UNSUPPORTED_IMAGE_TYPE",
      message: productImageInvalidFormatMessage,
      status: 415,
      stage: "upload",
    };
  }
  if (input.file.size > productImageMaxBytes) {
    return {
      ok: false,
      code: "IMAGE_TOO_LARGE",
      message: productImageTooLargeMessage,
      status: 413,
      stage: "upload",
    };
  }

  let sharp: SharpFactory;
  try {
    sharp = await (dependencies.loadSharp ?? loadSharpDynamically)();
  } catch (error) {
    const sharpImportDiagnostic = createProductImageSharpImportDiagnostic(error);
    console.error(JSON.stringify({
      event: productImageSharpImportFailureEvent,
      diagnostic: sharpImportDiagnostic,
    }));
    return {
      ok: false,
      code: "IMAGE_PROCESSOR_UNAVAILABLE",
      message: "El procesador de imágenes no está disponible. Conservamos el archivo para que puedas reintentar.",
      status: 503,
      stage: "image_processing",
      sharpImportDiagnostic,
    };
  }

  let sourceBuffer: Buffer;
  try {
    sourceBuffer = Buffer.from(await input.file.arrayBuffer());
  } catch {
    return {
      ok: false,
      code: "INVALID_IMAGE_CONTENT",
      message: productImageInvalidFormatMessage,
      status: 422,
      stage: "image_processing",
    };
  }

  let width = 0;
  let height = 0;
  try {
    const metadata = await sharp(sourceBuffer, {
      animated: false,
      limitInputPixels: productImageMaxPixels + 1,
    }).rotate().metadata();
    width = metadata.width ?? 0;
    height = metadata.height ?? 0;
  } catch (error) {
    const pixelLimit = error instanceof Error && error.message.toLowerCase().includes("pixel");
    return {
      ok: false,
      code: pixelLimit ? "IMAGE_TOO_MANY_PIXELS" : "INVALID_IMAGE_CONTENT",
      message: pixelLimit ? productImageTooManyPixelsMessage : productImageInvalidFormatMessage,
      status: 422,
      stage: "image_processing",
    };
  }

  if (!width || !height) {
    return {
      ok: false,
      code: "INVALID_IMAGE_CONTENT",
      message: productImageInvalidFormatMessage,
      status: 422,
      stage: "image_processing",
    };
  }
  if (width * height > productImageMaxPixels) {
    return {
      ok: false,
      code: "IMAGE_TOO_MANY_PIXELS",
      message: productImageTooManyPixelsMessage,
      status: 422,
      stage: "image_processing",
    };
  }

  let optimizedBuffer: Buffer;
  try {
    optimizedBuffer = await sharp(sourceBuffer, { animated: false })
      .rotate()
      .resize({
        width: productImageMaxDisplayDimension,
        height: productImageMaxDisplayDimension,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 5 })
      .toBuffer();
  } catch {
    return {
      ok: false,
      code: "IMAGE_PROCESSING_FAILED",
      message: "No se pudo optimizar la imagen. Conservamos el archivo para que puedas corregirlo o reintentar.",
      status: 422,
      stage: "image_processing",
    };
  }

  let cloudinary: CloudinaryClient;
  try {
    cloudinary = (dependencies.getCloudinary ?? defaultCloudinaryClient)();
  } catch {
    return {
      ok: false,
      code: "CLOUDINARY_UNAVAILABLE",
      message: "El almacenamiento de imágenes no está disponible. Conservamos el archivo para que puedas reintentar.",
      status: 503,
      stage: "cloudinary",
    };
  }

  const identity = productImageRemoteIdentity(input);
  let uploadResult: CloudinaryUploadResult;
  try {
    uploadResult = await uploadToCloudinary(cloudinary, optimizedBuffer, {
      folder: identity.folder,
      public_id: identity.leafPublicId,
      resource_type: "image",
      format: "webp",
      overwrite: true,
      invalidate: true,
      context: {
        source: "product_admin",
        upload_request_id: input.requestId,
        original_bytes: String(input.file.size),
        original_megapixels: String(formatMegapixels(width, height)),
        optimized_bytes: String(optimizedBuffer.length),
      },
    }, dependencies.cloudinaryTimeoutMs ?? cloudinaryUploadTimeoutMs);
  } catch {
    return {
      ok: false,
      code: "CLOUDINARY_UPLOAD_FAILED",
      message: "No se pudo almacenar la imagen. Conservamos el archivo para que puedas reintentar.",
      status: 502,
      stage: "cloudinary",
    };
  }

  const publicUrl = uploadResult.secure_url?.trim() ?? "";
  const publicId = uploadResult.public_id?.trim() ?? "";
  let secureUrl = false;
  try {
    secureUrl = new URL(publicUrl).protocol === "https:";
  } catch {
    secureUrl = false;
  }
  if (!secureUrl || publicId !== identity.fullPublicId) {
    return {
      ok: false,
      code: "CLOUDINARY_RESPONSE_INVALID",
      message: "No se pudo validar el resultado remoto de la imagen. Conservamos el archivo para que puedas reintentar.",
      status: 502,
      stage: "cloudinary",
    };
  }

  return {
    ok: true,
    image: {
      publicUrl,
      publicId,
      storagePath: publicId,
    },
  };
}
