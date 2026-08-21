import { randomUUID } from "node:crypto";
import { verifySameOriginRequest } from "@/lib/http/same-origin-request";
import { saveProductCanonical, type ProductSaveResult } from "@/services/product-save.service";
import type { ProductFormInput } from "@/types/products";

export const runtime = "nodejs";

const maxRequestBytes = 256 * 1024;
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CreateRequestBody = {
  requestId?: unknown;
  product?: unknown;
};

type SafeRouteErrorCode = "ORIGIN_DENIED" | "VALIDATION_FAILED" | "PRODUCT_WRITE_FAILED";

function json(
  result: ProductSaveResult | { ok: false; code: SafeRouteErrorCode; message: string; correlationId: string },
  status: number,
) {
  return Response.json(result, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Correlation-ID": result.correlationId,
    },
  });
}

function statusFor(result: ProductSaveResult) {
  if (result.ok) return 201;
  switch (result.code) {
    case "AUTHENTICATION_REQUIRED": return 401;
    case "PERMISSION_DENIED": return 403;
    case "VALIDATION_FAILED": return 400;
    case "CATEGORY_INVALID": return 422;
    case "DUPLICATE_PRODUCT": return 409;
    case "PRODUCT_WRITE_UNCONFIRMED": return 503;
    default: return 500;
  }
}

export async function POST(request: Request) {
  const fallbackCorrelationId = randomUUID();
  const originCheck = verifySameOriginRequest(request);
  if (!originCheck.ok) {
    return json({
      ok: false,
      code: "ORIGIN_DENIED",
      message: "La solicitud de guardado no proviene de esta aplicación.",
      correlationId: fallbackCorrelationId,
    }, 403);
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "El formato de la solicitud no es válido.",
      correlationId: fallbackCorrelationId,
    }, 415);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
    return json({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "La solicitud de producto supera el tamaño permitido.",
      correlationId: fallbackCorrelationId,
    }, 413);
  }

  let body: CreateRequestBody;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > maxRequestBytes) throw new Error("BODY_TOO_LARGE");
    body = JSON.parse(rawBody) as CreateRequestBody;
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "BODY_TOO_LARGE";
    return json({
      ok: false,
      code: "VALIDATION_FAILED",
      message: tooLarge ? "La solicitud de producto supera el tamaño permitido." : "No se pudo leer la información del producto.",
      correlationId: fallbackCorrelationId,
    }, tooLarge ? 413 : 400);
  }

  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const headerRequestId = request.headers.get("x-request-id");
  if (
    !requestIdPattern.test(requestId)
    || (headerRequestId !== null && headerRequestId !== requestId)
    || !body.product
    || typeof body.product !== "object"
    || Array.isArray(body.product)
  ) {
    return json({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "La solicitud de creación no es válida.",
      correlationId: requestIdPattern.test(requestId) ? requestId : fallbackCorrelationId,
    }, 400);
  }

  const product = body.product as ProductFormInput;
  if (Object.prototype.hasOwnProperty.call(product, "id")) {
    return json({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Esta ruta solo permite crear productos nuevos.",
      correlationId: requestId,
    }, 400);
  }

  try {
    const result = await saveProductCanonical(product, { requestId });
    return json(result, statusFor(result));
  } catch {
    return json({
      ok: false,
      code: "PRODUCT_WRITE_FAILED",
      message: `No fue posible guardar el producto. La información permanece en el formulario. Referencia: ${requestId}.`,
      correlationId: requestId,
    }, 500);
  }
}
