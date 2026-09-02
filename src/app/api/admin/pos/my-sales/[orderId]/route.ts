import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { getMyPosSaleDetail, SalesCommercialServiceError } from "@/services/supabase/sales-commercial.service";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  const auth = await authorizePosCustomerRequest("pos:sales:read_own"); if (auth.response) return auth.response;
  try { return Response.json(await getMyPosSaleDetail((await context.params).orderId), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { const code = error instanceof SalesCommercialServiceError ? error.code : "POS_MY_SALE_FAILED"; return Response.json({ code, message: error instanceof Error ? error.message : "No se pudo cargar la venta." }, { status: code === "P0002" ? 404 : 400 }); }
}
