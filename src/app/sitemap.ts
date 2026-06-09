import type { MetadataRoute } from "next";
import { getCatalogProducts, getCategorySummaries } from "@/services/supabase/products.service";

const siteUrl = "https://carzoneaccesorios.com";

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
  "/registro",
  "/login",
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
      getCatalogProducts({ pageSize: 48 }),
      getCategorySummaries(),
    ]);

    routes.push(
      ...categories.map((category) => ({
        url: `${siteUrl}/catalogo?categoria=${encodeURIComponent(category.slug)}`,
        lastModified: now,
        changeFrequency: "weekly" as const,
        priority: 0.7,
      })),
      ...catalog.products.map((product) => ({
        url: `${siteUrl}/producto/${product.slug}`,
        lastModified: now,
        changeFrequency: "weekly" as const,
        priority: 0.8,
      })),
    );
  } catch {
    return routes;
  }

  return routes;
}
