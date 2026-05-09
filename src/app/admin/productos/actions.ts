"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ProductFormInput, ProductImageInput, ProductStatus } from "@/types/products";

type ProductMutationResult = {
  ok: boolean;
  message: string;
};

type ProductDbPayload = {
  category_id: string | null;
  sku: string;
  internal_code: string | null;
  slug: string;
  name: string;
  brand: string;
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

function productPayload(input: ProductFormInput): ProductDbPayload {
  const sku = input.sku.trim().toUpperCase();
  const name = input.name.trim();
  const status = input.active ? input.status : "inactive";
  const slug = cleanText(input.slug) ?? slugify(`${sku}-${name}`);

  if (!sku || !name || !input.brand.trim()) {
    throw new Error("SKU, nombre y marca son obligatorios.");
  }

  if (input.wholesale_price > input.retail_price) {
    throw new Error("wholesale_price no puede ser mayor que retail_price.");
  }

  return {
    category_id: input.category_id || null,
    sku,
    internal_code: cleanText(input.internal_code),
    slug,
    name,
    brand: input.brand.trim(),
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
      storage_path: cleanText(image.storage_path) ?? `${productId}/${index}-${Date.now()}`,
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

      await replaceImages(input.id, input.images);
      await logInventoryAdjustment(input.id, Number(previous.stock), payload.stock);
      revalidatePath("/admin/productos");
      revalidatePath("/");
      return { ok: true, message: "Producto actualizado." };
    }

    const { data, error } = await supabase.from("products").insert(payload).select("id").single<{ id: string }>();

    if (error) {
      throw new Error(error.message);
    }

    await replaceImages(data.id, input.images);
    if (payload.stock > 0) {
      await logInventoryAdjustment(data.id, 0, payload.stock);
    }

    revalidatePath("/admin/productos");
    revalidatePath("/");
    return { ok: true, message: "Producto creado." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo guardar el producto." };
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
    return { ok: false, message: error.message };
  }

  revalidatePath("/admin/productos");
  revalidatePath("/");
  return { ok: true, message: active ? "Producto activado." : "Producto desactivado." };
}

export async function deleteProductAction(id: string): Promise<ProductMutationResult> {
  await requirePermission("products:manage");

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.from("products").delete().eq("id", id);

  if (error) {
    return { ok: false, message: error.message };
  }

  revalidatePath("/admin/productos");
  revalidatePath("/");
  return { ok: true, message: "Producto eliminado." };
}

export async function importProductsAction(products: ProductFormInput[]): Promise<ProductMutationResult> {
  await requirePermission("products:manage");

  let saved = 0;
  for (const product of products) {
    const result = await saveProductAction(product);
    if (!result.ok) {
      return { ok: false, message: `Importacion detenida en ${product.sku}: ${result.message}` };
    }
    saved += 1;
  }

  return { ok: true, message: `${saved} productos importados.` };
}
