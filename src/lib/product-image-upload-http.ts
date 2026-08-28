import {
  isProductImageUploadApiResponse,
  productImageUploadApiPath,
  productImageUploadRequestIdPattern,
  type ProductImageAngle,
  type ProductImageUploadApiResponse,
} from "@/lib/product-image-upload-contract";
import { productImageMaxCount } from "@/utils/product-image-rules";

export type ProductImageUploadTransportErrorCode =
  | "INVALID_UPLOAD_REQUEST"
  | "UPLOAD_NETWORK_ERROR"
  | "UPLOAD_TIMEOUT"
  | "INVALID_UPLOAD_RESPONSE"
  | "UPLOAD_IDENTITY_MISMATCH";

const transportErrorMessages: Record<ProductImageUploadTransportErrorCode, string> = {
  INVALID_UPLOAD_REQUEST: "No se pudo preparar esta imagen para subirla.",
  UPLOAD_NETWORK_ERROR: "No se pudo conectar para subir la imagen. Conservamos el archivo para que puedas reintentar.",
  UPLOAD_TIMEOUT: "La carga tardó demasiado. Conservamos el archivo; reintenta para confirmar el mismo destino remoto.",
  INVALID_UPLOAD_RESPONSE: "El servidor devolvió una respuesta de imagen no válida. Conservamos el archivo para reintentar.",
  UPLOAD_IDENTITY_MISMATCH: "No se pudo confirmar la identidad de esta carga. Conservamos el archivo para reintentar.",
};

export class ProductImageUploadTransportError extends Error {
  readonly code: ProductImageUploadTransportErrorCode;
  readonly requestId: string;

  constructor(code: ProductImageUploadTransportErrorCode, requestId: string) {
    super(transportErrorMessages[code]);
    this.name = "ProductImageUploadTransportError";
    this.code = code;
    this.requestId = requestId;
  }
}

export type ProductImageUploadHttpInput = {
  file: File;
  productSlug: string;
  angle: ProductImageAngle;
  slotIndex: number;
  requestId: string;
};

export const productImageUploadTimeoutMs = 30_000;

export function createProductImageUploadRequestId() {
  return crypto.randomUUID();
}

export async function uploadProductImageViaHttp(
  input: ProductImageUploadHttpInput,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProductImageUploadApiResponse> {
  if (
    !(input.file instanceof File)
    || !productImageUploadRequestIdPattern.test(input.requestId)
    || !Number.isInteger(input.slotIndex)
    || input.slotIndex < 0
    || input.slotIndex >= productImageMaxCount
  ) {
    throw new ProductImageUploadTransportError("INVALID_UPLOAD_REQUEST", input.requestId);
  }

  const formData = new FormData();
  formData.set("file", input.file);
  formData.set("productSlug", input.productSlug);
  formData.set("angle", input.angle);
  formData.set("slotIndex", String(input.slotIndex));
  formData.set("requestId", input.requestId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? productImageUploadTimeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)(productImageUploadApiPath, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "X-Request-ID": input.requestId,
      },
      body: formData,
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null);
    if (!isProductImageUploadApiResponse(result) || response.ok !== result.ok) {
      throw new ProductImageUploadTransportError("INVALID_UPLOAD_RESPONSE", input.requestId);
    }
    if (
      result.correlationId !== input.requestId
      || (result.requestId !== undefined && result.requestId !== input.requestId)
    ) {
      throw new ProductImageUploadTransportError("UPLOAD_IDENTITY_MISMATCH", input.requestId);
    }
    return result;
  } catch (error) {
    if (error instanceof ProductImageUploadTransportError) throw error;
    if (controller.signal.aborted) {
      throw new ProductImageUploadTransportError("UPLOAD_TIMEOUT", input.requestId);
    }
    throw new ProductImageUploadTransportError("UPLOAD_NETWORK_ERROR", input.requestId);
  } finally {
    clearTimeout(timeout);
  }
}
