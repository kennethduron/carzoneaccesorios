import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { ProductDetail } from "@/components/store/product-detail";
import { getProductBySlug, getRelatedProducts } from "@/services/supabase/products.service";

export const dynamic = "force-dynamic";

const siteUrl = "https://carzoneaccesorios.vercel.app";

function absoluteUrl(value: string) {
  return value.startsWith("http") ? value : `${siteUrl}${value}`;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);

  if (!product) {
    return {
      title: "Producto no encontrado",
    };
  }

  const description = product.description || `${product.name} disponible en Car Zone Accesorios.`;
  const image = absoluteUrl(product.image);

  return {
    title: product.name,
    description,
    alternates: {
      canonical: `/producto/${product.slug}`,
    },
    openGraph: {
      type: "website",
      title: `${product.name} | Car Zone Accesorios`,
      description,
      url: `${siteUrl}/producto/${product.slug}`,
      images: [{ url: image, alt: product.name }],
    },
  };
}

export default async function ProductoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);

  if (!product) {
    notFound();
  }

  const relatedProducts = await getRelatedProducts(product);
  const productSchema = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    sku: product.sku,
    brand: {
      "@type": "Brand",
      name: product.brand,
    },
    description: product.description,
    image: product.images.length > 0 ? product.images.map((image) => absoluteUrl(image.url)) : [absoluteUrl(product.image)],
    offers: {
      "@type": "Offer",
      url: `${siteUrl}/producto/${product.slug}`,
      priceCurrency: "HNL",
      price: product.retail_price,
      availability: product.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition",
    },
  };
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Inicio", item: siteUrl },
      { "@type": "ListItem", position: 2, name: "Catálogo", item: `${siteUrl}/catalogo` },
      { "@type": "ListItem", position: 3, name: product.name, item: `${siteUrl}/producto/${product.slug}` },
    ],
  };

  return (
    <PublicStoreShell>
      <script
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify([productSchema, breadcrumbSchema]) }}
      />
      <ProductDetail product={product} relatedProducts={relatedProducts} />
    </PublicStoreShell>
  );
}
