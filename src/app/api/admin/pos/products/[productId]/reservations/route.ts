import { z } from "zod";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { authorizePosCustomerRequest } from "@/lib/auth/pos-customer-request";
import {
  getPosProductReservations,
  PosDraftServiceError,
} from "@/services/supabase/pos-draft.service";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ productId: z.string().uuid() });
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ productId: string }> },
) {
  const auth = await authorizePosCustomerRequest("pos:products:search");
  if (auth.response) return auth.response;
  const profile = auth.profile!;
  const canReadOrders =
    hasEffectivePermission(profile.role, profile.permissions, "orders:read", profile.email)
    || hasEffectivePermission(profile.role, profile.permissions, "orders:manage", profile.email);
  if (!canReadOrders) {
    return Response.json({ code: "POS_PERMISSION_DENIED", message: "Acceso denegado." }, { status: 403 });
  }

  const parsedParams = paramsSchema.safeParse(await context.params);
  const url = new URL(request.url);
  const parsedQuery = querySchema.safeParse({
    limit: url.searchParams.get("limit") ?? 20,
    offset: url.searchParams.get("offset") ?? 0,
  });
  if (!parsedParams.success || !parsedQuery.success) {
    return Response.json({
      code: "POS_RESERVATION_QUERY_INVALID",
      message: "La consulta de reservas no es válida.",
    }, { status: 400 });
  }

  try {
    const payload = await getPosProductReservations({
      productId: parsedParams.data.productId,
      ...parsedQuery.data,
    });
    return Response.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof PosDraftServiceError && error.code === "42501" ? 403 : 400;
    return Response.json({
      code: error instanceof PosDraftServiceError ? error.code : "POS_RESERVATION_QUERY_FAILED",
      message: error instanceof Error ? error.message : "No se pudieron consultar los pedidos relacionados.",
    }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}
