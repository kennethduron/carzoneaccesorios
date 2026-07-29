import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { getPosChargeCapabilities } from "@/services/supabase/pos-draft.service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await authorizePosCustomerRequest("pos:access");
  if (auth.response) return auth.response;
  try {
    return Response.json(await getPosChargeCapabilities(), { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ message: "No se pudieron cargar las capacidades del POS." }, { status: 500 });
  }
}
