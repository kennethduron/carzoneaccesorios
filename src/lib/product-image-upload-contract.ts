export const productImageUploadApiPath = "/api/admin/productos/images/upload";

export const productImageUploadRequestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const productImageAngles = ["principal", "frontal", "lateral", "trasera", "detalle", "otro"] as const;
export type ProductImageAngle = (typeof productImageAngles)[number];

export type ProductImageUploadMetadata = {
  publicUrl: string;
  publicId: string;
  storagePath: string;
};

export const productImageUploadErrorCodes = [
  "ORIGIN_DENIED",
  "AUTHENTICATION_REQUIRED",
  "AUTHENTICATION_CHECK_FAILED",
  "PERMISSION_DENIED",
  "INVALID_CONTENT_TYPE",
  "REQUEST_TOO_LARGE",
  "INVALID_REQUEST_ID",
  "INVALID_UPLOAD_INPUT",
  "MISSING_IMAGE_FILE",
  "EMPTY_IMAGE_FILE",
  "UNSUPPORTED_IMAGE_TYPE",
  "IMAGE_TOO_LARGE",
  "IMAGE_TOO_MANY_PIXELS",
  "INVALID_IMAGE_CONTENT",
  "IMAGE_PROCESSOR_UNAVAILABLE",
  "IMAGE_PROCESSING_FAILED",
  "CLOUDINARY_UNAVAILABLE",
  "CLOUDINARY_UPLOAD_FAILED",
  "CLOUDINARY_RESPONSE_INVALID",
  "UPLOAD_FAILED",
] as const;
export type ProductImageUploadErrorCode = (typeof productImageUploadErrorCodes)[number];

export type ProductImageUploadApiResponse =
  | {
      ok: true;
      requestId: string;
      correlationId: string;
      image: ProductImageUploadMetadata;
    }
  | {
      ok: false;
      requestId?: string;
      correlationId: string;
      code: ProductImageUploadErrorCode;
      message: string;
    };

export type ProductImageUploadServiceResult =
  | { ok: true; image: ProductImageUploadMetadata }
  | {
      ok: false;
      code: ProductImageUploadErrorCode;
      message: string;
      status: number;
      stage: "image_processing" | "cloudinary" | "upload";
      sharpImportDiagnostic?: import("@/lib/product-image-sharp-diagnostic").ProductImageSharpImportDiagnostic;
    };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function isProductImageUploadApiResponse(value: unknown): value is ProductImageUploadApiResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.ok !== "boolean"
    || !isNonEmptyString(candidate.correlationId)
    || !productImageUploadRequestIdPattern.test(candidate.correlationId)
  ) {
    return false;
  }

  if (candidate.ok) {
    if (
      !isNonEmptyString(candidate.requestId)
      || !productImageUploadRequestIdPattern.test(candidate.requestId)
      || !candidate.image
      || typeof candidate.image !== "object"
      || Array.isArray(candidate.image)
    ) {
      return false;
    }
    const image = candidate.image as Record<string, unknown>;
    return isNonEmptyString(image.publicUrl)
      && isHttpsUrl(image.publicUrl)
      && isNonEmptyString(image.publicId)
      && isNonEmptyString(image.storagePath)
      && image.publicId === image.storagePath;
  }

  return isNonEmptyString(candidate.code)
    && productImageUploadErrorCodes.includes(candidate.code as ProductImageUploadErrorCode)
    && isNonEmptyString(candidate.message)
    && (
      candidate.requestId === undefined
      || (isNonEmptyString(candidate.requestId) && productImageUploadRequestIdPattern.test(candidate.requestId))
    );
}
