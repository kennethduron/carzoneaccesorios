import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/admin/",
        "/api/",
        "/checkout",
        "/carrito",
        "/cuenta",
        "/mis-pedidos",
        "/facturas",
        "/login",
        "/registro",
        "/recuperar-contrasena",
        "/restablecer-contrasena",
        "/actualizar-contrasena",
        "/pago/",
        "/verificacion/",
      ],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
