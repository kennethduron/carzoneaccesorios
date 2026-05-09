"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { Product } from "@/types/commerce";
import { CatalogProductCard } from "@/components/store/catalog-product-card";
import { WholesaleCodePanel } from "@/components/store/wholesale-code-panel";
import { useProductRegistry } from "@/contexts/product-registry-context";

type CatalogBrowserProps = {
  products: Product[];
  categories: Array<{ name: string; slug: string }>;
  total: number;
  page: number;
  pageSize: number;
  query: string;
  category: string;
};

export function CatalogBrowser({
  products,
  categories,
  total,
  page,
  pageSize,
  query,
  category,
}: CatalogBrowserProps) {
  const [search, setSearch] = useState(query);
  const [selectedCategory, setSelectedCategory] = useState(category);
  const { registerProducts } = useProductRegistry();
  const hasNextPage = page * pageSize < total;

  useEffect(() => {
    registerProducts(products);
  }, [products, registerProducts]);

  function buildHref(nextPage: number) {
    const params = new URLSearchParams();
    if (search.trim()) {
      params.set("q", search.trim());
    }
    if (selectedCategory) {
      params.set("categoria", selectedCategory);
    }
    if (nextPage > 1) {
      params.set("page", String(nextPage));
    }

    const queryString = params.toString();
    return queryString ? `/catalogo?${queryString}` : "/catalogo";
  }

  return (
    <section className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[1fr_360px]">
      <div className="space-y-5">
        <form action="/catalogo" className="grid gap-3 rounded-lg border border-black/10 bg-white p-4 md:grid-cols-[1fr_220px_auto]">
          <label className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2">
            <Search size={18} className="text-black/45" />
            <input
              name="q"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar por producto, SKU o marca"
              className="w-full bg-transparent text-sm outline-none"
            />
          </label>
          <select
            value={selectedCategory}
            name="categoria"
            onChange={(event) => setSelectedCategory(event.target.value)}
            className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
          >
            <option value="">Todas</option>
            {categories.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
          <button className="rounded-md bg-[#1c1d1b] px-4 py-2 text-sm font-medium text-white">
            Buscar
          </button>
        </form>

        <p className="text-sm text-black/55">
          Mostrando {products.length.toLocaleString("es-HN")} de {total.toLocaleString("es-HN")} productos.
        </p>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {products.map((product) => (
            <CatalogProductCard key={product.id} product={product} />
          ))}
        </div>
        {hasNextPage ? (
          <div className="flex justify-center">
            <Link href={buildHref(page + 1)} className="rounded-md border border-black/10 bg-white px-4 py-3 text-sm font-medium">
              Ver siguiente pagina
            </Link>
          </div>
        ) : null}
      </div>

      <aside className="space-y-4">
        <WholesaleCodePanel />
        <section className="rounded-lg border border-black/10 bg-white p-4">
          <h2 className="font-semibold">Atencion comercial</h2>
          <p className="mt-2 text-sm text-black/60">
            Para pedidos de volumen, solicita tu codigo mayorista y el catalogo cambiara a wholesale_price.
          </p>
        </section>
      </aside>
    </section>
  );
}
