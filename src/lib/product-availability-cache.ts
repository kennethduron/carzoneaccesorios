import "server-only";

import { revalidatePath, updateTag } from "next/cache";

type ProductAvailabilityCacheOptions = {
  adminPaths?: string[];
  productSlugs?: Array<string | null | undefined>;
};

export function revalidateProductAvailability({
  adminPaths = [],
  productSlugs = [],
}: ProductAvailabilityCacheOptions = {}) {
  const paths = new Set([
    ...adminPaths,
    "/",
    "/catalogo",
    "/categorias",
    "/sitemap.xml",
  ]);

  for (const path of paths) {
    revalidatePath(path);
  }

  const slugs = new Set(productSlugs.map((slug) => slug?.trim()).filter((slug): slug is string => Boolean(slug)));
  for (const slug of slugs) {
    revalidatePath(`/producto/${slug}`);
  }

  for (const tag of ["products", "featured-products", "vehicle-filters", "categories"]) {
    updateTag(tag);
  }
}
