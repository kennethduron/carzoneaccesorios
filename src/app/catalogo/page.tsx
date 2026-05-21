import { PublicStoreShell } from "@/components/store/public-store-shell";
import { CatalogBrowser } from "@/components/store/catalog-browser";
import { getCatalogProducts } from "@/services/supabase/products.service";

export const dynamic = "force-dynamic";

function optionalNumberParam(value: string | undefined) {
  if (!value?.trim()) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export default async function CatalogoPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    categoria?: string;
    page?: string;
    precio_min?: string;
    precio_max?: string;
    marca_carro?: string;
    modelo_carro?: string;
    anio_carro?: string;
    disponibilidad?: string;
  }>;
}) {
  const params = await searchParams;
  const catalog = await getCatalogProducts({
    query: params.q,
    category: params.categoria,
    page: Number(params.page ?? 1),
    pageSize: 24,
    minPrice: optionalNumberParam(params.precio_min),
    maxPrice: optionalNumberParam(params.precio_max),
    vehicleBrand: params.marca_carro,
    vehicleModel: params.modelo_carro,
    vehicleYear: optionalNumberParam(params.anio_carro),
    availability: params.disponibilidad,
  });

  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-7xl px-5 pt-8">
        <p className="text-sm text-black/50">Tienda pública</p>
        <h1 className="mt-2 text-4xl font-semibold">Catálogo</h1>
      </section>
      <CatalogBrowser
        products={catalog.products}
        categories={catalog.categories}
        total={catalog.total}
        page={catalog.page}
        pageSize={catalog.pageSize}
        query={params.q ?? ""}
        category={params.categoria ?? ""}
        minPrice={params.precio_min ?? ""}
        maxPrice={params.precio_max ?? ""}
        vehicleBrand={params.marca_carro ?? ""}
        vehicleModel={params.modelo_carro ?? ""}
        vehicleYear={params.anio_carro ?? ""}
        availability={params.disponibilidad ?? ""}
        filterOptions={catalog.filterOptions}
      />
    </PublicStoreShell>
  );
}
