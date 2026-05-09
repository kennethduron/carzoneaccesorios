import { notFound } from "next/navigation";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { ProductDetail } from "@/components/store/product-detail";
import { products } from "@/lib/commerce";

export function generateStaticParams() {
  return products.map((product) => ({ slug: product.slug }));
}

export default async function ProductoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = products.find((entry) => entry.slug === slug);

  if (!product) {
    notFound();
  }

  return (
    <PublicStoreShell>
      <ProductDetail product={product} />
    </PublicStoreShell>
  );
}
