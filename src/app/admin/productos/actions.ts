"use server";

import sharp from "sharp";
import { writeAuditLog } from "@/lib/audit";
import { getProductCapabilities, requireProductCapability } from "@/lib/auth/product-access";
import { configureCloudinary } from "@/lib/cloudinary";
import { writeErrorLog } from "@/lib/error-logging";
import { revalidateProductAvailability } from "@/lib/product-availability-cache";
import { isOfficialProductCategory } from "@/lib/product-categories";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ProductFormInput, ProductImageInput, ProductStatus } from "@/types/products";
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
import { parseRequiredStockInteger, type ProductImportSummaryCounters } from "@/utils/product-import-stock";

type ProductMutationResult = {
  ok: boolean;
  message: string;
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

type ProductStockRpcResult = {
  movement_id: string | null;
  stock_before: number;
  stock_after: number;
  quantity: number;
};

type ProductCatalogSaveRpcResult = {
  product_id: string;
  removed_asset_ids: string[] | null;
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
    is_new: Boolean(input.is_new),
    status,
    active: status === "active" && input.active,
  };
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

async function setProductStockLocked(productId: string, nextStock: number): Promise<ProductStockRpcResult | null> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_product_stock_locked", {
    target_product_id: productId,
    target_stock: nextStock,
    movement_notes: "Ajuste desde el módulo de productos",
  });

  if (error) {
    throw new Error(error.message);
  }

  return (Array.isArray(data) ? data[0] : data) as ProductStockRpcResult | null;
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

export async function saveProductAction(input: ProductFormInput): Promise<ProductMutationResult> {
  const profile = await requireProductCapability(input.id ? "update" : "create");
  const capabilities = getProductCapabilities(profile);
  const candidateAssetIds = capabilities.manageImages
    ? input.images.map((image) => image.public_id ?? image.storage_path).filter((value): value is string => Boolean(value))
    : [];

  try {
    const supabase = await getSupabaseServerClient();
    const payload = productPayload(input);
    const { data: category, error: categoryError } = await supabase
      .from("categories")
      .select("name, slug, active")
      .eq("id", payload.category_id)
      .maybeSingle<{ name: string; slug: string; active: boolean }>();

    if (categoryError || !isOfficialProductCategory(category)) {
      throw new Error("Selecciona una categoría oficial para guardar el producto.");
    }

    const { stock: targetStock, ...catalogPayload } = payload;
    const authorizedTargetStock = capabilities.adjustStock ? stockIntegerForAdjustment(input.stock) : targetStock;
    const { data, error } = await supabase.rpc("save_product_catalog_locked", {
      target_product_id: input.id ?? null,
      product_data: catalogPayload,
      images_data: capabilities.manageImages ? imagePayload(input.images) : null,
    });
    if (error) throw new Error(error.message);

    const saved = (Array.isArray(data) ? data[0] : data) as ProductCatalogSaveRpcResult | null;
    if (!saved?.product_id) throw new Error("No se pudo confirmar el producto guardado.");

    await removeCloudinaryImages(saved.removed_asset_ids ?? [], {
      product_id: saved.product_id,
      reason: "product_images_replaced",
    });

    const stockMovement = capabilities.adjustStock ? await setProductStockLocked(saved.product_id, authorizedTargetStock) : null;
    const effectiveStock = capabilities.adjustStock
      ? stockMovement?.stock_after ?? authorizedTargetStock
      : input.id
        ? "preserved"
        : 0;

    await writeAuditLog({
      tableName: "products",
      recordId: saved.product_id,
      action: input.id ? "product.updated" : "product.created",
      oldData: input.id ? { stock: stockMovement?.stock_before ?? "preserved" } : null,
      newData: {
        ...catalogPayload,
        stock: effectiveStock,
        stock_adjustment_authorized: capabilities.adjustStock,
        images_updated: capabilities.manageImages,
      },
    });

    revalidateProductCatalog(payload.slug);
    const stockMessage = capabilities.adjustStock
      ? ""
      : input.id
        ? " El stock y las reservas se conservaron sin cambios."
        : " El producto se creó con stock 0.";
    return {
      ok: true,
      message: `${input.id ? "Producto actualizado" : "Producto creado"} correctamente.${stockMessage}`,
    };
  } catch (error) {
    await removeCloudinaryImages(candidateAssetIds, {
      product_id: input.id ?? null,
      reason: "product_save_compensation",
    });
    const message = friendlyProductError(error instanceof Error ? error.message : "No se pudo guardar el producto.");
    await writeErrorLog({
      route: "/admin/productos",
      action: "products.save_failed",
      errorMessage: message,
      errorStack: error instanceof Error ? error.stack : null,
      metadata: { product_id: input.id ?? null, sku: input.sku },
    });
    return { ok: false, message };
  }
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
      const { data, error } = await supabase.rpc("import_product_row_atomic", {
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
