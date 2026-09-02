import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { mySalesListSchema } from "@/lib/validation/sales-commercial";
import { listMyPosSales, SalesCommercialServiceError } from "@/services/supabase/sales-commercial.service";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await authorizePosCustomerRequest("pos:sales:read_own"); if (auth.response) return auth.response;
  const parsed = mySalesListSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ message: parsed.error.issues[0]?.message }, { status: 400 });
  try { return Response.json(await listMyPosSales({ ...parsed.data, query: parsed.data.q }), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return Response.json({ code: error instanceof SalesCommercialServiceError ? error.code : "POS_MY_SALES_FAILED", message: error instanceof Error ? error.message : "No se pudieron cargar tus ventas." }, { status: error instanceof SalesCommercialServiceError ? 400 : 500 }); }
}
