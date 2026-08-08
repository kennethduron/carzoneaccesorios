import { z } from "zod";
import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import {
  getPosProductInventorySnapshots,
  PosDraftServiceError,
} from "@/services/supabase/pos-draft.service";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  productIds: z.array(z.string().uuid()).max(50),
}).strict();

export async function POST(request: Request) {
  const auth = await authorizePosCustomerRequest("pos:products:search");
  if (auth.response) return auth.response;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({
      code: "POS_PRODUCT_QUERY_INVALID",
      message: "La solicitud de existencias no es válida.",
    }, { status: 400 });
  }
  try {
    const snapshots = await getPosProductInventorySnapshots(parsed.data.productIds);
    return Response.json({ snapshots }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof PosDraftServiceError && error.code === "42501" ? 403 : 400;
    return Response.json({
      code: error instanceof PosDraftServiceError ? error.code : "POS_INVENTORY_REFRESH_FAILED",
      message: error instanceof Error ? error.message : "No se pudieron actualizar las existencias.",
    }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}
