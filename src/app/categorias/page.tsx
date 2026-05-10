import Link from "next/link";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { getCatalogProducts } from "@/services/supabase/products.service";

export const dynamic = "force-dynamic";

export default async function CategoríasPage() {
  const catalog = await getCatalogProducts({ pageSize: 1 });
  const categories = catalog.categories;

  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-7xl px-5 py-8">
        <p className="text-sm text-black/50">Explora por linea</p>
        <h1 className="mt-2 text-4xl font-semibold">Categorías</h1>
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {categories.map((category) => (
            <Link
              key={category.name}
              href={`/catálogo?categoría=${encodeURIComponent(category.slug)}`}
              className="rounded-lg border border-black/10 bg-white p-5 transition-colors hover:border-[#246a73]"
            >
              <p className="text-xl font-semibold">{category.name}</p>
              <p className="mt-2 text-sm text-black/55">Ver productos disponibles</p>
            </Link>
          ))}
        </div>
      </section>
    </PublicStoreShell>
  );
}
