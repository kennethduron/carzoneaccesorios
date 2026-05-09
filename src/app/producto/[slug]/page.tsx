import { notFound } from "next/navigation";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { ProductDetail } from "@/components/store/product-detail";
import { getProductBySlug } from "@/services/supabase/products.service";

export const dynamic = "force-dynamic";

export default async function ProductoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);

  if (!product) {
    notFound();
  }

  return (
    <PublicStoreShell>
      <ProductDetail product={product} />
    </PublicStoreShell>
  );
}
