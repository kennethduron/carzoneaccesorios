import { getSupabaseBrowserClient } from "@/lib/supabase";

const PRODUCT_IMAGES_BUCKET =
  process.env.NEXT_PUBLIC_SUPABASE_PRODUCT_IMAGES_BUCKET ?? "product-images";

export function getProductImagePublicUrl(path: string) {
  const supabase = getSupabaseBrowserClient();

  return supabase.storage.from(PRODUCT_IMAGES_BUCKET).getPublicUrl(path).data.publicUrl;
}

export async function uploadProductImage(file: File, path: string) {
  const supabase = getSupabaseBrowserClient();

  return supabase.storage.from(PRODUCT_IMAGES_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: true,
  });
}
