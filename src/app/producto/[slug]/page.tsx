import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { ProductDetail } from "@/components/store/product-detail";
import { absoluteUrl, getProductImageAlt, serializeJsonLd, siteName, siteUrl } from "@/lib/seo";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";
import { getProductBySlug, getRelatedProducts } from "@/services/supabase/products.service";
import { getPreferredWhatsAppUrl } from "@/utils/contact-settings";
import { getProductMetaDescription } from "@/utils/product-content";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);

  if (!product) {
    return {
      title: "Producto no encontrado",
    };
  }

  const description = getProductMetaDescription(product);
  const image = absoluteUrl(product.image);
  const imageAlt = getProductImageAlt(product.name, product.images[0]?.alt);
  const category = product.category !== "Sin categoría" ? product.category : null;
  const title = category ? `${product.name} en ${category} | ${siteName}` : `${product.name} | ${siteName} Honduras`;
  const canonical = `${siteUrl}/producto/${product.slug}`;

  return {
    title: { absolute: title },
    description,
    alternates: {
      canonical,
    },
    openGraph: {
      type: "website",
      locale: "es_HN",
      siteName,
      title,
      description,
      url: canonical,
      images: [{ url: image, alt: imageAlt }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: image, alt: imageAlt }],
    },
  };
}

export default async function ProductoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);

  if (!product) {
    notFound();
  }

  const [relatedProducts, companySettings] = await Promise.all([
    getRelatedProducts(product),
    getPublicCompanySettings(),
  ]);
  const canonical = `${siteUrl}/producto/${product.slug}`;
  const productSchema = {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": `${canonical}#product`,
    name: product.name,
    sku: product.sku,
    ...(product.brand?.trim()
      ? {
          brand: {
            "@type": "Brand",
            name: product.brand,
          },
        }
      : {}),
    ...(product.category !== "Sin categoría" ? { category: product.category } : {}),
    description: getProductMetaDescription(product),
    image: product.images.length > 0 ? product.images.map((image) => absoluteUrl(image.url)) : [absoluteUrl(product.image)],
    url: canonical,
    offers: {
      "@type": "Offer",
      url: canonical,
      priceCurrency: "HNL",
      price: product.retail_price,
      availability: product.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition",
      seller: {
        "@type": "Organization",
        name: siteName,
        url: siteUrl,
      },
    },
  };
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Inicio", item: siteUrl },
      { "@type": "ListItem", position: 2, name: "Catálogo", item: `${siteUrl}/catalogo` },
      { "@type": "ListItem", position: 3, name: product.name, item: canonical },
    ],
  };

  return (
    <PublicStoreShell>
      <script
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: serializeJsonLd([productSchema, breadcrumbSchema]) }}
      />
      <ProductDetail
        product={product}
        relatedProducts={relatedProducts}
        whatsappUrl={getPreferredWhatsAppUrl(companySettings)}
        productUrl={canonical}
      />
    </PublicStoreShell>
  );
}
