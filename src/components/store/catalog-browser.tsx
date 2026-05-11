"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Car, Search, SlidersHorizontal } from "lucide-react";
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
  minPrice: string;
  maxPrice: string;
  vehicleBrand: string;
  vehicleModel: string;
  vehicleYear: string;
  filterOptions: {
    vehicleBrands: string[];
    vehicleModels: string[];
    vehicleYears: number[];
  };
};

export function CatalogBrowser({
  products,
  categories,
  total,
  page,
  pageSize,
  query,
  category,
  minPrice,
  maxPrice,
  vehicleBrand,
  vehicleModel,
  vehicleYear,
  filterOptions,
}: CatalogBrowserProps) {
  const [search, setSearch] = useState(query);
  const [selectedCategory, setSelectedCategory] = useState(category);
  const [selectedMinPrice, setSelectedMinPrice] = useState(minPrice);
  const [selectedMaxPrice, setSelectedMaxPrice] = useState(maxPrice);
  const [selectedVehicleBrand, setSelectedVehicleBrand] = useState(vehicleBrand);
  const [selectedVehicleModel, setSelectedVehicleModel] = useState(vehicleModel);
  const [selectedVehicleYear, setSelectedVehicleYear] = useState(vehicleYear);
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
    if (selectedMinPrice.trim()) {
      params.set("precio_min", selectedMinPrice.trim());
    }
    if (selectedMaxPrice.trim()) {
      params.set("precio_max", selectedMaxPrice.trim());
    }
    if (selectedVehicleBrand) {
      params.set("marca_carro", selectedVehicleBrand);
    }
    if (selectedVehicleModel) {
      params.set("modelo_carro", selectedVehicleModel);
    }
    if (selectedVehicleYear) {
      params.set("anio_carro", selectedVehicleYear);
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
        <form action="/catalogo" className="rounded-lg border border-black/10 bg-white p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_220px_auto]">
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
          </div>

          <div className="mt-4 grid gap-3 border-t border-black/10 pt-4 md:grid-cols-2 xl:grid-cols-5">
            <FilterField label="Precio desde">
              <input
                name="precio_min"
                type="number"
                min={0}
                step="0.01"
                value={selectedMinPrice}
                onChange={(event) => setSelectedMinPrice(event.target.value)}
                placeholder="Min"
                className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
              />
            </FilterField>
            <FilterField label="Precio hasta">
              <input
                name="precio_max"
                type="number"
                min={0}
                step="0.01"
                value={selectedMaxPrice}
                onChange={(event) => setSelectedMaxPrice(event.target.value)}
                placeholder="Max"
                className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
              />
            </FilterField>
            <FilterField label="Marca del carro">
              <select
                name="marca_carro"
                value={selectedVehicleBrand}
                onChange={(event) => setSelectedVehicleBrand(event.target.value)}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                <option value="">Todas</option>
                {filterOptions.vehicleBrands.map((brand) => (
                  <option key={brand} value={brand}>
                    {brand}
                  </option>
                ))}
              </select>
            </FilterField>
            <FilterField label="Modelo del carro">
              <select
                name="modelo_carro"
                value={selectedVehicleModel}
                onChange={(event) => setSelectedVehicleModel(event.target.value)}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                <option value="">Todos</option>
                {filterOptions.vehicleModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </FilterField>
            <FilterField label="Año del carro">
              <select
                name="anio_carro"
                value={selectedVehicleYear}
                onChange={(event) => setSelectedVehicleYear(event.target.value)}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                <option value="">Todos</option>
                {filterOptions.vehicleYears.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </FilterField>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-black/50">
            <SlidersHorizontal size={14} />
            <span>El filtro de precio usa precio al detalle, el precio público por defecto.</span>
            <Car size={14} />
            <span>Compatibilidad por marca, modelo y año del carro.</span>
          </div>
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
            Para pedidos de volumen, solicita tu código mayorista y el catálogo cambiará a precio mayorista.
          </p>
        </section>
      </aside>
    </section>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase text-black/50">{label}</span>
      {children}
    </label>
  );
}
