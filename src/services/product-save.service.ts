import "server-only";

import { randomUUID } from "node:crypto";
import { writeAuditLog } from "@/lib/audit";
import { getProductCapabilities } from "@/lib/auth/product-access";
import { getSessionProfile } from "@/lib/auth/session";
import { configureCloudinary } from "@/lib/cloudinary";
import { writeErrorLog } from "@/lib/error-logging";
import { markProductAvailabilityStale } from "@/lib/product-availability-cache";
import { isOfficialProductCategory } from "@/lib/product-categories";
import { canonicalProductCreateIdentity, runProductPostSaveTasks } from "@/lib/product-create-hardening";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { productTaxCategorySchema } from "@/lib/validation/product-tax";
import type { ProductFormInput, ProductImageInput, ProductStatus, ProductTaxCategory } from "@/types/products";
import { parseRequiredStockInteger } from "@/utils/product-import-stock";
import { normalizeVehicleBrand, normalizeVehicleModel } from "@/utils/vehicle-compatibility";

export type ProductSaveResult =
  | {
      ok: true;
      code:
        | "PRODUCT_CREATED"
        | "PRODUCT_UPDATED"
        | "PRODUCT_SAVED_REFRESH_PENDING"
        | "PRODUCT_SAVED_POST_SAVE_WARNING";
      message: string;
      productId: string;
      slug: string;
      correlationId: string;
    }
  | {
      ok: false;
      code:
        | "AUTHENTICATION_REQUIRED"
        | "PERMISSION_DENIED"
        | "VALIDATION_FAILED"
        | "CATEGORY_INVALID"
        | "DUPLICATE_PRODUCT"
        | "PRODUCT_WRITE_FAILED"
        | "PRODUCT_WRITE_UNCONFIRMED";
      message: string;
      correlationId: string;
      stage: "authorization" | "validation" | "database_write";
    };

type ProductDbPayload = {
  category_id: string | null;
  sku: string;
  internal_code: string | null;
  slug: string;
  name: string;
  brand: string;
  vehicle_brand: string | null;
  vehicle_model: string | null;
  vehicle_year_start: number | null;
  vehicle_year_end: number | null;
  short_description: string | null;
  description: string;
  features: string | null;
  specifications: string | null;
  compatibility_notes: string | null;
  stock: number;
  low_stock_threshold: number;
  min_stock: number;
  cost_price: number;
  retail_price: number;
  wholesale_price: number;
  wholesale_min_quantity: number;
  tax_category: ProductTaxCategory;
  tracks_inventory: boolean;
  is_new: boolean;
  status: ProductStatus;
  active: boolean;
};

type ProductCatalogSaveRpcResult = {
  product_id: string;
  removed_asset_ids: string[] | null;
  stock_movement_id: string | null;
  stock_before: number;
  stock_after: number;
  stock_quantity: number;
};

function cleanText(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function positiveNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function positiveInteger(value: unknown, fallback = 0) {
  return Math.floor(positiveNumber(value, fallback));
}

function stockIntegerForAdjustment(value: unknown) {
  const parsed = parseRequiredStockInteger(value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

export function friendlyProductError(message: string) {
  if (message.includes("products_internal_code_key")) {
    return "El código proveedor/OEM ya está usado por otro producto. Usa otro código o déjalo vacío.";
  }
  if (message.includes("products_sku_key")) {
    return "El SKU ya está usado por otro producto. Usa un SKU diferente.";
  }
  if (message.includes("products_slug_key")) {
    return "La URL amigable ya está usada por otro producto. Edita el slug en opciones avanzadas.";
  }
  if (message.toLowerCase().includes("duplicate key")) {
    return "Ya existe un registro con un dato único repetido. Revisa SKU, código proveedor/OEM o URL amigable.";
  }
  return message;
}

export function productPayload(input: ProductFormInput): ProductDbPayload {
  const { sku, slug } = canonicalProductCreateIdentity(input);
  const name = input.name.trim();
  const status = input.active ? input.status : "inactive";
  const categoryId = cleanText(input.category_id);

  if (!sku || !name || !input.brand.trim()) throw new Error("SKU, nombre y marca son obligatorios.");
  if (!categoryId) throw new Error("Selecciona una categoría para guardar el producto.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(categoryId)) {
    throw new Error("Selecciona una categoría oficial para guardar el producto.");
  }
  if (input.wholesale_price > input.retail_price) {
    throw new Error("El precio mayorista no puede ser mayor que el precio al detalle.");
  }

  const numericValues = [input.stock, input.min_stock, input.cost_price, input.retail_price, input.wholesale_price];
  if (numericValues.some((value) => !Number.isFinite(Number(value)) || Number(value) < 0)) {
    throw new Error("Stock y precios deben contener valores numéricos no negativos.");
  }
  if (!Number.isInteger(Number(input.stock)) || !Number.isInteger(Number(input.min_stock))) {
    throw new Error("Stock y stock mínimo deben ser números enteros.");
  }
  if (Number(input.retail_price) <= 0) throw new Error("El precio al detalle debe ser mayor que cero.");
  if (!productTaxCategorySchema.safeParse(input.tax_category).success) {
    throw new Error("Selecciona una clasificación fiscal válida.");
  }

  const shortDescription = cleanText(input.short_description);
  if (shortDescription && shortDescription.length > 160) {
    throw new Error("La descripción corta no puede superar 160 caracteres.");
  }

  return {
    category_id: categoryId,
    sku,
    internal_code: cleanText(input.internal_code),
    slug,
    name,
    brand: input.brand.trim(),
    vehicle_brand: normalizeVehicleBrand(input.vehicle_brand),
    vehicle_model: normalizeVehicleModel(input.vehicle_model),
    vehicle_year_start: input.vehicle_year_start ? positiveInteger(input.vehicle_year_start) : null,
    vehicle_year_end: input.vehicle_year_end ? positiveInteger(input.vehicle_year_end) : null,
    short_description: shortDescription,
    description: input.description.trim(),
    features: cleanText(input.features),
    specifications: cleanText(input.specifications),
    compatibility_notes: cleanText(input.compatibility_notes),
    stock: positiveInteger(input.stock),
    low_stock_threshold: positiveInteger(input.min_stock),
    min_stock: positiveInteger(input.min_stock),
    cost_price: positiveNumber(input.cost_price),
    retail_price: positiveNumber(input.retail_price),
    wholesale_price: positiveNumber(input.wholesale_price),
    wholesale_min_quantity: Math.max(1, positiveInteger(input.wholesale_min_quantity, 1)),
    tax_category: input.tax_category,
    tracks_inventory: Boolean(input.tracks_inventory),
    is_new: Boolean(input.is_new),
    status,
    active: status === "active" && input.active,
  };
}

function productCatalogPayload(payload: ProductDbPayload): Omit<ProductDbPayload, "stock"> {
  const { stock, ...catalogPayload } = payload;
  void stock;
  return catalogPayload;
}

export function imagePayload(images: ProductImageInput[]) {
  const validImages = images.filter((image) => cleanText(image.public_url)).slice(0, 5);
  const selectedPrimaryIndex = validImages.findIndex((image) => image.is_primary);
  const primaryIndex = selectedPrimaryIndex >= 0 ? selectedPrimaryIndex : 0;

  return validImages.map((image, index) => ({
    storage_bucket: "product-images",
    storage_path: cleanText(image.storage_path) ?? cleanText(image.public_id) ?? `products/import-${index}-${Date.now()}`,
    public_id: cleanText(image.public_id) ?? cleanText(image.storage_path),
    public_url: image.public_url.trim(),
    angle: cleanText(image.angle) ?? "principal",
    alt_text: cleanText(image.alt_text),
    sort_order: positiveInteger(image.sort_order, index),
    is_primary: index === primaryIndex,
  }));
}

export async function removeCloudinaryImages(publicIds: string[], context: Record<string, unknown>) {
  const uniquePublicIds = Array.from(new Set(publicIds.map((value) => value.trim()).filter(Boolean)));
  if (uniquePublicIds.length === 0) return [];

  const supabase = await getSupabaseServerClient();
  const [publicIdReferences, storagePathReferences] = await Promise.all([
    supabase.from("product_images").select("public_id, storage_path").in("public_id", uniquePublicIds),
    supabase.from("product_images").select("public_id, storage_path").in("storage_path", uniquePublicIds),
  ]);
  const referenceError = publicIdReferences.error ?? storagePathReferences.error;
  if (referenceError) {
    await writeErrorLog({
      route: "/admin/productos",
      action: "products.cloudinary_reference_check_failed",
      errorMessage: referenceError.message,
      metadata: context,
    });
    return [];
  }

  const referencedAssets = new Set(
    [...(publicIdReferences.data ?? []), ...(storagePathReferences.data ?? [])]
      .flatMap((image) => [image.public_id, image.storage_path])
      .filter((value): value is string => Boolean(value)),
  );
  const deletablePublicIds = uniquePublicIds.filter((publicId) => !referencedAssets.has(publicId));
  if (deletablePublicIds.length === 0) return [];

  let cloudinary: ReturnType<typeof configureCloudinary>;
  try {
    cloudinary = configureCloudinary();
  } catch (error) {
    await writeErrorLog({
      route: "/admin/productos",
      action: "products.cloudinary_config_missing",
      errorMessage: "No se pudo configurar Cloudinary para eliminar imágenes antiguas.",
      errorStack: error instanceof Error ? error.stack : null,
      metadata: context,
    });
    return [];
  }

  const deletedAssets = await Promise.all(deletablePublicIds.map(async (publicId) => {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
      return publicId;
    } catch (error) {
      await writeErrorLog({
        route: "/admin/productos",
        action: "products.cloudinary_delete_failed",
        errorMessage: error instanceof Error ? error.message : "No se pudo eliminar la imagen en Cloudinary.",
        errorStack: error instanceof Error ? error.stack : null,
        metadata: { ...context, public_id: publicId },
      });
      return null;
    }
  }));
  return deletedAssets.filter((publicId): publicId is string => Boolean(publicId));
}

function correlationIdFromRequest(requestId?: string) {
  return requestId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
    ? requestId
    : randomUUID();
}

export async function saveProductCanonical(
  input: ProductFormInput,
  options: { requestId?: string } = {},
): Promise<ProductSaveResult> {
  const correlationId = correlationIdFromRequest(options.requestId);
  const requiredCapability = input.id ? "update" : "create";
  let profile: Awaited<ReturnType<typeof getSessionProfile>>;

  try {
    profile = await getSessionProfile();
  } catch (error) {
    await writeErrorLog({
      route: "/admin/productos",
      action: "products.authorization_check_failed",
      errorMessage: error instanceof Error ? error.message : "No se pudo verificar la sesión.",
      errorStack: error instanceof Error ? error.stack : null,
      errorCode: "PRODUCT_AUTH_CHECK_FAILED",
      metadata: { correlation_id: correlationId },
    }).catch(() => undefined);
    return { ok: false, code: "PRODUCT_WRITE_FAILED", message: `No se pudo verificar la sesión. Referencia: ${correlationId}.`, correlationId, stage: "authorization" };
  }

  if (!profile) {
    return { ok: false, code: "AUTHENTICATION_REQUIRED", message: "La sesión terminó. Inicia sesión nuevamente; el producto no fue guardado.", correlationId, stage: "authorization" };
  }

  const capabilities = getProductCapabilities(profile);
  if (!capabilities[requiredCapability]) {
    return { ok: false, code: "PERMISSION_DENIED", message: "No tienes permiso para guardar este producto.", correlationId, stage: "authorization" };
  }

  const safeImages = Array.isArray(input.images)
    ? input.images.filter(
        (image): image is ProductImageInput => Boolean(image) && typeof image === "object",
      )
    : [];
  const candidateAssetIds = capabilities.manageImages
    ? safeImages.map((image) => image.public_id ?? image.storage_path).filter((value): value is string => Boolean(value))
    : [];
  const compensateCandidateAssets = (reason: string) => removeCloudinaryImages(candidateAssetIds, {
    product_id: input.id ?? null,
    reason,
    correlation_id: correlationId,
  }).catch(() => undefined);

  let payload: ProductDbPayload;
  try {
    payload = productPayload(input);
  } catch (error) {
    await compensateCandidateAssets("product_validation_failed");
    return { ok: false, code: "VALIDATION_FAILED", message: friendlyProductError(error instanceof Error ? error.message : "Revisa los datos del producto."), correlationId, stage: "validation" };
  }

  let supabase: Awaited<ReturnType<typeof getSupabaseServerClient>>;
  try {
    supabase = await getSupabaseServerClient();
  } catch (error) {
    await writeErrorLog({
      route: "/admin/productos",
      action: "products.database_client_failed",
      errorMessage: error instanceof Error ? error.message : "No se pudo iniciar la operación de guardado.",
      errorStack: error instanceof Error ? error.stack : null,
      errorCode: "PRODUCT_DATABASE_CLIENT_FAILED",
      metadata: { correlation_id: correlationId, actor_role: profile.role, stage: "database_write" },
    }).catch(() => undefined);
    return { ok: false, code: "PRODUCT_WRITE_FAILED", message: `No se pudo iniciar el guardado. Referencia: ${correlationId}.`, correlationId, stage: "database_write" };
  }

  const { data: category, error: categoryError } = await supabase
    .from("categories")
    .select("name, slug, active")
    .eq("id", payload.category_id)
    .maybeSingle<{ name: string; slug: string; active: boolean }>();
  if (categoryError) {
    await compensateCandidateAssets("product_category_check_failed");
    await writeErrorLog({
      route: "/admin/productos",
      action: "products.category_validation_failed",
      errorMessage: categoryError.message,
      errorCode: categoryError.code,
      metadata: { correlation_id: correlationId, product_id: input.id ?? null, actor_role: profile.role },
    }).catch(() => undefined);
    return { ok: false, code: "PRODUCT_WRITE_FAILED", message: `No se pudo validar la categoría. Referencia: ${correlationId}.`, correlationId, stage: "database_write" };
  }
  if (!isOfficialProductCategory(category)) {
    await compensateCandidateAssets("product_category_invalid");
    return { ok: false, code: "CATEGORY_INVALID", message: "Selecciona una categoría oficial y activa para guardar el producto.", correlationId, stage: "validation" };
  }

  const catalogPayload = productCatalogPayload(payload);
  let authorizedTargetStock: number | null;
  try {
    authorizedTargetStock = capabilities.adjustStock ? stockIntegerForAdjustment(input.stock) : null;
  } catch (error) {
    await compensateCandidateAssets("product_stock_validation_failed");
    return { ok: false, code: "VALIDATION_FAILED", message: error instanceof Error ? error.message : "El stock no es válido.", correlationId, stage: "validation" };
  }

  let data: unknown = null;
  let rpcError: { code?: string; message: string } | null = null;
  try {
    const response = await supabase.rpc("save_product_catalog_v3_locked", {
      target_product_id: input.id ?? null,
      product_data: catalogPayload,
      images_data: capabilities.manageImages ? imagePayload(safeImages) : null,
      target_stock: authorizedTargetStock,
    });
    data = response.data;
    rpcError = response.error;
  } catch (error) {
    rpcError = { code: undefined, message: error instanceof Error ? error.message : "No se recibió respuesta del guardado." };
  }

  if (rpcError) {
    const duplicate = rpcError.code === "23505" || rpcError.message.toLowerCase().includes("duplicate key");
    const unconfirmed = !rpcError.code || rpcError.code.startsWith("PGRST0");
    if (!unconfirmed) await compensateCandidateAssets("product_save_compensation");
    await writeErrorLog({
      route: "/admin/productos",
      action: unconfirmed ? "products.save_unconfirmed" : "products.save_failed",
      errorMessage: rpcError.message,
      errorCode: rpcError.code,
      metadata: { correlation_id: correlationId, product_id: input.id ?? null, stage: "database_write", actor_role: profile.role, rpc_name: "save_product_catalog_v3_locked" },
    }).catch(() => undefined);
    return {
      ok: false,
      code: unconfirmed ? "PRODUCT_WRITE_UNCONFIRMED" : duplicate ? "DUPLICATE_PRODUCT" : "PRODUCT_WRITE_FAILED",
      message: unconfirmed
        ? `No se pudo confirmar el resultado. Revisa la lista antes de reintentar. Referencia: ${correlationId}.`
        : duplicate
          ? friendlyProductError(rpcError.message)
          : `No se pudo guardar el producto. Revisa los datos e intenta nuevamente. Referencia: ${correlationId}.`,
      correlationId,
      stage: "database_write",
    };
  }

  const saved = (Array.isArray(data) ? data[0] : data) as ProductCatalogSaveRpcResult | null;
  if (!saved?.product_id) {
    await writeErrorLog({
      route: "/admin/productos",
      action: "products.save_response_unconfirmed",
      errorMessage: "El RPC terminó sin devolver product_id.",
      errorCode: "PRODUCT_WRITE_UNCONFIRMED",
      metadata: { correlation_id: correlationId, product_id: input.id ?? null },
    }).catch(() => undefined);
    return { ok: false, code: "PRODUCT_WRITE_UNCONFIRMED", message: `No se pudo confirmar el resultado. Revisa la lista antes de reintentar. Referencia: ${correlationId}.`, correlationId, stage: "database_write" };
  }

  const postSave = await runProductPostSaveTasks([
    {
      stage: "asset_cleanup",
      run: () => removeCloudinaryImages(saved.removed_asset_ids ?? [], { product_id: saved.product_id, reason: "product_images_replaced", correlation_id: correlationId }).then(() => undefined),
      onFailure: (cleanupError) => writeErrorLog({
        route: "/admin/productos",
        action: "products.post_save_asset_cleanup_failed",
        errorMessage: cleanupError instanceof Error ? cleanupError.message : "Falló la limpieza posterior al guardado.",
        errorStack: cleanupError instanceof Error ? cleanupError.stack : null,
        errorCode: "PRODUCT_POST_SAVE_CLEANUP_FAILED",
        metadata: { correlation_id: correlationId, product_id: saved.product_id, actor_role: profile.role },
      }),
    },
    {
      stage: "audit",
      run: async () => {
        const auditWritten = await writeAuditLog({
          tableName: "products",
          recordId: saved.product_id,
          action: input.id ? "product.updated" : "product.created",
          oldData: input.id ? { stock: capabilities.adjustStock ? saved.stock_before : "preserved" } : null,
          newData: {
            ...catalogPayload,
            stock: capabilities.adjustStock ? saved.stock_after : input.id ? "preserved" : 0,
            stock_adjustment_authorized: capabilities.adjustStock,
            stock_movement_id: saved.stock_movement_id,
            images_updated: capabilities.manageImages,
            correlation_id: correlationId,
          },
        });
        if (!auditWritten) throw new Error("El registro de auditoría fue rechazado.");
      },
      onFailure: (auditError) => writeErrorLog({
        route: "/admin/productos",
        action: "products.post_save_audit_failed",
        errorMessage: auditError instanceof Error ? auditError.message : "Falló la auditoría posterior al guardado.",
        errorStack: auditError instanceof Error ? auditError.stack : null,
        errorCode: "PRODUCT_POST_SAVE_AUDIT_FAILED",
        metadata: { correlation_id: correlationId, product_id: saved.product_id, actor_role: profile.role },
      }),
    },
    {
      stage: "cache_revalidation",
      run: markProductAvailabilityStale,
      onFailure: (refreshError) => writeErrorLog({
        route: "/admin/productos",
        action: "products.post_save_revalidation_failed",
        errorMessage: refreshError instanceof Error ? refreshError.message : "Falló la revalidación posterior al guardado.",
        errorStack: refreshError instanceof Error ? refreshError.stack : null,
        errorCode: "PRODUCT_POST_SAVE_REVALIDATION_FAILED",
        metadata: { correlation_id: correlationId, product_id: saved.product_id, actor_role: profile.role },
      }),
    },
  ]);

  const refreshPending = postSave.failedStages.includes("cache_revalidation");
  const postSaveWarning = postSave.failedStages.length > 0;
  const stockMessage = capabilities.adjustStock ? "" : input.id ? " El stock y las reservas se conservaron sin cambios." : " El producto se creó con stock 0.";
  return {
    ok: true,
    code: refreshPending ? "PRODUCT_SAVED_REFRESH_PENDING" : postSaveWarning ? "PRODUCT_SAVED_POST_SAVE_WARNING" : input.id ? "PRODUCT_UPDATED" : "PRODUCT_CREATED",
    message: postSaveWarning
      ? `${input.id ? "Producto actualizado" : "Producto creado"} correctamente. Una tarea posterior requiere revisión; no repitas el guardado. Referencia: ${correlationId}.${stockMessage}`
      : `${input.id ? "Producto actualizado" : "Producto creado"} correctamente.${stockMessage}`,
    productId: saved.product_id,
    slug: payload.slug,
    correlationId,
  };
}
