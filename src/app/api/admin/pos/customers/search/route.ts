import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { PosCustomerServiceError, searchPosCustomers } from "@/services/supabase/pos-customer.service";

export const dynamic = "force-dynamic";

function boundedInteger(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 0), maximum) : fallback;
}

export async function GET(request: Request) {
  const auth = await authorizePosCustomerRequest("pos:customers:search");
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().replace(/\s+/g, " ").slice(0, 160);
  const limit = Math.max(1, boundedInteger(url.searchParams.get("limit"), 25, 50));
  const offset = boundedInteger(url.searchParams.get("offset"), 0, 10000);
  try {
    const payload = await searchPosCustomers({ query, limit, offset });
    return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const denied = error instanceof PosCustomerServiceError && error.code === "42501";
    return Response.json(
      { message: denied ? "Acceso denegado." : "No se pudo buscar clientes." },
      { status: denied ? 403 : 500 },
    );
  }
}
