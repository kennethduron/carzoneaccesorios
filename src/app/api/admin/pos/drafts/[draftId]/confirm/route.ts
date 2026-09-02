import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { confirmPosSaleSchema, firstZodMessage } from "@/lib/pos/pos-draft-schema";
import {
  confirmPosSale,
  PosDraftServiceError,
  recoverPosSaleConfirmation,
} from "@/services/supabase/pos-draft.service";
import { verifySameOriginRequest } from "@/lib/http/same-origin-request";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  const status = error instanceof PosDraftServiceError
    ? error.code === "POS_PERMISSION_DENIED" || error.code.includes("FORBIDDEN") ? 403
      : error.code === "POS_DRAFT_NOT_FOUND" ? 404
        : error.code === "POS_INSUFFICIENT_STOCK" || error.code === "POS_PRODUCT_INACTIVE"
          || error.code.includes("CONFLICT") || error.code.includes("CHANGED")
          || error.code.includes("CONFIRMED") || error.code.startsWith("POS_CREDIT_") ? 409 : 400
    : 500;
  return Response.json({
    code: error instanceof PosDraftServiceError ? error.code : "POS_CONFIRMATION_FAILED",
    message: error instanceof Error
      ? error.message
      : "No se pudo confirmar la venta. Ningun cambio economico fue aplicado.",
  }, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ draftId: string }> },
) {
  const auth = await authorizePosCustomerRequest("pos:confirm_sale");
  if (auth.response) return auth.response;
  try {
    return Response.json(
      await recoverPosSaleConfirmation((await context.params).draftId),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ draftId: string }> },
) {
  if (!verifySameOriginRequest(request).ok) {
    return Response.json({ code: "INVALID_ORIGIN", message: "Solicitud de origen no permitido." }, { status: 403 });
  }
  const auth = await authorizePosCustomerRequest("pos:confirm_sale");
  if (auth.response) return auth.response;
  const parsed = confirmPosSaleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({
      code: "POS_CONFIRMATION_INVALID",
      message: firstZodMessage(parsed.error),
    }, { status: 400 });
  }
  try {
    return Response.json(await confirmPosSale({
      draftId: (await context.params).draftId,
      ...parsed.data,
    }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
