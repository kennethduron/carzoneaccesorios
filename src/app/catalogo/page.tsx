import { PublicStoreShell } from "@/components/store/public-store-shell";
import { CatalogBrowser } from "@/components/store/catalog-browser";
import { getCatalogProducts } from "@/services/supabase/products.service";

export const dynamic = "force-dynamic";

export default async function CatalogoPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; categoria?: string; page?: string }>;
}) {
  const params = await searchParams;
  const catalog = await getCatalogProducts({
    query: params.q,
    category: params.categoria,
    page: Number(params.page ?? 1),
    pageSize: 24,
  });

  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-7xl px-5 pt-8">
        <p className="text-sm text-black/50">Tienda publica</p>
        <h1 className="mt-2 text-4xl font-semibold">Catalogo</h1>
      </section>
      <CatalogBrowser
        products={catalog.products}
        categories={catalog.categories}
        total={catalog.total}
        page={catalog.page}
        pageSize={catalog.pageSize}
        query={params.q ?? ""}
        category={params.categoria ?? ""}
      />
    </PublicStoreShell>
  );
}
