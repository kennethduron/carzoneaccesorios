import type { MetadataRoute } from "next";
import { absoluteUrl, siteUrl } from "@/lib/seo";
import { getCategorySummaries, getSitemapProducts } from "@/services/supabase/products.service";

const staticRoutes = [
  "",
  "/catalogo",
  "/categorias",
  "/contacto",
  "/politicas",
  "/terminos-y-condiciones",
  "/politica-de-privacidad",
  "/politica-de-entrega",
  "/politica-de-devoluciones",
  "/politica-de-cancelacion",
  "/contacto-servicio-cliente",
  "/rastreo",
  "/historia",
  "/mision",
  "/vision",
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const routes: MetadataRoute.Sitemap = staticRoutes.map((route) => ({
    url: `${siteUrl}${route}`,
    lastModified: now,
    changeFrequency: route === "" || route === "/catalogo" ? "daily" : "weekly",
    priority: route === "" ? 1 : route === "/catalogo" ? 0.9 : 0.6,
  }));

  try {
    const [catalog, categories] = await Promise.all([
      getSitemapProducts(),
      getCategorySummaries(),
    ]);

    routes.push(
      ...categories.map((category) => ({
        url: `${siteUrl}/catalogo?categoria=${encodeURIComponent(category.slug)}`,
        lastModified: now,
        changeFrequency: "weekly" as const,
        priority: 0.7,
      })),
      ...catalog.map((product) => ({
        url: `${siteUrl}/producto/${product.slug}`,
        lastModified: new Date(product.updatedAt),
        changeFrequency: "weekly" as const,
        priority: 0.8,
        images: product.image ? [absoluteUrl(product.image)] : undefined,
      })),
    );
  } catch {
    return routes;
  }

  return routes;
}
