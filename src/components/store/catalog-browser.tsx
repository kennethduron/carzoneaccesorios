"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { Product } from "@/types/commerce";
import { CatalogProductCard } from "@/components/store/catalog-product-card";
import { WholesaleCodePanel } from "@/components/store/wholesale-code-panel";

export function CatalogBrowser({ products }: { products: Product[] }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("Todos");

  const categories = useMemo(
    () => ["Todos", ...Array.from(new Set(products.map((product) => product.category)))],
    [products],
  );

  const visibleProducts = useMemo(() => {
    return products.filter((product) => {
      const matchesQuery = `${product.name} ${product.sku} ${product.brand}`.toLowerCase().includes(query.toLowerCase());
      const matchesCategory = category === "Todos" || product.category === category;
      return matchesQuery && matchesCategory;
    });
  }, [category, products, query]);

  return (
    <section className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[1fr_360px]">
      <div className="space-y-5">
        <div className="grid gap-3 rounded-lg border border-black/10 bg-white p-4 md:grid-cols-[1fr_220px]">
          <label className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2">
            <Search size={18} className="text-black/45" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por producto, SKU o marca"
              className="w-full bg-transparent text-sm outline-none"
            />
          </label>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
          >
            {categories.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibleProducts.map((product) => (
            <CatalogProductCard key={product.id} product={product} />
          ))}
        </div>
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
