import { randomUUID } from "node:crypto";
import { getProductCapabilities } from "@/lib/auth/product-access";
import { getSessionProfile } from "@/lib/auth/session";
import {
  canonicalProductCreateIdentity,
  classifyProductCreateConfirmation,
  type ProductCanonicalIdentity,
  type ProductCreateConfirmationResponse,
} from "@/lib/product-create-hardening";
import { getSupabaseServerClient } from "@/lib/supabase-server";

type ConfirmationRequest = {
  sku?: unknown;
  slug?: unknown;
  name?: unknown;
};

function json(result: ProductCreateConfirmationResponse, status = 200) {
  return Response.json(result, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const correlationId = randomUUID();
  const profile = await getSessionProfile().catch(() => null);
  if (!profile) {
    return json({
      ok: false,
      code: "AUTHENTICATION_REQUIRED",
      message: "No se pudo confirmar el catálogo porque la sesión terminó. Inicia sesión y revisa la lista antes de guardar.",
      correlationId,
    }, 401);
  }

  if (!getProductCapabilities(profile).create) {
    return json({
      ok: false,
      code: "PERMISSION_DENIED",
      message: "No tienes permiso para confirmar la creación de este producto.",
      correlationId,
    }, 403);
  }

  let input: ConfirmationRequest;
  try {
    input = await request.json() as ConfirmationRequest;
  } catch {
    return json({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "No se pudo validar la identidad del producto.",
      correlationId,
    }, 400);
  }

  const identity = canonicalProductCreateIdentity({
    sku: typeof input.sku === "string" ? input.sku : "",
    slug: typeof input.slug === "string" ? input.slug : "",
    name: typeof input.name === "string" ? input.name : "",
  });
  if (!identity.sku || !identity.slug) {
    return json({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "SKU y slug son obligatorios para confirmar el resultado.",
      correlationId,
    }, 400);
  }

  const supabase = await getSupabaseServerClient().catch(() => null);
  if (!supabase) {
    return json({
      ok: false,
      code: "PRODUCT_WRITE_UNCONFIRMED",
      message: "No se pudo consultar el catálogo. Conservamos el formulario; actualiza la vista antes de volver a guardar.",
      correlationId,
    }, 503);
  }

  const [bySku, bySlug] = await Promise.all([
    supabase.from("products").select("id, sku, slug").eq("sku", identity.sku).limit(2),
    supabase.from("products").select("id, sku, slug").eq("slug", identity.slug).limit(2),
  ]);
  if (bySku.error || bySlug.error) {
    return json({
      ok: false,
      code: "PRODUCT_WRITE_UNCONFIRMED",
      message: "No se pudo consultar el catálogo. Conservamos el formulario; actualiza la vista antes de volver a guardar.",
      correlationId,
    }, 503);
  }

  const confirmation = classifyProductCreateConfirmation(
    (bySku.data ?? []) as ProductCanonicalIdentity[],
    (bySlug.data ?? []) as ProductCanonicalIdentity[],
  );
  if (confirmation.status === "confirmed") {
    return json({
      ok: true,
      code: "PRODUCT_CREATED_CONFIRMED",
      message: "El producto está guardado correctamente. No vuelvas a guardarlo; actualiza la lista para verlo.",
      productId: confirmation.productId,
      correlationId,
    });
  }

  if (confirmation.status === "not_found") {
    return json({
      ok: false,
      code: "PRODUCT_NOT_CREATED",
      message: "El producto no fue creado. Conservamos el formulario; puedes volver a guardar cuando la conexión esté estable.",
      correlationId,
    });
  }

  return json({
    ok: false,
    code: "PRODUCT_CONFIRMATION_CONFLICT",
    message: "Existe un producto con el mismo SKU o slug, pero no coincide en ambos datos. No vuelvas a guardar hasta revisarlo en la lista.",
    correlationId,
  }, 409);
}
