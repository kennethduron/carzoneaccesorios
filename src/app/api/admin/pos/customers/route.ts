import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { createPosCustomer, PosCustomerServiceError } from "@/services/supabase/pos-customer.service";
import type { PosCustomerWriteInput } from "@/types/point-of-sale";

export const dynamic = "force-dynamic";

function nullableText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function POST(request: Request) {
  const auth = await authorizePosCustomerRequest("pos:customers:create");
  if (auth.response) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ message: "La solicitud no contiene JSON valido." }, { status: 400 });
  }

  const input: PosCustomerWriteInput = {
    requestKey: typeof body.requestKey === "string" ? body.requestKey : "",
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
    const result = await createPosCustomer(input);
    return Response.json(result, { status: result.ok ? 201 : 409, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const serviceError = error instanceof PosCustomerServiceError ? error : null;
    const status = serviceError?.code === "42501" ? 403 : serviceError?.code === "22023" ? 400 : 500;
    return Response.json({ message: serviceError?.message ?? "No se pudo crear el cliente." }, { status });
  }
}
