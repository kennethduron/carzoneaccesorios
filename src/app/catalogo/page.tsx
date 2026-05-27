import type { Metadata } from "next";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { CatalogBrowser } from "@/components/store/catalog-browser";
import { WholesaleRequirementSummary } from "@/components/store/wholesale-program-info";
import { getWholesaleAccessStateAction } from "@/app/actions/wholesale";
import { getCatalogProducts } from "@/services/supabase/products.service";
import { normalizeVehicleBrand, normalizeVehicleModel } from "@/utils/vehicle-compatibility";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Catálogo de accesorios automotrices",
  description:
    "Explora el catálogo de accesorios automotrices de Car Zone Accesorios con filtros por categoría, vehículo, precio y disponibilidad.",
  alternates: {
    canonical: "/catalogo",
  },
  openGraph: {
    title: "Catálogo de accesorios automotrices | Car Zone Accesorios",
    description:
      "Accesorios automotrices preparados para venta al detalle y cuentas mayoristas.",
    url: "/catalogo",
  },
};

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
  const vehicleBrand = normalizeVehicleBrand(params.marca_carro);
  const vehicleModel = normalizeVehicleModel(params.modelo_carro);
  const wholesaleState = await getWholesaleAccessStateAction();
  const priceMode = wholesaleState.account ? "wholesale" : "retail";
  const firstPurchaseRequirement = wholesaleState.firstPurchaseRequirement;
  const catalog = await getCatalogProducts({
    query: params.q,
    category: params.categoria,
    page: Number(params.page ?? 1),
    pageSize: 24,
    minPrice: optionalNumberParam(params.precio_min),
    maxPrice: optionalNumberParam(params.precio_max),
    vehicleBrand: vehicleBrand ?? undefined,
    vehicleModel: vehicleModel ?? undefined,
    vehicleYear: optionalNumberParam(params.anio_carro),
    availability: params.disponibilidad,
    priceMode,
  });

  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-7xl px-5 pt-8">
        <p className="text-sm text-black/50">Tienda pública</p>
        <h1 className="mt-2 text-4xl font-semibold">Catálogo</h1>
        {wholesaleState.kind === "approved" &&
        firstPurchaseRequirement &&
        !firstPurchaseRequirement.completed &&
        firstPurchaseRequirement.minimum > 0 ? (
          <div className="mt-5">
            <WholesaleRequirementSummary requirement={firstPurchaseRequirement} />
            <p className="mt-2 text-sm text-black/55">
              Recuerda: tu primera compra mayorista debe alcanzar un total final de L 10,000.00 o más.
            </p>
          </div>
        ) : null}
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
        vehicleBrand={vehicleBrand ?? ""}
        vehicleModel={vehicleModel ?? ""}
        vehicleYear={params.anio_carro ?? ""}
        availability={params.disponibilidad ?? ""}
        filterOptions={catalog.filterOptions}
      />
    </PublicStoreShell>
  );
}
