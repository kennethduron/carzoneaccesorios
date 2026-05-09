import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { CategoryOption, ProductAdminRow } from "@/types/products";

type ProductQueryRow = Omit<ProductAdminRow, "category_name" | "images"> & {
  categories: { name: string } | null;
  product_images: ProductAdminRow["images"] | null;
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function normalizeProduct(row: ProductQueryRow): ProductAdminRow {
  return {
    id: row.id,
    category_id: row.category_id,
    category_name: row.categories?.name ?? null,
    sku: row.sku,
    internal_code: row.internal_code,
    slug: row.slug,
    name: row.name,
    brand: row.brand,
    description: row.description,
    stock: toNumber(row.stock),
    min_stock: toNumber(row.min_stock),
    cost_price: toNumber(row.cost_price),
    retail_price: toNumber(row.retail_price),
    wholesale_price: toNumber(row.wholesale_price),
    wholesale_min_quantity: toNumber(row.wholesale_min_quantity),
    status: row.status,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    images: row.product_images ?? [],
  };
}

export async function getAdminProductCatalog() {
  const supabase = await getSupabaseServerClient();

  const [{ data: products, error: productsError }, { data: categories, error: categoriesError }] =
    await Promise.all([
      supabase
        .from("products")
        .select(
          `
          id,
          category_id,
          sku,
          internal_code,
          slug,
          name,
          brand,
          description,
          stock,
          min_stock,
          cost_price,
          retail_price,
          wholesale_price,
          wholesale_min_quantity,
          status,
          active,
          created_at,
          updated_at,
          categories(name),
          product_images(
            id,
            public_url,
            storage_path,
            angle,
            alt_text,
            sort_order,
            is_primary
          )
        `,
        )
        .order("updated_at", { ascending: false })
        .returns<ProductQueryRow[]>(),
      supabase
        .from("categories")
        .select("id, name, slug")
        .order("name", { ascending: true })
        .returns<CategoryOption[]>(),
    ]);

  if (productsError) {
    throw new Error(productsError.message);
  }

  if (categoriesError) {
    throw new Error(categoriesError.message);
  }

  return {
    products: (products ?? []).map(normalizeProduct),
    categories: categories ?? [],
  };
}
