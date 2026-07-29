import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { createPosDraftSchema, firstZodMessage } from "@/lib/pos/pos-draft-schema";
import { createPosDraft, listPosDrafts, PosDraftServiceError } from "@/services/supabase/pos-draft.service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authorizePosCustomerRequest("pos:drafts:read");
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 50);
  const offset = Math.min(Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0), 10000);
  try {
    return Response.json({ drafts: await listPosDrafts(limit, offset) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const status = error instanceof PosDraftServiceError && error.code === "42501" ? 403 : 500;
    return Response.json({ code: error instanceof PosDraftServiceError ? error.code : "POS_DRAFT_LIST_FAILED", message: error instanceof Error ? error.message : "No se pudieron listar los borradores." }, { status });
  }
}

export async function POST(request: Request) {
  const auth = await authorizePosCustomerRequest("pos:drafts:create");
  if (auth.response) return auth.response;
  const parsed = createPosDraftSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "POS_INVALID_INPUT", message: firstZodMessage(parsed.error) }, { status: 400 });
  try {
    return Response.json(await createPosDraft(parsed.data.requestKey, parsed.data.customerId), { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const status = error instanceof PosDraftServiceError && error.code === "42501" ? 403 : 500;
    return Response.json({ code: error instanceof PosDraftServiceError ? error.code : "POS_DRAFT_CREATE_FAILED", message: error instanceof Error ? error.message : "No se pudo crear el borrador." }, { status });
  }
}
