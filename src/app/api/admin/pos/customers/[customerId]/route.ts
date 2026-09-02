import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { parsePosCustomerInput } from "@/lib/validation/pos-customer";
import {
  getPosCustomerContext,
  PosCustomerServiceError,
  updatePosCustomer,
  savePosBasicCustomer,
} from "@/services/supabase/pos-customer.service";
import { verifySameOriginRequest } from "@/lib/http/same-origin-request";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ customerId: string }> };

function responseForError(error: unknown, fallback: string) {
  const serviceError = error instanceof PosCustomerServiceError ? error : null;
  const status = serviceError?.code === "42501" ? 403
    : serviceError?.code === "P0002" ? 404
      : serviceError?.code === "POS_CUSTOMER_SUSPENDED" || serviceError?.code === "PT409" ? 409
        : serviceError?.code === "22023" ? 400 : 500;
  return Response.json({ code: serviceError?.code, message: serviceError?.message ?? fallback }, { status });
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await authorizePosCustomerRequest("customers:read_commercial");
  if (auth.response) return auth.response;
  const { customerId } = await context.params;
  try {
    const customer = await getPosCustomerContext(customerId);
    return Response.json(auth.profile!.role === "vendedor" ? {
      ...customer,
      commercialNotes: null,
      hasPortalAccount: false,
      credit: { ...customer.credit, notes: null },
      summary: { orderCount: 0, invoiceCount: 0, totalBilled: 0 },
    } : customer, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return responseForError(error, "No se pudo cargar el cliente.");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!verifySameOriginRequest(request).ok) return Response.json({ message: "Solicitud de origen no permitido." }, { status: 403 });
  const auth = await authorizePosCustomerRequest("pos:customers:update");
  if (auth.response) return auth.response;
  const seller = auth.profile!.role === "vendedor";
  if (!seller && (!hasEffectivePermission(auth.profile!.role, auth.profile!.permissions, "wholesale:manage", auth.profile!.email)
    || !hasEffectivePermission(auth.profile!.role, auth.profile!.permissions, "credit:manage", auth.profile!.email))) {
    return Response.json({ message: "Acceso denegado." }, { status: 403 });
  }
  const { customerId } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ message: "La solicitud no contiene JSON valido." }, { status: 400 });
  }

  const parsed = parsePosCustomerInput(body, { customerId, mode: "update" });
  if (!parsed.ok) return Response.json({ message: parsed.message }, { status: 400 });

  try {
    const result = seller ? await savePosBasicCustomer(parsed.value) : await updatePosCustomer(parsed.value);
    return Response.json(result, { status: result.ok ? 200 : 409, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return responseForError(error, "No se pudo actualizar el cliente.");
  }
}
