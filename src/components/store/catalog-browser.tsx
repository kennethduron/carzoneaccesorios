"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
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
    vehicleOptions: Array<{
      vehicleBrand: string;
      vehicleModel: string;
      vehicleYearStart: number | null;
      vehicleYearEnd: number | null;
    }>;
  };
};

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right, "es-HN"));
}

function normalizeComparable(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function yearsFromRange(start: number | null, end: number | null) {
  if (!start && !end) {
    return [];
  }

  const firstYear = start ?? end;
  const lastYear = end ?? start;

  if (!firstYear || !lastYear) {
    return [];
  }

  const years: number[] = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    years.push(year);
  }
  return years;
}

const emptyVehicleOptions: NonNullable<CatalogBrowserProps["filterOptions"]["vehicleOptions"]> = [];

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
  const isEmptyCatalog = total === 0 && !hasActiveFilters;
  const vehicleOptions = useMemo(() => filterOptions.vehicleOptions ?? emptyVehicleOptions, [filterOptions.vehicleOptions]);

  const availableVehicleBrands = useMemo(() => {
    const brands = vehicleOptions.length > 0 ? vehicleOptions.map((option) => option.vehicleBrand) : filterOptions.vehicleBrands;
    return uniqueSorted(brands);
  }, [filterOptions.vehicleBrands, vehicleOptions]);

  const availableVehicleModels = useMemo(() => {
    const normalizedBrand = normalizeComparable(selectedVehicleBrand);
    const models =
      vehicleOptions.length > 0
        ? vehicleOptions
            .filter((option) => !normalizedBrand || normalizeComparable(option.vehicleBrand) === normalizedBrand)
            .map((option) => option.vehicleModel)
        : filterOptions.vehicleModels;

    return uniqueSorted(models);
  }, [filterOptions.vehicleModels, selectedVehicleBrand, vehicleOptions]);

  const availableVehicleYears = useMemo(() => {
    const normalizedBrand = normalizeComparable(selectedVehicleBrand);
    const normalizedModel = normalizeComparable(selectedVehicleModel);
    const years =
      vehicleOptions.length > 0
        ? vehicleOptions
            .filter((option) => !normalizedBrand || normalizeComparable(option.vehicleBrand) === normalizedBrand)
            .filter((option) => !normalizedModel || normalizeComparable(option.vehicleModel) === normalizedModel)
            .flatMap((option) => yearsFromRange(option.vehicleYearStart, option.vehicleYearEnd))
        : filterOptions.vehicleYears;

    return Array.from(new Set(years)).sort((left, right) => right - left);
  }, [filterOptions.vehicleYears, selectedVehicleBrand, selectedVehicleModel, vehicleOptions]);

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
            placeholder="Nombre, SKU, código, categoría o vehículo"
            className="w-full bg-transparent text-sm outline-none placeholder:text-black/40"
          />
        </label>
        <select
          value={selectedCategory}
          name="categoria"
          onChange={(event) => setSelectedCategory(event.target.value)}
          className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
        >
          <option value="">Todas las categorías</option>
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
        <FilterField label="Marca del vehículo">
          <select
            name="marca_carro"
            value={selectedVehicleBrand}
            onChange={(event) => {
              setSelectedVehicleBrand(event.target.value);
              setSelectedVehicleModel("");
              setSelectedVehicleYear("");
            }}
            className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
          >
            <option value="">Todas</option>
            {availableVehicleBrands.map((brand) => (
              <option key={brand} value={brand}>
                {brand}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Modelo del vehículo">
          <select
            name="modelo_carro"
            value={selectedVehicleModel}
            onChange={(event) => {
              setSelectedVehicleModel(event.target.value);
              setSelectedVehicleYear("");
            }}
            className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
          >
            <option value="">Todos</option>
            {availableVehicleModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Año del vehículo">
          <select
            name="anio_carro"
            value={selectedVehicleYear}
            onChange={(event) => setSelectedVehicleYear(event.target.value)}
            className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
          >
            <option value="">Todos</option>
            {availableVehicleYears.map((year) => (
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
              <p className="mt-1 text-sm text-black/55">Combina búsqueda, categoría, precio, stock y compatibilidad.</p>
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
            <span>El filtro de precio usa el precio disponible según tu acceso.</span>
            <Car size={14} />
            <span>Compatibilidad por marca, modelo y año del vehículo.</span>
          </div>
        </form>

        {filtersOpen ? (
          <div className="cz-layer-overlay fixed inset-0 md:hidden">
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
            <h2 className="text-xl font-semibold">
              {isEmptyCatalog ? "Pronto encontrarás productos disponibles." : "No se encontraron resultados con estos filtros."}
            </h2>
            <p className="mt-2 text-sm text-black/55">
              {isEmptyCatalog
                ? "Estamos preparando el catálogo. Vuelve pronto o contáctanos para consultar disponibilidad."
                : "Prueba con otra búsqueda, categoría, precio o compatibilidad."}
            </p>
            {isEmptyCatalog ? null : (
              <Link
                href="/catalogo"
                className="mt-4 inline-flex items-center justify-center rounded-md bg-[#080808] px-4 py-2 text-sm font-semibold text-white transition-all hover:-translate-y-0.5 hover:bg-[#e4252c]"
              >
                Limpiar filtros
              </Link>
            )}
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
              Ver siguiente página
            </Link>
          </div>
        ) : null}
      </div>

      <aside className="space-y-4">
        <WholesaleCodePanel />
        <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
          <h2 className="font-semibold">Atención comercial</h2>
          <p className="mt-2 text-sm text-black/60">
            Para pedidos de volumen, inicia sesión o solicita acceso mayorista. Los precios especiales se activan solo para cuentas aprobadas.
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
