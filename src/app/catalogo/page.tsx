import type { Metadata } from "next";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { CatalogBrowser } from "@/components/store/catalog-browser";
import { WholesaleRequirementSummary } from "@/components/store/wholesale-program-info";
import { getWholesaleAccessStateAction } from "@/app/actions/wholesale";
import { getCatalogProducts, getCategorySummaries } from "@/services/supabase/products.service";
import { createPublicMetadata } from "@/lib/seo";
import { normalizeProductCategorySlug } from "@/lib/product-categories";
import { normalizeVehicleBrand, normalizeVehicleModel } from "@/utils/vehicle-compatibility";

export const dynamic = "force-dynamic";

type CatalogSearchParams = {
  q?: string;
  categoria?: string;
  page?: string;
  precio_min?: string;
  precio_max?: string;
  marca_carro?: string;
  modelo_carro?: string;
  anio_carro?: string;
  disponibilidad?: string;
};

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<CatalogSearchParams>;
}): Promise<Metadata> {
  const params = await searchParams;
  const categories = await getCategorySummaries();
  const canonicalCategorySlug = normalizeProductCategorySlug(params.categoria);
  const selectedCategory = categories.find((category) => category.slug === canonicalCategorySlug);
  const hasExtraFilters = Boolean(
    params.q ||
      (params.page && params.page !== "1") ||
      params.precio_min ||
      params.precio_max ||
      params.marca_carro ||
      params.modelo_carro ||
      params.anio_carro ||
      params.disponibilidad,
  );
  const path = selectedCategory ? `/catalogo?categoria=${encodeURIComponent(selectedCategory.slug)}` : "/catalogo";
  const title = selectedCategory
    ? `${selectedCategory.name} para carros en Honduras | Car Zone Accesorios`
    : "Catálogo de accesorios automotrices en Honduras | Car Zone Accesorios";
  const description = selectedCategory
    ? `Compra productos de ${selectedCategory.name} para carros en Car Zone Accesorios, con atención para clientes en Honduras.`
    : "Explora accesorios para carros, audio, luces LED, seguridad vehicular, repuestos y productos automotrices disponibles en Honduras.";
  const metadata = createPublicMetadata({ title, description, path, absoluteTitle: true });

  return hasExtraFilters
    ? {
        ...metadata,
        robots: {
          index: false,
          follow: true,
          googleBot: { index: false, follow: true },
        },
      }
    : metadata;
}

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
  searchParams: Promise<CatalogSearchParams>;
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
        <p className="mt-3 max-w-3xl text-sm leading-6 text-black/60">
          Encuentra accesorios para carros, audio, luces LED, seguridad vehicular y repuestos y accesorios con atención
          para clientes en San Pedro Sula, Tegucigalpa, La Ceiba, Choloma, El Progreso y otras ciudades de Honduras.
        </p>
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
