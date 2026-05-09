import { PublicStoreShell } from "@/components/store/public-store-shell";
import { CatalogBrowser } from "@/components/store/catalog-browser";
import { products } from "@/lib/commerce";

export default function CatalogoPage() {
  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-7xl px-5 pt-8">
        <p className="text-sm text-black/50">Tienda publica</p>
        <h1 className="mt-2 text-4xl font-semibold">Catalogo</h1>
      </section>
      <CatalogBrowser products={products} />
    </PublicStoreShell>
  );
}
