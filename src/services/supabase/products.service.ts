import { getSupabaseBrowserClient } from "@/lib/supabase";

export async function getActiveProducts() {
  const supabase = getSupabaseBrowserClient();

  return supabase
    .from("products")
    .select(
      `
      id,
      sku,
      slug,
      name,
      brand,
      description,
      stock,
      retail_price,
      wholesale_price,
      categories (
        id,
        name,
        slug
      ),
      product_images (
        id,
        public_url,
        storage_path,
        alt_text,
        sort_order,
        is_primary
      )
    `,
    )
    .eq("active", true)
    .order("name", { ascending: true });
}
