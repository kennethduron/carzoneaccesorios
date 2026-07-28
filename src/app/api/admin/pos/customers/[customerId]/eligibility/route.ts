import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import {
  evaluatePosWholesaleEligibility,
  PosCustomerServiceError,
} from "@/services/supabase/pos-customer.service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ customerId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePosCustomerRequest("customers:read_commercial");
  if (auth.response) return auth.response;

  const { customerId } = await context.params;
  const merchandiseFinal = Number(new URL(request.url).searchParams.get("merchandiseFinal"));
  if (!Number.isFinite(merchandiseFinal) || merchandiseFinal < 0) {
    return Response.json({ message: "El monto de mercaderia no es valido." }, { status: 400 });
  }

  try {
    const result = await evaluatePosWholesaleEligibility(customerId, merchandiseFinal);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const serviceError = error instanceof PosCustomerServiceError ? error : null;
    const status = serviceError?.code === "42501" ? 403 : serviceError?.code === "P0002" ? 404 : 500;
    return Response.json({ message: serviceError?.message ?? "No se pudo evaluar la elegibilidad." }, { status });
  }
}
