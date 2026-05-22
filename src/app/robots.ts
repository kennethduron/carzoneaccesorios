import type { MetadataRoute } from "next";

const siteUrl = "https://carzoneaccesorios.vercel.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin/", "/api/", "/checkout", "/cuenta", "/mis-pedidos", "/facturas"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
