import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { parsePosCustomerInput } from "@/lib/validation/pos-customer";
import { createPosCustomer, PosCustomerServiceError, savePosBasicCustomer } from "@/services/supabase/pos-customer.service";
import { verifySameOriginRequest } from "@/lib/http/same-origin-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!verifySameOriginRequest(request).ok) return Response.json({ message: "Solicitud de origen no permitido." }, { status: 403 });
  const auth = await authorizePosCustomerRequest("pos:customers:create");
  if (auth.response) return auth.response;
  const seller = auth.profile!.role === "vendedor";
  if (!seller && (!hasEffectivePermission(auth.profile!.role, auth.profile!.permissions, "wholesale:manage", auth.profile!.email)
    || !hasEffectivePermission(auth.profile!.role, auth.profile!.permissions, "credit:manage", auth.profile!.email))) {
    return Response.json({ message: "Acceso denegado." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ message: "La solicitud no contiene JSON valido." }, { status: 400 });
  }

  const parsed = parsePosCustomerInput(body, { mode: "create" });
  if (!parsed.ok) return Response.json({ message: parsed.message }, { status: 400 });

  try {
    const result = seller ? await savePosBasicCustomer(parsed.value) : await createPosCustomer(parsed.value);
    return Response.json(result, { status: result.ok ? 201 : 409, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const serviceError = error instanceof PosCustomerServiceError ? error : null;
    const status = serviceError?.code === "42501" ? 403 : serviceError?.code === "22023" ? 400 : 500;
    return Response.json({ message: serviceError?.message ?? "No se pudo crear el cliente." }, { status });
  }
}
