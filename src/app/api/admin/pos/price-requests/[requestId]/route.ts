import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { verifySameOriginRequest } from "@/lib/http/same-origin-request";
import { notifyPriceRequestDecision } from "@/lib/notifications/pos-price-request";
import { decidePriceRequestSchema } from "@/lib/validation/sales-commercial";
import { cancelPriceRequest, decidePriceRequest, getPriceRequest, SalesCommercialServiceError } from "@/services/supabase/sales-commercial.service";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ requestId: string }> };
function failure(error: unknown) {
  const code = error instanceof SalesCommercialServiceError ? error.code : "SALES_COMMERCIAL_FAILED";
  const status = code === "42501" || code.includes("FORBIDDEN") ? 403 : code === "P0002" ? 404 : code === "PT409" || code.includes("ALREADY") ? 409 : error instanceof SalesCommercialServiceError ? 400 : 500;
  return Response.json({ code, message: error instanceof Error ? error.message : "No se pudo completar la solicitud." }, { status });
}
export async function GET(_request: Request, context: Context) {
  const auth = await authorizePosCustomerRequest("pos:access"); if (auth.response) return auth.response;
  try { return Response.json(await getPriceRequest((await context.params).requestId), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return failure(error); }
}
export async function PATCH(request: Request, context: Context) {
  if (!verifySameOriginRequest(request).ok) return Response.json({ code: "INVALID_ORIGIN", message: "Solicitud de origen no permitido." }, { status: 403 });
  const auth = await authorizePosCustomerRequest("pos:access"); if (auth.response) return auth.response;
  const parsed = decidePriceRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: parsed.error.issues[0]?.message }, { status: 400 });
  try {
    const id = (await context.params).requestId;
    const result = parsed.data.action === "cancel" ? await cancelPriceRequest(id) : await decidePriceRequest(id, parsed.data.action, parsed.data.reason);
    if (parsed.data.action !== "cancel") await notifyPriceRequestDecision(result).catch((error) => console.warn("Decision notification deferred", { message: error instanceof Error ? error.message : "unknown" }));
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(error); }
}
