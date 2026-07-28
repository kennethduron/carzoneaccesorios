import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import {
  getPosCustomerContext,
  PosCustomerServiceError,
  updatePosCustomer,
} from "@/services/supabase/pos-customer.service";
import type { PosCustomerUpdateInput } from "@/types/point-of-sale";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ customerId: string }> };

function nullableText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function responseForError(error: unknown, fallback: string) {
  const serviceError = error instanceof PosCustomerServiceError ? error : null;
  const status = serviceError?.code === "42501" ? 403 : serviceError?.code === "P0002" ? 404 : serviceError?.code === "22023" ? 400 : 500;
  return Response.json({ message: serviceError?.message ?? fallback }, { status });
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await authorizePosCustomerRequest("customers:read_commercial");
  if (auth.response) return auth.response;
  const { customerId } = await context.params;
  try {
    const customer = await getPosCustomerContext(customerId);
    return Response.json(customer, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return responseForError(error, "No se pudo cargar el cliente.");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await authorizePosCustomerRequest("pos:customers:update");
  if (auth.response) return auth.response;
  const { customerId } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ message: "La solicitud no contiene JSON valido." }, { status: 400 });
  }

  const input: PosCustomerUpdateInput = {
    customerId,
    requestKey: typeof body.requestKey === "string" ? body.requestKey : "",
    expectedCommercialVersion: Number(body.expectedCommercialVersion),
    contactName: typeof body.contactName === "string" ? body.contactName.trim() : "",
    phone: typeof body.phone === "string" ? body.phone.trim() : "",
    email: nullableText(body.email),
    businessName: nullableText(body.businessName),
    taxId: nullableText(body.taxId),
    address: nullableText(body.address),
    city: nullableText(body.city),
    commercialNotes: nullableText(body.commercialNotes),
  };

  try {
    const result = await updatePosCustomer(input);
    return Response.json(result, { status: result.ok ? 200 : 409, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return responseForError(error, "No se pudo actualizar el cliente.");
  }
}
