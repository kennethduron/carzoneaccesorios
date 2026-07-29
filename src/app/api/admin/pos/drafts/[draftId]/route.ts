import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { abandonPosDraftSchema, firstZodMessage, savePosDraftSchema } from "@/lib/pos/pos-draft-schema";
import { abandonPosDraft, getPosDraft, PosDraftServiceError, savePosDraft } from "@/services/supabase/pos-draft.service";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown, fallback: string) {
  const status = error instanceof PosDraftServiceError
    ? error.code === "42501" ? 403 : error.code === "P0002" ? 404 : error.code === "PT409" ? 409 : 400
    : 500;
  return Response.json({
    code: error instanceof PosDraftServiceError ? error.code : "POS_DRAFT_OPERATION_FAILED",
    message: error instanceof Error ? error.message : fallback,
    ...(error instanceof PosDraftServiceError ? error.context : {}),
  }, { status });
}

export async function GET(_request: Request, context: { params: Promise<{ draftId: string }> }) {
  const auth = await authorizePosCustomerRequest("pos:drafts:read");
  if (auth.response) return auth.response;
  try {
    return Response.json(await getPosDraft((await context.params).draftId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error, "No se pudo cargar el borrador.");
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ draftId: string }> }) {
  const auth = await authorizePosCustomerRequest("pos:drafts:edit_own");
  if (auth.response) return auth.response;
  const parsed = savePosDraftSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: firstZodMessage(parsed.error) }, { status: 400 });
  try {
    return Response.json(await savePosDraft({ ...parsed.data, draftId: (await context.params).draftId }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error, "No se pudo guardar el borrador.");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ draftId: string }> }) {
  const auth = await authorizePosCustomerRequest("pos:drafts:abandon");
  if (auth.response) return auth.response;
  const parsed = abandonPosDraftSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: firstZodMessage(parsed.error) }, { status: 400 });
  try {
    return Response.json(await abandonPosDraft(parsed.data.requestKey, (await context.params).draftId, parsed.data.expectedVersion), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error, "No se pudo abandonar el borrador.");
  }
}
