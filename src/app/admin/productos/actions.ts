"use server";

import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { writeAuditLog } from "@/lib/audit";
import { getProductCapabilities, requireProductCapability } from "@/lib/auth/product-access";
import { getSessionProfile } from "@/lib/auth/session";
import { configureCloudinary } from "@/lib/cloudinary";
import { writeErrorLog } from "@/lib/error-logging";
import { markProductAvailabilityStale, revalidateProductAvailability } from "@/lib/product-availability-cache";
import { isOfficialProductCategory } from "@/lib/product-categories";
import { runProductPostSaveTasks } from "@/lib/product-create-hardening";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { productTaxCategorySchema } from "@/lib/validation/product-tax";
import type { ProductFormInput, ProductImageInput, ProductStatus, ProductTaxCategory } from "@/types/products";
import {
  formatMegapixels,
  isAllowedProductImageMimeType,
  productImageGenericLimitMessage,
  productImageInvalidFormatMessage,
  productImageMaxBytes,
  productImageMaxDisplayDimension,
  productImageMaxPixels,
  productImageTooLargeMessage,
  productImageTooManyPixelsMessage,
} from "@/utils/product-image-rules";
import { normalizeVehicleBrand, normalizeVehicleModel } from "@/utils/vehicle-compatibility";
import {
  MAX_PRODUCT_IMPORT_ROWS,
  MAX_PRODUCT_XLSX_BYTES,
  validateProductImportLimits,
} from "@/utils/product-import-limits";
import {
  parseRequiredStockInteger,
  productImportBatchSize,
  readProductImportWorksheet,
  type ProductImportSummaryCounters,
} from "@/utils/product-import-stock";

type ProductMutationResult = {
  ok: boolean;
  message: string;
};

export type ProductSaveActionResult =
  | {
      ok: true;
      code:
        | "PRODUCT_CREATED"
        | "PRODUCT_UPDATED"
        | "PRODUCT_SAVED_REFRESH_PENDING"
        | "PRODUCT_SAVED_POST_SAVE_WARNING";
      message: string;
      productId: string;
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

export type ProductImportMode = "create_and_update" | "create_only" | "update_only";

export type ProductImportRowResult = {
  rowNumber: number;
  sku: string;
  status: "created" | "updated" | "skipped" | "failed";
  stockProcessed: boolean;
  stockApplied: boolean;
  stockUnchanged: boolean;
  movementId: string | null;
  stockBefore: number | null;
  stockAfter: number | null;
  quantity: number | null;
  consumedAssetIds: string[];
  error: string | null;
};

export type ProductImportSummary = ProductImportSummaryCounters;

export type ProductImportResult = ProductMutationResult & {
  summary: ProductImportSummary;
  rows: ProductImportRowResult[];
  pendingRows: Array<{ rowNumber: number; sku: string }>;
  failedBatchNumber: number | null;
  totalBatches: number;
};

export type ProductImportSkuStatusResult = ProductMutationResult & {
  existingSkus?: string[];
};

export type ProductImportPreflightResult = ProductMutationResult & {
  batchId?: string;
  totalRows?: number;
};

type ProductImageUploadResult = ProductMutationResult & {
  publicUrl?: string;
  storagePath?: string;
  publicId?: string;
};

type ProductHistoryCounts = {
  orderItems: number;
  invoiceItems: number;
  inventoryMovements: number;
};

type ProductCatalogSaveRpcResult = {
  product_id: string;
  removed_asset_ids: string[] | null;
  stock_movement_id: string | null;
  stock_before: number;
  stock_after: number;
  stock_quantity: number;
};

type ProductImportRowRpcResult = {
  product_id: string | null;
  row_status: "created" | "updated" | "skipped";
  stock_applied: boolean;
  stock_unchanged: boolean;
  movement_id: string | null;
  stock_before: number | null;
  stock_after: number | null;
  quantity: number | null;
  removed_asset_ids: string[] | null;
  consumed_asset_ids: string[] | null;
};

type StagedProductImportRow = {
  row_number: number;
  normalized_data: { sku?: unknown } | null;
  apply_status: string;
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

function slugify(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function cleanText(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeImportHeader(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function importRowSku(row: Record<string, unknown>) {
  const entry = Object.entries(row).find(([header]) => normalizeImportHeader(header) === "sku");
  return String(entry?.[1] ?? "").trim().toUpperCase();
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
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.value;
}

function revalidateProductCatalog(slug?: string | null) {
  revalidateProductAvailability({
    adminPaths: ["/admin/productos", "/admin/inventario", "/admin/reportes"],
    productSlugs: [slug],
  });
}

function friendlyProductError(message: string) {
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

function productPayload(input: ProductFormInput): ProductDbPayload {
  const sku = input.sku.trim().toUpperCase();
  const name = input.name.trim();
  const status = input.active ? input.status : "inactive";
  const slug = cleanText(input.slug) ?? slugify(`${sku}-${name}`);
  const categoryId = cleanText(input.category_id);

  if (!sku || !name || !input.brand.trim()) {
    throw new Error("SKU, nombre y marca son obligatorios.");
  }

  if (!categoryId) {
    throw new Error("Selecciona una categoría para guardar el producto.");
  }

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
  if (Number(input.retail_price) <= 0) {
    throw new Error("El precio al detalle debe ser mayor que cero.");
  }

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

function imagePayload(images: ProductImageInput[]) {
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

async function removeCloudinaryImages(publicIds: string[], context: Record<string, unknown>) {
  const uniquePublicIds = Array.from(new Set(publicIds.map((value) => value.trim()).filter(Boolean)));

  if (uniquePublicIds.length === 0) {
    return [];
  }
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
  if (deletablePublicIds.length === 0) {
    return [];
  }

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

  const deletedAssets = await Promise.all(
    deletablePublicIds.map(async (publicId) => {
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
    }),
  );
  return deletedAssets.filter((publicId): publicId is string => Boolean(publicId));
}

export async function uploadProductImageAction(formData: FormData): Promise<ProductImageUploadResult> {
  const profile = await requireProductCapability("manageImages");

  try {
    const cloudinary = configureCloudinary();

    const file = formData.get("file");
    const productSlug = String(formData.get("productSlug") ?? "producto").trim() || "producto";
    const angle = String(formData.get("angle") ?? "principal").trim() || "principal";

    if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Selecciona una imagen válida antes de subirla." };
    }

    if (!isAllowedProductImageMimeType(file.type)) {
      return { ok: false, message: productImageInvalidFormatMessage };
    }

    if (file.size > productImageMaxBytes) {
      return { ok: false, message: productImageTooLargeMessage };
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    let optimizedBuffer: Buffer;
    let width = 0;
    let height = 0;

    try {
      const metadata = await sharp(buffer, { animated: false, limitInputPixels: productImageMaxPixels + 1 })
        .rotate()
        .metadata();
      width = metadata.width ?? 0;
      height = metadata.height ?? 0;

      if (!width || !height) {
        return { ok: false, message: productImageInvalidFormatMessage };
      }

      if (width * height > productImageMaxPixels) {
        return { ok: false, message: productImageTooManyPixelsMessage };
      }

      optimizedBuffer = await sharp(buffer, { animated: false })
        .rotate()
        .resize({
          width: productImageMaxDisplayDimension,
          height: productImageMaxDisplayDimension,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 82, effort: 5 })
        .toBuffer();
    } catch (error) {
      const message =
        error instanceof Error && error.message.toLowerCase().includes("pixel")
          ? productImageTooManyPixelsMessage
          : productImageInvalidFormatMessage;
      return { ok: false, message };
    }

    const folder = `car-zone/productos/${slugify(productSlug) || "producto"}`;
    const publicId = `${angle}-${Date.now()}`;

    const result = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: publicId,
          resource_type: "image",
          format: "webp",
          overwrite: true,
          invalidate: true,
          context: {
            source: "product_admin",
            original_bytes: String(file.size),
            original_megapixels: String(formatMegapixels(width, height)),
            optimized_bytes: String(optimizedBuffer.length),
          },
        },
        (error, uploadResult) => {
          if (error || !uploadResult?.secure_url || !uploadResult.public_id) {
            reject(error ?? new Error("Cloudinary no devolvio una URL valida."));
            return;
          }

          resolve({
            secure_url: uploadResult.secure_url,
            public_id: uploadResult.public_id,
          });
        },
      );

      stream.end(optimizedBuffer);
    });

    return {
      ok: true,
      message: "Imagen optimizada y subida correctamente.",
      publicUrl: result.secure_url,
      storagePath: result.public_id,
      publicId: result.public_id,
    };
  } catch (error) {
    const result = {
      ok: false,
      message:
        error instanceof Error
          ? `No se pudo subir la imagen: ${error.message}`
          : productImageGenericLimitMessage,
    };

    await writeErrorLog({
      route: "/admin/productos",
      action: "products.image_upload_failed",
      errorMessage: result.message,
      errorStack: error instanceof Error ? error.stack : null,
      metadata: {
        user_id: profile.id,
        product_slug: String(formData.get("productSlug") ?? ""),
        file_name: formData.get("file") instanceof File ? (formData.get("file") as File).name : null,
      },
    });

    return result;
  }
}

export async function deleteUploadedProductImageAction(publicId: string): Promise<ProductMutationResult> {
  await requireProductCapability("manageImages");

  const cleanPublicId = cleanText(publicId);
  if (!cleanPublicId) {
    return { ok: true, message: "Imagen omitida." };
  }

  await removeCloudinaryImages([cleanPublicId], { reason: "unsaved_product_image_removed" });
  return { ok: true, message: "Imagen eliminada correctamente." };
}

export async function saveProductAction(input: ProductFormInput): Promise<ProductSaveActionResult> {
  const correlationId = randomUUID();
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
    return {
      ok: false,
      code: "PRODUCT_WRITE_FAILED",
      message: `No se pudo verificar la sesión. Referencia: ${correlationId}.`,
      correlationId,
      stage: "authorization",
    };
  }

  if (!profile) {
    return {
      ok: false,
      code: "AUTHENTICATION_REQUIRED",
      message: "La sesión terminó. Inicia sesión nuevamente; el producto no fue guardado.",
      correlationId,
      stage: "authorization",
    };
  }

  const capabilities = getProductCapabilities(profile);
  if (!capabilities[requiredCapability]) {
    return {
      ok: false,
      code: "PERMISSION_DENIED",
      message: "No tienes permiso para guardar este producto.",
      correlationId,
      stage: "authorization",
    };
  }

  const safeImages = Array.isArray(input.images) ? input.images : [];
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
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      message: friendlyProductError(error instanceof Error ? error.message : "Revisa los datos del producto."),
      correlationId,
      stage: "validation",
    };
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
    return {
      ok: false,
      code: "PRODUCT_WRITE_FAILED",
      message: `No se pudo iniciar el guardado. Referencia: ${correlationId}.`,
      correlationId,
      stage: "database_write",
    };
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
    return {
      ok: false,
      code: "PRODUCT_WRITE_FAILED",
      message: `No se pudo validar la categoría. Referencia: ${correlationId}.`,
      correlationId,
      stage: "database_write",
    };
  }
  if (!isOfficialProductCategory(category)) {
    await compensateCandidateAssets("product_category_invalid");
    return {
      ok: false,
      code: "CATEGORY_INVALID",
      message: "Selecciona una categoría oficial y activa para guardar el producto.",
      correlationId,
      stage: "validation",
    };
  }

  const catalogPayload = productCatalogPayload(payload);
  let authorizedTargetStock: number | null;
  try {
    authorizedTargetStock = capabilities.adjustStock ? stockIntegerForAdjustment(input.stock) : null;
  } catch (error) {
    await compensateCandidateAssets("product_stock_validation_failed");
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      message: error instanceof Error ? error.message : "El stock no es válido.",
      correlationId,
      stage: "validation",
    };
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
    rpcError = {
      code: undefined,
      message: error instanceof Error ? error.message : "No se recibió respuesta del guardado.",
    };
  }

  if (rpcError) {
    const duplicate = rpcError.code === "23505" || rpcError.message.toLowerCase().includes("duplicate key");
    const unconfirmed = !rpcError.code || rpcError.code.startsWith("PGRST0");
    if (!unconfirmed) {
      await compensateCandidateAssets("product_save_compensation");
    }
    await writeErrorLog({
      route: "/admin/productos",
      action: unconfirmed ? "products.save_unconfirmed" : "products.save_failed",
      errorMessage: rpcError.message,
      errorCode: rpcError.code,
      metadata: {
        correlation_id: correlationId,
        product_id: input.id ?? null,
        stage: "database_write",
        actor_role: profile.role,
        rpc_name: "save_product_catalog_v3_locked",
      },
    }).catch(() => undefined);
    return {
      ok: false,
      code: unconfirmed
        ? "PRODUCT_WRITE_UNCONFIRMED"
        : duplicate
          ? "DUPLICATE_PRODUCT"
          : "PRODUCT_WRITE_FAILED",
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
    return {
      ok: false,
      code: "PRODUCT_WRITE_UNCONFIRMED",
      message: `No se pudo confirmar el resultado. Revisa la lista antes de reintentar. Referencia: ${correlationId}.`,
      correlationId,
      stage: "database_write",
    };
  }

  const postSave = await runProductPostSaveTasks([
    {
      stage: "asset_cleanup",
      run: () => removeCloudinaryImages(saved.removed_asset_ids ?? [], {
        product_id: saved.product_id,
        reason: "product_images_replaced",
        correlation_id: correlationId,
      }).then(() => undefined),
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

  const stockMessage = capabilities.adjustStock
    ? ""
    : input.id
      ? " El stock y las reservas se conservaron sin cambios."
      : " El producto se creó con stock 0.";
  return {
    ok: true,
    code: refreshPending
      ? "PRODUCT_SAVED_REFRESH_PENDING"
      : postSaveWarning
        ? "PRODUCT_SAVED_POST_SAVE_WARNING"
      : input.id
        ? "PRODUCT_UPDATED"
        : "PRODUCT_CREATED",
    message: postSaveWarning
      ? `${input.id ? "Producto actualizado" : "Producto creado"} correctamente. Una tarea posterior requiere revisión; no repitas el guardado. Referencia: ${correlationId}.${stockMessage}`
      : `${input.id ? "Producto actualizado" : "Producto creado"} correctamente.${stockMessage}`,
    productId: saved.product_id,
    correlationId,
  };
}

export async function setProductActiveAction(id: string, active: boolean): Promise<ProductMutationResult> {
  await requireProductCapability("update");

  const supabase = await getSupabaseServerClient();
  const { data: product, error } = await supabase
    .from("products")
    .update({
      active,
      status: active ? "active" : "inactive",
    })
    .eq("id", id)
    .select("id, slug, stock, reserved_stock, available_stock, active, status, auto_disabled_by_stock")
    .single<{
      id: string;
      slug: string;
      stock: number;
      reserved_stock: number;
      available_stock: number;
      active: boolean;
      status: string;
      auto_disabled_by_stock: boolean;
    }>();

  if (error) {
    return { ok: false, message: friendlyProductError(error.message) };
  }

  await writeAuditLog({
    tableName: "products",
    recordId: id,
    action: active ? "product.manually_activated" : "product.manually_deactivated",
    newData: {
      requested_active: active,
      active: product.active,
      status: product.status,
      stock: product.stock,
      reserved_stock: product.reserved_stock,
      available_stock: product.available_stock,
      auto_disabled_by_stock: product.auto_disabled_by_stock,
      origin: "product_admin",
    },
  });

  revalidateProductCatalog(product.slug);
  if (active && !product.active && product.auto_disabled_by_stock) {
    return {
      ok: true,
      message: "El producto no tiene inventario disponible y permanecera inactivo hasta que vuelva a tener existencias.",
    };
  }

  return { ok: true, message: active ? "Producto activado correctamente." : "Producto desactivado correctamente." };
}

function isTestProduct(product: { sku: string | null; name: string | null; slug: string | null; internal_code: string | null }) {
  return [product.sku, product.name, product.slug, product.internal_code].some((value) => /\btest\b|^test-|test-|prueba/i.test(value ?? ""));
}

async function getProductHistoryCounts(productId: string): Promise<ProductHistoryCounts> {
  const supabase = await getSupabaseServerClient();
  const [orderItems, invoiceItems, inventoryMovements] = await Promise.all([
    supabase.from("order_items").select("id", { count: "exact", head: true }).eq("product_id", productId),
    supabase.from("invoice_items").select("id", { count: "exact", head: true }).eq("product_id", productId),
    supabase.from("inventory_movements").select("id", { count: "exact", head: true }).eq("product_id", productId),
  ]);

  const error = orderItems.error ?? invoiceItems.error ?? inventoryMovements.error;
  if (error) {
    throw new Error(error.message);
  }

  return {
    orderItems: orderItems.count ?? 0,
    invoiceItems: invoiceItems.count ?? 0,
    inventoryMovements: inventoryMovements.count ?? 0,
  };
}

function hasProductHistory(history: ProductHistoryCounts) {
  return history.orderItems > 0 || history.invoiceItems > 0 || history.inventoryMovements > 0;
}

export async function deleteProductAction(id: string, confirmation?: string): Promise<ProductMutationResult> {
  await requireProductCapability("deleteProducts");

  const supabase = await getSupabaseServerClient();
  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id, sku, internal_code, name, slug")
    .eq("id", id)
    .maybeSingle<{ id: string; sku: string | null; internal_code: string | null; name: string | null; slug: string | null }>();

  if (productError) {
    return { ok: false, message: friendlyProductError(productError.message) };
  }

  if (!product) {
    return { ok: false, message: "No encontramos el producto que intentas eliminar." };
  }

  const history = await getProductHistoryCounts(id);
  const testProduct = isTestProduct(product);
  const hasFiscalOrSalesHistory = history.orderItems > 0 || history.invoiceItems > 0;

  if (hasProductHistory(history) && (!testProduct || confirmation !== "ELIMINAR TEST" || hasFiscalOrSalesHistory)) {
    await writeAuditLog({
      tableName: "products",
      recordId: id,
      action: "product.delete_blocked_history",
      newData: { history, test_product: testProduct },
    });

    return {
      ok: false,
      message:
        "Este producto no puede eliminarse porque tiene historial relacionado. Puedes desactivarlo para que no aparezca en la tienda.",
    };
  }

  if (testProduct && confirmation === "ELIMINAR TEST" && !hasFiscalOrSalesHistory) {
    await supabase.from("inventory_movements").delete().eq("product_id", id);
  }

  const { data: images } = await supabase
    .from("product_images")
    .select("public_id, storage_path")
    .eq("product_id", id)
    .returns<Array<{ public_id: string | null; storage_path: string | null }>>();

  const { error } = await supabase.from("products").delete().eq("id", id);

  if (error) {
    const message =
      error.message.includes("foreign key constraint") || error.message.includes("inventory_movements_product_id_fkey")
        ? "Este producto no puede eliminarse porque tiene historial relacionado. Puedes desactivarlo para que no aparezca en la tienda."
        : friendlyProductError(error.message);

    await writeAuditLog({
      tableName: "products",
      recordId: id,
      action: "product.delete_failed",
      newData: { history, error: error.message },
    });

    return { ok: false, message };
  }

  await removeCloudinaryImages(
    (images ?? []).map((image) => image.public_id ?? image.storage_path).filter((publicId): publicId is string => Boolean(publicId)),
    { product_id: id, reason: "product_deleted" },
  );

  await writeAuditLog({
    tableName: "products",
    recordId: id,
    action: testProduct ? "product.test_deleted" : "product.deleted",
    oldData: { ...product, history },
  });

  revalidateProductCatalog();
  return { ok: true, message: "Producto eliminado correctamente." };
}

export async function preflightProductImportFileAction(formData: FormData): Promise<ProductImportPreflightResult> {
  const profile = await requireProductCapability("importProducts");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Selecciona un archivo Excel .xlsx con productos." };
  }
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return { ok: false, message: "Selecciona un archivo Excel .xlsx. El formato .xls binario no es compatible." };
  }

  const byteLimit = validateProductImportLimits({ bytes: file.size });
  if (!byteLimit.ok) {
    return { ok: false, message: byteLimit.message };
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.byteLength > MAX_PRODUCT_XLSX_BYTES) {
      return { ok: false, message: validateProductImportLimits({ bytes: buffer.byteLength }).message ?? "El archivo es demasiado grande." };
    }

    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);
    const worksheet = workbook.worksheets[0] ?? null;
    const { rows } = readProductImportWorksheet(worksheet);
    if (rows.length === 0) {
      return { ok: false, message: "El Excel está vacío o no tiene filas de productos." };
    }
    const rowLimit = validateProductImportLimits({ rows: rows.length });
    if (!rowLimit.ok) {
      return { ok: false, message: rowLimit.message };
    }

    const stagedRows = rows.map((row, index) => ({
      row_number: index + 2,
      sku: importRowSku(row),
    }));
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase.rpc("create_product_import_preflight", {
      file_name: file.name,
      file_bytes: buffer.byteLength,
      file_sha256: createHash("sha256").update(buffer).digest("hex"),
      row_payload: stagedRows,
    });
    if (error) {
      return { ok: false, message: friendlyProductError(error.message) };
    }

    const batchId = String(data ?? "");
    await writeAuditLog({
      tableName: "import_batches",
      recordId: batchId,
      action: "products.import_preflight_validated",
      newData: {
        batch_id: batchId,
        imported_by: profile.id,
        file_name: file.name,
        file_bytes: buffer.byteLength,
        total_rows: rows.length,
      },
    });
    return {
      ok: true,
      message: `Archivo validado en servidor: ${rows.length.toLocaleString("es-HN")} productos.`,
      batchId,
      totalRows: rows.length,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? `No se pudo validar el Excel en servidor: ${error.message}` : "No se pudo validar el Excel en servidor.",
    };
  }
}

export async function getProductImportSkuStatusAction(skus: string[]): Promise<ProductImportSkuStatusResult> {
  await requireProductCapability("importProducts");
  const supabase = await getSupabaseServerClient();

  const normalizedSkus = Array.from(new Set(skus.map((sku) => sku.trim().toUpperCase()).filter(Boolean))).slice(0, 5000);
  if (normalizedSkus.length === 0) {
    return { ok: true, message: "Sin SKU para validar.", existingSkus: [] };
  }

  const { data, error } = await supabase.from("products").select("sku").in("sku", normalizedSkus);

  if (error) {
    return { ok: false, message: friendlyProductError(error.message), existingSkus: [] };
  }

  return {
    ok: true,
    message: "SKU validados correctamente.",
    existingSkus: (data ?? []).map((row) => String(row.sku ?? "").toUpperCase()).filter(Boolean),
  };
}

export async function importProductsAction(
  products: ProductFormInput[],
  options: {
    batchId?: string;
    mode?: ProductImportMode;
    fileName?: string;
    imageSummary?: {
      uploaded: number;
      missing: number;
      errors: number;
    };
    rowNumbers?: number[];
  } = {},
): Promise<ProductImportResult> {
  const profile = await requireProductCapability("importProducts");
  const capabilities = getProductCapabilities(profile);
  const supabase = await getSupabaseServerClient();
  const mode = options.mode ?? "create_and_update";
  const requestedRows = Array.isArray(products) ? products.length : 0;
  const rows: ProductImportRowResult[] = [];
  const summary: ProductImportSummary = {
    requested: requestedRows,
    totalRows: requestedRows,
    sent: requestedRows,
    created: 0,
    updated: 0,
    skipped: 0,
    previewSkipped: 0,
    serverSkipped: 0,
    failed: 0,
    pending: 0,
    stockProcessed: 0,
    movementsCreated: 0,
    stockUnchanged: 0,
    orphanAssetsCleaned: 0,
  };

  if (!Array.isArray(products) || products.length === 0) {
    return {
      ok: false,
      message: "El archivo no contiene productos para importar.",
      summary,
      rows,
      pendingRows: [],
      failedBatchNumber: null,
      totalBatches: 1,
    };
  }

  const batchId = cleanText(options.batchId);
  if (!batchId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batchId)) {
    return {
      ok: false,
      message: "La importación no tiene un preflight server-side válido. Vuelve a validar el archivo.",
      summary,
      rows,
      pendingRows: products.map((product, index) => ({ rowNumber: options.rowNumbers?.[index] ?? index + 2, sku: String(product?.sku ?? "") })),
      failedBatchNumber: 1,
      totalBatches: 1,
    };
  }
  if (products.length > productImportBatchSize) {
    return {
      ok: false,
      message: `Cada lote puede contener como máximo ${productImportBatchSize} productos.`,
      summary,
      rows,
      pendingRows: products.map((product, index) => ({ rowNumber: options.rowNumbers?.[index] ?? index + 2, sku: String(product?.sku ?? "") })),
      failedBatchNumber: 1,
      totalBatches: 1,
    };
  }

  const { data: batch, error: batchError } = await supabase
    .from("import_batches")
    .select("id, module, status, created_by, total_rows, metadata")
    .eq("id", batchId)
    .eq("module", "products")
    .eq("created_by", profile.id)
    .maybeSingle();
  if (batchError || !batch || Number(batch.total_rows) < 1 || Number(batch.total_rows) > MAX_PRODUCT_IMPORT_ROWS) {
    return {
      ok: false,
      message: "El lote de importación no existe, expiró o supera el límite permitido. Vuelve a validar el archivo.",
      summary,
      rows,
      pendingRows: products.map((product, index) => ({ rowNumber: options.rowNumbers?.[index] ?? index + 2, sku: String(product?.sku ?? "") })),
      failedBatchNumber: 1,
      totalBatches: 1,
    };
  }

  const requestedRowNumbers = products.map((_, index) => Number(options.rowNumbers?.[index] ?? index + 2));
  if (
    requestedRowNumbers.some((rowNumber) => !Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > Number(batch.total_rows) + 1) ||
    new Set(requestedRowNumbers).size !== requestedRowNumbers.length
  ) {
    return {
      ok: false,
      message: "Las filas solicitadas no coinciden con el archivo validado en servidor.",
      summary,
      rows,
      pendingRows: products.map((product, index) => ({ rowNumber: requestedRowNumbers[index], sku: String(product?.sku ?? "") })),
      failedBatchNumber: 1,
      totalBatches: 1,
    };
  }

  const { data: stagedRows, error: stagedRowsError } = await supabase
    .from("import_rows")
    .select("row_number, normalized_data, apply_status")
    .eq("batch_id", batchId)
    .in("row_number", requestedRowNumbers)
    .returns<StagedProductImportRow[]>();
  const stagedByRow = new Map((stagedRows ?? []).map((row) => [row.row_number, row]));
  const stagedRowsMatch = !stagedRowsError && products.every((product, index) => {
    const staged = stagedByRow.get(requestedRowNumbers[index]);
    return String(staged?.normalized_data?.sku ?? "").trim().toUpperCase() === String(product?.sku ?? "").trim().toUpperCase();
  });
  if (!stagedRowsMatch) {
    return {
      ok: false,
      message: "El contenido del lote no coincide con las filas del XLSX validado en servidor.",
      summary,
      rows,
      pendingRows: products.map((product, index) => ({ rowNumber: requestedRowNumbers[index], sku: String(product?.sku ?? "") })),
      failedBatchNumber: 1,
      totalBatches: 1,
    };
  }

  const uploadedAssetIds = Array.from(
    new Set(
      products.flatMap((product) =>
        (Array.isArray(product?.images) ? product.images : [])
          .map((image) => cleanText(image.public_id) ?? cleanText(image.storage_path))
          .filter((assetId): assetId is string => Boolean(assetId)),
      ),
    ),
  );
  const consumedAssetIds = new Set<string>();
  const replacedAssetIds = new Set<string>();
  const skuCounts = products.reduce((counts, product) => {
    const sku = typeof product?.sku === "string" ? product.sku.trim().toUpperCase() : "";
    counts.set(sku, (counts.get(sku) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());

  async function writeBulkImportAudit(status: "completed" | "completed_with_errors") {
    await writeAuditLog({
      tableName: "products",
      action: "products.bulk_import",
      newData: {
        user_id: profile.id,
        imported_by: profile.id,
        user_role: profile.role,
        batch_id: batchId,
        status,
        mode,
        file_name: cleanText(options.fileName),
        requested: products.length,
        saved: summary.created + summary.updated,
        created: summary.created,
        updated: summary.updated,
        skipped: summary.skipped,
        failed: summary.failed,
        products_created: summary.created,
        products_updated: summary.updated,
        products_skipped: summary.skipped,
        products_failed: summary.failed,
        stock_processed: summary.stockProcessed,
        stock_movements_created: summary.movementsCreated,
        stock_unchanged: summary.stockUnchanged,
        orphan_assets_cleaned: summary.orphanAssetsCleaned,
        errors_count: summary.failed + (options.imageSummary?.errors ?? 0),
        images_uploaded: options.imageSummary?.uploaded ?? 0,
        images_missing: options.imageSummary?.missing ?? 0,
        image_summary: options.imageSummary ?? null,
        stock_columns_ignored: !capabilities.adjustStock,
        stock_adjustment_authorized: capabilities.adjustStock,
        rows,
        skus: products
          .map((product) => typeof product?.sku === "string" ? product.sku.trim().toUpperCase() : "")
          .filter(Boolean),
      },
    });
  }

  for (const [index, product] of products.entries()) {
    const providedRowNumber = options.rowNumbers?.[index];
    const rowNumber = Number.isInteger(providedRowNumber) && Number(providedRowNumber) >= 2
      ? Number(providedRowNumber)
      : index + 2;
    const sku = typeof product?.sku === "string" ? product.sku.trim().toUpperCase() : "";
    try {
      if (!sku) {
        throw new Error("El SKU es obligatorio.");
      }
      if ((skuCounts.get(sku) ?? 0) > 1) {
        throw new Error("El SKU está repetido dentro de la misma importación.");
      }
      let targetStock: number | null = null;
      if (capabilities.adjustStock) {
        if (!Object.prototype.hasOwnProperty.call(product, "stock")) {
          throw new Error("La propiedad Stock es obligatoria para usuarios autorizados.");
        }
        targetStock = stockIntegerForAdjustment(product.stock);
      }

      const payloadWithStock = productPayload(product);
      const { stock: catalogStock, ...catalogData } = payloadWithStock;
      void catalogStock;
      const images = capabilities.manageImages && product.images.length > 0 ? imagePayload(product.images) : null;
      const { data, error } = await supabase.rpc("import_product_batch_row_v3_atomic", {
        target_batch_id: batchId,
        target_row_number: rowNumber,
        product_data: catalogData,
        images_data: images,
        target_stock: targetStock,
        import_mode: mode,
      });

      if (error) {
        throw new Error(error.message);
      }

      const rpcResult = (Array.isArray(data) ? data[0] : data) as ProductImportRowRpcResult | null;
      if (!rpcResult) {
        throw new Error("La base de datos no devolvió el resultado de la fila.");
      }

      for (const assetId of rpcResult.consumed_asset_ids ?? []) {
        consumedAssetIds.add(assetId);
      }
      for (const assetId of rpcResult.removed_asset_ids ?? []) {
        replacedAssetIds.add(assetId);
      }

      if (rpcResult.row_status === "created") {
        summary.created += 1;
      } else if (rpcResult.row_status === "updated") {
        summary.updated += 1;
      } else {
        summary.skipped += 1;
        summary.serverSkipped += 1;
      }
      if (rpcResult.stock_applied) {
        summary.stockProcessed += 1;
      }
      if (rpcResult.movement_id) {
        summary.movementsCreated += 1;
      }
      if (rpcResult.stock_unchanged) {
        summary.stockUnchanged += 1;
      }

      rows.push({
        rowNumber,
        sku,
        status: rpcResult.row_status,
        stockProcessed: rpcResult.stock_applied,
        stockApplied: rpcResult.stock_applied,
        stockUnchanged: rpcResult.stock_unchanged,
        movementId: rpcResult.movement_id,
        stockBefore: rpcResult.stock_before,
        stockAfter: rpcResult.stock_after,
        quantity: rpcResult.quantity,
        consumedAssetIds: rpcResult.consumed_asset_ids ?? [],
        error: null,
      });
    } catch (error) {
      const message = friendlyProductError(error instanceof Error ? error.message : "No se pudo importar la fila.");
      await supabase
        .from("import_rows")
        .update({ apply_status: "failed", apply_error: message, audit_metadata: { batch_id: batchId, sku } })
        .eq("batch_id", batchId)
        .eq("row_number", rowNumber);
      summary.failed += 1;
      rows.push({
        rowNumber,
        sku,
        status: "failed",
        stockProcessed: false,
        stockApplied: false,
        stockUnchanged: false,
        movementId: null,
        stockBefore: null,
        stockAfter: null,
        quantity: null,
        consumedAssetIds: [],
        error: message,
      });
    }
  }

  await removeCloudinaryImages(Array.from(replacedAssetIds), {
    reason: "product_import_replaced_assets",
    user_id: profile.id,
  });
  const orphanAssetIds = uploadedAssetIds.filter((assetId) => !consumedAssetIds.has(assetId));
  const cleanedOrphanAssets = await removeCloudinaryImages(orphanAssetIds, {
    reason: "product_import_orphan_assets",
    user_id: profile.id,
    failed_rows: summary.failed,
  });
  summary.orphanAssetsCleaned = cleanedOrphanAssets.length;

  await writeBulkImportAudit(summary.failed > 0 ? "completed_with_errors" : "completed");
  await supabase.rpc("recount_import_batch", { target_batch_id: batchId });

  if (summary.created + summary.updated > 0) {
    revalidateProductCatalog();
  }
  const stockNotice = capabilities.adjustStock
    ? summary.stockProcessed +
      " valores de stock procesados, " +
      summary.movementsCreated +
      " movimientos y " +
      summary.stockUnchanged +
      " sin cambio."
    : "El stock del archivo fue ignorado porque el usuario no tiene permiso para ajustarlo.";
  return {
    ok: summary.failed === 0,
    message:
      "Importación por filas completada: " +
      summary.created +
      " creados, " +
      summary.updated +
      " actualizados, " +
      summary.skipped +
      " omitidos y " +
      summary.failed +
      " con error. " +
      stockNotice,
    summary,
    rows,
    pendingRows: [],
    failedBatchNumber: null,
    totalBatches: 1,
  };
}
