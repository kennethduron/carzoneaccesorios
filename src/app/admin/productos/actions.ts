"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { configureCloudinary } from "@/lib/cloudinary";
import { writeErrorLog } from "@/lib/error-logging";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ProductFormInput, ProductImageInput, ProductStatus } from "@/types/products";

type ProductMutationResult = {
  ok: boolean;
  message: string;
};

type ProductImageUploadResult = ProductMutationResult & {
  publicUrl?: string;
  storagePath?: string;
  publicId?: string;
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
  description: string;
  stock: number;
  low_stock_threshold: number;
  min_stock: number;
  cost_price: number;
  retail_price: number;
  wholesale_price: number;
  wholesale_min_quantity: number;
  status: ProductStatus;
  active: boolean;
};

const allowedProductImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

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

function revalidateProductCatalog(slug?: string | null) {
  revalidatePath("/admin/productos");
  revalidatePath("/admin/inventario");
  revalidatePath("/admin/reportes");
  revalidatePath("/");
  revalidatePath("/catalogo");
  revalidatePath("/categorias");
  if (slug) {
    revalidatePath(`/producto/${slug}`);
  }
  revalidateTag("products", "max");
  revalidateTag("featured-products", "max");
  revalidateTag("vehicle-filters", "max");
}

function friendlyProductError(message: string) {
  if (message.includes("products_internal_code_key")) {
    return "El codigo proveedor/OEM ya esta usado por otro producto. Usa otro codigo o dejalo vacio.";
  }

  if (message.includes("products_sku_key")) {
    return "El SKU ya esta usado por otro producto. Usa un SKU diferente.";
  }

  if (message.includes("products_slug_key")) {
    return "La URL amigable ya esta usada por otro producto. Edita el slug en opciones avanzadas.";
  }

  if (message.toLowerCase().includes("duplicate key")) {
    return "Ya existe un registro con un dato unico repetido. Revisa SKU, codigo proveedor/OEM o URL amigable.";
  }

  return message;
}

function productPayload(input: ProductFormInput): ProductDbPayload {
  const sku = input.sku.trim().toUpperCase();
  const name = input.name.trim();
  const status = input.active ? input.status : "inactive";
  const slug = cleanText(input.slug) ?? slugify(`${sku}-${name}`);

  if (!sku || !name || !input.brand.trim()) {
    throw new Error("SKU, nombre y marca son obligatorios.");
  }

  if (input.wholesale_price > input.retail_price) {
    throw new Error("El precio mayorista no puede ser mayor que el precio al detalle.");
  }

  return {
    category_id: input.category_id || null,
    sku,
    internal_code: cleanText(input.internal_code),
    slug,
    name,
    brand: input.brand.trim(),
    vehicle_brand: cleanText(input.vehicle_brand),
    vehicle_model: cleanText(input.vehicle_model),
    vehicle_year_start: input.vehicle_year_start ? positiveInteger(input.vehicle_year_start) : null,
    vehicle_year_end: input.vehicle_year_end ? positiveInteger(input.vehicle_year_end) : null,
    description: input.description.trim(),
    stock: positiveInteger(input.stock),
    low_stock_threshold: positiveInteger(input.min_stock),
    min_stock: positiveInteger(input.min_stock),
    cost_price: positiveNumber(input.cost_price),
    retail_price: positiveNumber(input.retail_price),
    wholesale_price: positiveNumber(input.wholesale_price),
    wholesale_min_quantity: Math.max(1, positiveInteger(input.wholesale_min_quantity, 1)),
    status,
    active: status === "active" && input.active,
  };
}

function imagePayload(productId: string, images: ProductImageInput[]) {
  return images
    .filter((image) => cleanText(image.public_url))
    .map((image, index) => ({
      product_id: productId,
      storage_bucket: "product-images",
      storage_path: cleanText(image.storage_path) ?? cleanText(image.public_id) ?? `${productId}/${index}-${Date.now()}`,
      public_id: cleanText(image.public_id) ?? cleanText(image.storage_path),
      public_url: image.public_url.trim(),
      angle: cleanText(image.angle) ?? "principal",
      alt_text: cleanText(image.alt_text),
      sort_order: positiveInteger(image.sort_order, index),
      is_primary: image.is_primary || index === 0,
    }));
}

async function replaceImages(productId: string, images: ProductImageInput[]) {
  const supabase = await getSupabaseServerClient();
  const { error: deleteError } = await supabase.from("product_images").delete().eq("product_id", productId);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  const rows = imagePayload(productId, images);
  if (rows.length === 0) {
    return;
  }

  const { error } = await supabase.from("product_images").insert(rows);

  if (error) {
    throw new Error(error.message);
  }
}

async function logInventoryAdjustment(productId: string, previousStock: number, nextStock: number) {
  if (previousStock === nextStock) {
    return;
  }

  const supabase = await getSupabaseServerClient();
  const profile = await requirePermission("products:manage");
  const { error } = await supabase.from("inventory_movements").insert({
    product_id: productId,
    user_id: profile.id,
    movement_type: "adjustment",
    quantity: nextStock - previousStock,
    stock_before: previousStock,
    stock_after: nextStock,
    reference_type: "products",
    reference_id: productId,
    notes: "Ajuste desde modulo de productos",
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function uploadProductImageAction(formData: FormData): Promise<ProductImageUploadResult> {
  const profile = await requirePermission("products:manage");

  try {
    const cloudinary = configureCloudinary();

    const file = formData.get("file");
    const productSlug = String(formData.get("productSlug") ?? "producto").trim() || "producto";
    const angle = String(formData.get("angle") ?? "principal").trim() || "principal";

    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, message: "Selecciona una imagen valida antes de subir." };
    }

    if (!allowedProductImageTypes.has(file.type)) {
      return { ok: false, message: "Solo se permiten imagenes JPG, PNG, WebP o AVIF." };
    }

    if (file.size > 8 * 1024 * 1024) {
      return { ok: false, message: "La imagen no puede superar 8 MB." };
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const folder = `car-zone/productos/${slugify(productSlug) || "producto"}`;
    const publicId = `${angle}-${Date.now()}`;

    const result = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: publicId,
          resource_type: "image",
          overwrite: true,
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

      stream.end(buffer);
    });

    return {
      ok: true,
      message: "Imagen subida correctamente.",
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
          : "No se pudo subir la imagen. Revisa la conexion e intenta de nuevo.",
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

export async function saveProductAction(input: ProductFormInput): Promise<ProductMutationResult> {
  await requirePermission("products:manage");

  try {
    const supabase = await getSupabaseServerClient();
    const payload = productPayload(input);

    if (input.id) {
      const { data: previous, error: previousError } = await supabase
        .from("products")
        .select("stock")
        .eq("id", input.id)
        .single<{ stock: number }>();

      if (previousError) {
        throw new Error(previousError.message);
      }

      const { error } = await supabase.from("products").update(payload).eq("id", input.id);

      if (error) {
        throw new Error(error.message);
      }

      if (input.images.length > 0) {
        await replaceImages(input.id, input.images);
      }
      await logInventoryAdjustment(input.id, Number(previous.stock), payload.stock);
      await writeAuditLog({
        tableName: "products",
        recordId: input.id,
        action: "product.updated",
        oldData: { stock: Number(previous.stock) },
        newData: payload,
      });
      revalidateProductCatalog(payload.slug);
      return { ok: true, message: "Producto actualizado correctamente." };
    }

    const { data, error } = await supabase.from("products").insert(payload).select("id").single<{ id: string }>();

    if (error) {
      throw new Error(error.message);
    }

    await replaceImages(data.id, input.images);
    if (payload.stock > 0) {
      await logInventoryAdjustment(data.id, 0, payload.stock);
    }
    await writeAuditLog({
      tableName: "products",
      recordId: data.id,
      action: "product.created",
      newData: payload,
    });

    revalidateProductCatalog(payload.slug);
    return { ok: true, message: "Producto creado correctamente. Puede tardar unos segundos en aparecer en la tienda." };
  } catch (error) {
    const message = friendlyProductError(error instanceof Error ? error.message : "No se pudo guardar el producto.");
    await writeErrorLog({
      route: "/admin/productos",
      action: "products.save_failed",
      errorMessage: message,
      errorStack: error instanceof Error ? error.stack : null,
      metadata: {
        product_id: input.id ?? null,
        sku: input.sku,
      },
    });
    return { ok: false, message };
  }
}

export async function setProductActiveAction(id: string, active: boolean): Promise<ProductMutationResult> {
  await requirePermission("products:manage");

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase
    .from("products")
    .update({
      active,
      status: active ? "active" : "inactive",
    })
    .eq("id", id);

  if (error) {
    return { ok: false, message: friendlyProductError(error.message) };
  }

  await writeAuditLog({
    tableName: "products",
    recordId: id,
    action: active ? "product.activated" : "product.deactivated",
    newData: { active },
  });

  revalidateProductCatalog();
  return { ok: true, message: active ? "Producto activado correctamente." : "Producto desactivado correctamente." };
}

export async function deleteProductAction(id: string): Promise<ProductMutationResult> {
  await requirePermission("products:manage");

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.from("products").delete().eq("id", id);

  if (error) {
    return { ok: false, message: friendlyProductError(error.message) };
  }

  await writeAuditLog({
    tableName: "products",
    recordId: id,
    action: "product.deleted",
  });

  revalidateProductCatalog();
  return { ok: true, message: "Producto eliminado correctamente." };
}

export async function importProductsAction(products: ProductFormInput[]): Promise<ProductMutationResult> {
  await requirePermission("products:manage");
  const supabase = await getSupabaseServerClient();

  if (products.length === 0) {
    return { ok: false, message: "El archivo no contiene productos para importar." };
  }

  let saved = 0;
  for (const product of products) {
    const sku = product.sku.trim().toUpperCase();
    let productWithId = product;

    if (!product.id && sku) {
      const { data, error } = await supabase
        .from("products")
        .select("id")
        .eq("sku", sku)
        .maybeSingle<{ id: string }>();

      if (error) {
        return { ok: false, message: `Importacion detenida en ${product.sku}: ${friendlyProductError(error.message)}` };
      }

      if (data?.id) {
        productWithId = { ...product, id: data.id };
      }
    }

    const result = await saveProductAction(productWithId);
    if (!result.ok) {
      return { ok: false, message: `Importacion detenida en ${product.sku}: ${friendlyProductError(result.message)}` };
    }
    saved += 1;
  }

  return { ok: true, message: `CSV importado correctamente. ${saved} productos guardados.` };
}
