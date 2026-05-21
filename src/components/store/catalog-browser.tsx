"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Car, Search, SlidersHorizontal, X } from "lucide-react";
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
  availability: string;
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
  availability,
  filterOptions,
}: CatalogBrowserProps) {
  const [search, setSearch] = useState(query);
  const [selectedCategory, setSelectedCategory] = useState(category);
  const [selectedMinPrice, setSelectedMinPrice] = useState(minPrice);
  const [selectedMaxPrice, setSelectedMaxPrice] = useState(maxPrice);
  const [selectedVehicleBrand, setSelectedVehicleBrand] = useState(vehicleBrand);
  const [selectedVehicleModel, setSelectedVehicleModel] = useState(vehicleModel);
  const [selectedVehicleYear, setSelectedVehicleYear] = useState(vehicleYear);
  const [selectedAvailability, setSelectedAvailability] = useState(availability);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { registerProducts } = useProductRegistry();
  const hasNextPage = page * pageSize < total;
  const hasActiveFilters = Boolean(query || category || minPrice || maxPrice || vehicleBrand || vehicleModel || vehicleYear || availability);

  useEffect(() => {
    registerProducts(products);
  }, [products, registerProducts]);

  function buildHref(nextPage: number) {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (selectedCategory) params.set("categoria", selectedCategory);
    if (selectedMinPrice.trim()) params.set("precio_min", selectedMinPrice.trim());
    if (selectedMaxPrice.trim()) params.set("precio_max", selectedMaxPrice.trim());
    if (selectedVehicleBrand) params.set("marca_carro", selectedVehicleBrand);
    if (selectedVehicleModel) params.set("modelo_carro", selectedVehicleModel);
    if (selectedVehicleYear) params.set("anio_carro", selectedVehicleYear);
    if (selectedAvailability) params.set("disponibilidad", selectedAvailability);
    if (nextPage > 1) params.set("page", String(nextPage));

    const queryString = params.toString();
    return queryString ? `/catalogo?${queryString}` : "/catalogo";
  }

  const filterControls = (
    <>
      <div className="grid gap-3 md:grid-cols-[1fr_220px_auto]">
        <label className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 transition-colors focus-within:border-[#e4252c] focus-within:ring-2 focus-within:ring-[#e4252c]/15">
          <Search size={18} className="text-black/45" />
          <input
            name="q"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Nombre, SKU o codigo"
            className="w-full bg-transparent text-sm outline-none placeholder:text-black/40"
          />
        </label>
        <select
          value={selectedCategory}
          name="categoria"
          onChange={(event) => setSelectedCategory(event.target.value)}
          className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
        >
          <option value="">Todas las categorias</option>
          {categories.map((item) => (
            <option key={item.slug} value={item.slug}>
              {item.name}
            </option>
          ))}
        </select>
        <button className="rounded-md bg-[#080808] px-4 py-2 text-sm font-semibold text-white transition-all hover:-translate-y-0.5 hover:bg-[#e4252c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2">
          Buscar
        </button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <FilterField label="Precio desde">
          <input
            name="precio_min"
            type="number"
            min={0}
            step="0.01"
            value={selectedMinPrice}
            onChange={(event) => setSelectedMinPrice(event.target.value)}
            placeholder="L 0.00"
            className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none transition-colors placeholder:text-black/40 focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
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
            placeholder="L 5,000.00"
            className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none transition-colors placeholder:text-black/40 focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
          />
        </FilterField>
        <FilterField label="Disponibilidad">
          <select
            name="disponibilidad"
            value={selectedAvailability}
            onChange={(event) => setSelectedAvailability(event.target.value)}
            className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
          >
            <option value="">Todo</option>
            <option value="disponible">Disponible</option>
            <option value="agotado">Agotado</option>
          </select>
        </FilterField>
        <FilterField label="Marca vehiculo">
          <select
            name="marca_carro"
            value={selectedVehicleBrand}
            onChange={(event) => setSelectedVehicleBrand(event.target.value)}
            className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
          >
            <option value="">Todas</option>
            {filterOptions.vehicleBrands.map((brand) => (
              <option key={brand} value={brand}>
                {brand}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Modelo vehiculo">
          <select
            name="modelo_carro"
            value={selectedVehicleModel}
            onChange={(event) => setSelectedVehicleModel(event.target.value)}
            className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
          >
            <option value="">Todos</option>
            {filterOptions.vehicleModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Anio vehiculo">
          <select
            name="anio_carro"
            value={selectedVehicleYear}
            onChange={(event) => setSelectedVehicleYear(event.target.value)}
            className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
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
    </>
  );

  return (
    <section className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-5 lg:grid-cols-[1fr_340px]">
      <div className="space-y-5">
        <form action="/catalogo" className="rounded-lg border border-black/10 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
          <div className="mb-4 flex flex-col justify-between gap-3 border-b border-black/10 pb-4 sm:flex-row sm:items-center">
            <div>
              <h2 className="font-semibold">Buscar y filtrar productos</h2>
              <p className="mt-1 text-sm text-black/55">Combina busqueda, categoria, precio, stock y compatibilidad.</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setFiltersOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-[#080808] px-3 py-2 text-sm font-semibold text-white md:hidden"
              >
                <SlidersHorizontal size={16} />
                Filtrar productos
              </button>
              {hasActiveFilters ? (
                <Link
                  href="/catalogo"
                  className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold transition-all hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:bg-[#fff1f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c]"
                >
                  <X size={16} />
                  Limpiar
                </Link>
              ) : null}
            </div>
          </div>

          <div className="hidden md:block">{filterControls}</div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-black/50">
            <SlidersHorizontal size={14} />
            <span>El filtro de precio usa el precio al detalle.</span>
            <Car size={14} />
            <span>Compatibilidad por marca, modelo y anio del vehiculo.</span>
          </div>
        </form>

        {filtersOpen ? (
          <div className="fixed inset-0 z-[65] md:hidden">
            <button
              type="button"
              className="absolute inset-0 bg-black/45"
              aria-label="Cerrar filtros"
              onClick={() => setFiltersOpen(false)}
            />
            <form action="/catalogo" className="absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-lg bg-white p-5 shadow-2xl">
              <div className="mb-4 flex items-center justify-between border-b border-black/10 pb-3">
                <h2 className="font-semibold">Filtrar productos</h2>
                <button type="button" onClick={() => setFiltersOpen(false)} className="grid size-10 place-items-center rounded-md border border-black/10">
                  <X size={18} />
                </button>
              </div>
              {filterControls}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Link href="/catalogo" className="inline-flex justify-center rounded-md border border-black/10 px-4 py-3 text-sm font-semibold">
                  Limpiar
                </Link>
                <button className="rounded-md bg-[#e4252c] px-4 py-3 text-sm font-semibold text-white">
                  Aplicar
                </button>
              </div>
            </form>
          </div>
        ) : null}

        <p className="text-sm text-black/55">
          Mostrando {products.length.toLocaleString("es-HN")} de {total.toLocaleString("es-HN")} productos.
        </p>

        {products.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/15 bg-white p-8 text-center">
            <h2 className="text-xl font-semibold">No se encontraron resultados con estos filtros.</h2>
            <p className="mt-2 text-sm text-black/55">Prueba con otra busqueda, categoria, precio o compatibilidad.</p>
            <Link
              href="/catalogo"
              className="mt-4 inline-flex items-center justify-center rounded-md bg-[#080808] px-4 py-2 text-sm font-semibold text-white transition-all hover:-translate-y-0.5 hover:bg-[#e4252c]"
            >
              Limpiar filtros
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-3">
            {products.map((product) => (
              <CatalogProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
        {hasNextPage ? (
          <div className="flex justify-center">
            <Link
              href={buildHref(page + 1)}
              className="rounded-md border border-black/10 bg-white px-4 py-3 text-sm font-semibold transition-all hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:bg-[#fff1f2]"
            >
              Ver siguiente pagina
            </Link>
          </div>
        ) : null}
      </div>

      <aside className="space-y-4">
        <WholesaleCodePanel />
        <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
          <h2 className="font-semibold">Atencion comercial</h2>
          <p className="mt-2 text-sm text-black/60">
            Para pedidos de volumen, solicita tu codigo mayorista y el catalogo cambiara a precio mayorista.
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
