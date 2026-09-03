import { authorizeCommissionRequest } from "@/lib/auth/commission-request";
import { getMySellerWorkspace, CommissionServiceError } from "@/services/supabase/commissions.service";
export const dynamic = "force-dynamic";
export async function GET() {
  const auth = await authorizeCommissionRequest("sales:seller_dashboard:read_own"); if (auth.response) return auth.response;
  try { return Response.json(await getMySellerWorkspace(), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return Response.json({ code: error instanceof CommissionServiceError ? error.code : "SELLER_WORKSPACE_FAILED", message: error instanceof Error ? error.message : "No se pudo cargar el panel." }, { status: 400 }); }
}
