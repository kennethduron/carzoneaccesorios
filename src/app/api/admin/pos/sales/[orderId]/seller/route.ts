import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { verifySameOriginRequest } from "@/lib/http/same-origin-request";
import { correctPosSellerSchema } from "@/lib/validation/sales-commercial";
import { correctPosOrderSeller, SalesCommercialServiceError } from "@/services/supabase/sales-commercial.service";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ orderId: string }> }) {
  if (!verifySameOriginRequest(request).ok) {
    return Response.json({ code: "INVALID_ORIGIN", message: "Solicitud de origen no permitido." }, { status: 403 });
  }
  const auth = await authorizePosCustomerRequest("pos:seller_attribution:correct");
  if (auth.response) return auth.response;
  const { orderId } = await context.params;
  const parsed = correctPosSellerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: parsed.error.issues[0]?.message }, { status: 400 });
  try {
    return Response.json(await correctPosOrderSeller({ orderId, ...parsed.data }), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const code = error instanceof SalesCommercialServiceError ? error.code : "SALES_COMMERCIAL_FAILED";
    const status = code === "P0002" ? 404 : code === "42501" || code.includes("FORBIDDEN") ? 403 : 400;
    return Response.json({ code, message: error instanceof Error ? error.message : "No se pudo corregir el vendedor." }, {
      status, headers: { "Cache-Control": "private, no-store" },
    });
  }
}
