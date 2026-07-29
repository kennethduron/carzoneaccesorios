import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import { firstZodMessage, posProductSearchSchema } from "@/lib/pos/pos-draft-schema";
import { PosDraftServiceError, searchPosProducts } from "@/services/supabase/pos-draft.service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authorizePosCustomerRequest("pos:products:search");
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const parsed = posProductSearchSchema.safeParse({
    query: url.searchParams.get("q") ?? "",
    customerId: url.searchParams.get("customerId"),
    expectedCustomerCommercialVersion: url.searchParams.get("expectedCustomerCommercialVersion"),
    categoryId: url.searchParams.get("categoryId") || null,
    brand: url.searchParams.get("brand") || null,
    includeUnavailable: url.searchParams.get("includeUnavailable") ?? "true",
    limit: url.searchParams.get("limit") ?? 25,
    offset: url.searchParams.get("offset") ?? 0,
  });
  if (!parsed.success) return Response.json({ code: "POS_INVALID_INPUT", message: firstZodMessage(parsed.error) }, { status: 400 });
  try {
    const payload = await searchPosProducts({
      ...parsed.data,
    });
    return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const status = error instanceof PosDraftServiceError
      ? error.code === "42501" ? 403 : error.code === "PT409" ? 409 : 400
      : 500;
    return Response.json({ code: error instanceof PosDraftServiceError ? error.code : "POS_PRODUCT_SEARCH_FAILED", message: error instanceof Error ? error.message : "No se pudieron buscar productos.", ...(error instanceof PosDraftServiceError ? error.context : {}) }, { status });
  }
}
