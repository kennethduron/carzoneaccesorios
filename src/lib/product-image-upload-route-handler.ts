import {
  productImageAngles,
  productImageUploadRequestIdPattern,
  type ProductImageAngle,
  type ProductImageUploadApiResponse,
  type ProductImageUploadServiceResult,
} from "@/lib/product-image-upload-contract";
import type { ProductImageSharpImportDiagnostic } from "@/lib/product-image-sharp-diagnostic";
import { verifySameOriginRequest } from "@/lib/http/same-origin-request";
import {
  isAllowedProductImageMimeType,
  productImageInvalidFormatMessage,
  productImageMaxBytes,
  productImageTooLargeMessage,
} from "@/utils/product-image-rules";

const maxMultipartRequestBytes = 4 * 1024 * 1024;

type UploadProfile = { id: string; email?: string | null };
type UploadInput = {
  file: File;
  productSlug: string;
  angle: ProductImageAngle;
  requestId: string;
};

type UploadFailureLog = {
  correlationId: string;
  requestId: string;
  code: string;
  stage: string;
  status: number;
  userId: string;
  fileSize: number;
  mimeType: string;
  sharpImportDiagnostic?: ProductImageSharpImportDiagnostic;
};

export type ProductImageUploadRouteDependencies = {
  createCorrelationId: () => string;
  getSessionProfile: () => Promise<UploadProfile | null>;
  canManageImages: (profile: UploadProfile) => boolean;
  uploadImage: (input: UploadInput) => Promise<ProductImageUploadServiceResult>;
  logFailure?: (input: UploadFailureLog) => Promise<void>;
};

function json(result: ProductImageUploadApiResponse, status: number) {
  return Response.json(result, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Correlation-ID": result.correlationId,
    },
  });
}

function failure(
  code: Extract<ProductImageUploadApiResponse, { ok: false }>["code"],
  message: string,
  correlationId: string,
  status: number,
  requestId?: string,
) {
  return json({ ok: false, code, message, correlationId, ...(requestId ? { requestId } : {}) }, status);
}

async function readMultipartFormData(request: Request) {
  if (!request.body) throw new Error("INVALID_MULTIPART_BODY");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxMultipartRequestBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("MULTIPART_BODY_TOO_LARGE");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    headers: { "Content-Type": request.headers.get("content-type") ?? "" },
  }).formData();
}

export function createProductImageUploadRouteHandler(dependencies: ProductImageUploadRouteDependencies) {
  return async function POST(request: Request) {
    const fallbackCorrelationId = dependencies.createCorrelationId();
    const originCheck = verifySameOriginRequest(request);
    if (!originCheck.ok) {
      return failure(
        "ORIGIN_DENIED",
        "La solicitud de imagen no proviene de esta aplicación.",
        fallbackCorrelationId,
        403,
      );
    }

    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("multipart/form-data;")) {
      return failure(
        "INVALID_CONTENT_TYPE",
        "El formato de la solicitud de imagen no es válido.",
        fallbackCorrelationId,
        415,
      );
    }

    const headerRequestId = request.headers.get("x-request-id")?.trim() ?? "";
    if (!productImageUploadRequestIdPattern.test(headerRequestId)) {
      return failure(
        "INVALID_REQUEST_ID",
        "La identidad de la carga no es válida.",
        fallbackCorrelationId,
        400,
      );
    }
    const correlationId = headerRequestId;

    let profile: UploadProfile | null;
    try {
      profile = await dependencies.getSessionProfile();
    } catch {
      return failure(
        "AUTHENTICATION_CHECK_FAILED",
        `No se pudo verificar la sesión. Referencia: ${correlationId}.`,
        correlationId,
        503,
        headerRequestId,
      );
    }
    if (!profile) {
      return failure(
        "AUTHENTICATION_REQUIRED",
        "La sesión terminó. Inicia sesión nuevamente para subir imágenes.",
        correlationId,
        401,
        headerRequestId,
      );
    }
    if (!dependencies.canManageImages(profile)) {
      return failure(
        "PERMISSION_DENIED",
        "No tienes permiso para administrar imágenes de productos.",
        correlationId,
        403,
        headerRequestId,
      );
    }

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxMultipartRequestBytes) {
      return failure(
        "REQUEST_TOO_LARGE",
        productImageTooLargeMessage,
        correlationId,
        413,
        headerRequestId,
      );
    }

    let formData: FormData;
    try {
      formData = await readMultipartFormData(request);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "MULTIPART_BODY_TOO_LARGE";
      return failure(
        tooLarge ? "REQUEST_TOO_LARGE" : "INVALID_UPLOAD_INPUT",
        tooLarge ? productImageTooLargeMessage : "No se pudo leer la solicitud de imagen.",
        correlationId,
        tooLarge ? 413 : 400,
        headerRequestId,
      );
    }

    const formRequestId = formData.get("requestId");
    const productSlug = formData.get("productSlug");
    const angle = formData.get("angle");
    const slotIndexRaw = formData.get("slotIndex");
    const file = formData.get("file");
    const slotIndex = typeof slotIndexRaw === "string" ? Number(slotIndexRaw) : Number.NaN;

    if (
      formRequestId !== headerRequestId
      || typeof productSlug !== "string"
      || productSlug.trim().length === 0
      || productSlug.trim().length > 160
      || typeof angle !== "string"
      || !productImageAngles.includes(angle as ProductImageAngle)
      || !Number.isInteger(slotIndex)
      || slotIndex < 0
      || slotIndex > 4
    ) {
      return failure(
        "INVALID_UPLOAD_INPUT",
        "Revisa la identidad, producto y posición de la imagen.",
        correlationId,
        400,
        headerRequestId,
      );
    }
    if (!(file instanceof File)) {
      return failure(
        "MISSING_IMAGE_FILE",
        "Selecciona una imagen válida antes de subirla.",
        correlationId,
        400,
        headerRequestId,
      );
    }
    if (file.size === 0) {
      return failure(
        "EMPTY_IMAGE_FILE",
        "Selecciona una imagen válida antes de subirla.",
        correlationId,
        400,
        headerRequestId,
      );
    }
    if (!isAllowedProductImageMimeType(file.type)) {
      return failure(
        "UNSUPPORTED_IMAGE_TYPE",
        productImageInvalidFormatMessage,
        correlationId,
        415,
        headerRequestId,
      );
    }
    if (file.size > productImageMaxBytes) {
      return failure(
        "IMAGE_TOO_LARGE",
        productImageTooLargeMessage,
        correlationId,
        413,
        headerRequestId,
      );
    }

    let result: ProductImageUploadServiceResult;
    try {
      result = await dependencies.uploadImage({
        file,
        productSlug: productSlug.trim(),
        angle: angle as ProductImageAngle,
        requestId: headerRequestId,
      });
    } catch {
      result = {
        ok: false,
        code: "UPLOAD_FAILED",
        message: `No se pudo completar la carga. Conservamos el archivo para reintentar. Referencia: ${correlationId}.`,
        status: 500,
        stage: "upload",
      };
    }

    if (!result.ok) {
      await dependencies.logFailure?.({
        correlationId,
        requestId: headerRequestId,
        code: result.code,
        stage: result.stage,
        status: result.status,
        userId: profile.id,
        fileSize: file.size,
        mimeType: file.type,
        sharpImportDiagnostic: result.sharpImportDiagnostic,
      }).catch(() => undefined);
      return failure(result.code, result.message, correlationId, result.status, headerRequestId);
    }

    return json({
      ok: true,
      requestId: headerRequestId,
      correlationId,
      image: result.image,
    }, 200);
  };
}
