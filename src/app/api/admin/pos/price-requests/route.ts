import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { verifySameOriginRequest } from "@/lib/http/same-origin-request";
import { notifyPriceRequestCreated } from "@/lib/notifications/pos-price-request";
import { createPriceRequestSchema, priceRequestListSchema } from "@/lib/validation/sales-commercial";
import { createPriceRequest, listPriceRequests, SalesCommercialServiceError } from "@/services/supabase/sales-commercial.service";

export const dynamic = "force-dynamic";
function failure(error: unknown) {
  const code = error instanceof SalesCommercialServiceError ? error.code : "SALES_COMMERCIAL_FAILED";
  const status = code === "42501" || code.includes("FORBIDDEN") ? 403 : code === "P0002" ? 404 : code === "PT409" || code.includes("ALREADY") || code.includes("CHANGED") ? 409 : error instanceof SalesCommercialServiceError ? 400 : 500;
  return Response.json({ code, message: error instanceof Error ? error.message : "No se pudo completar la solicitud." }, { status, headers: { "Cache-Control": "private, no-store" } });
}
export async function GET(request: Request) {
  const auth = await authorizePosCustomerRequest("pos:access"); if (auth.response) return auth.response;
  const parsed = priceRequestListSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ message: parsed.error.issues[0]?.message }, { status: 400 });
  try { return Response.json(await listPriceRequests({
    status: parsed.data.status, query: parsed.data.q, sellerId: parsed.data.seller,
    from: parsed.data.from, to: parsed.data.to, sort: parsed.data.sort,
    limit: parsed.data.limit, offset: parsed.data.offset,
  }), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  if (!verifySameOriginRequest(request).ok) return Response.json({ code: "INVALID_ORIGIN", message: "Solicitud de origen no permitido." }, { status: 403 });
  const auth = await authorizePosCustomerRequest("pos:price_request"); if (auth.response) return auth.response;
  const parsed = createPriceRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: parsed.error.issues[0]?.message }, { status: 400 });
  try {
    const result = await createPriceRequest(parsed.data);
    await notifyPriceRequestCreated(result).catch((error) => console.warn("Price request notification deferred", { message: error instanceof Error ? error.message : "unknown" }));
    return Response.json(result, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(error); }
}
