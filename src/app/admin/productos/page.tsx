import Link from "next/link";
import nextDynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { CommercialNav } from "@/components/admin/commercial-nav";
import { SellerProducts } from "@/components/admin/seller-products";
import { getProductCapabilities, requireProductCapability } from "@/lib/auth/product-access";
import { getAdminProductCatalogPage } from "@/services/supabase/admin-products.service";

export const dynamic = "force-dynamic";

const ProductManager = nextDynamic(
  () => import("@/components/admin/product-manager").then((module) => module.ProductManager),
  { loading: () => <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">Cargando productos...</div> },
);

export default async function AdminProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; category?: string; page?: string }>;
}) {
  const profile = await requireProductCapability("read");
  if (profile.role === "vendedor") return <AdminShell title="Productos" variant="wide" eyebrow="Panel de ventas" backHref="/admin"><CommercialNav sellerMode/><SellerProducts/></AdminShell>;
  const capabilities = getProductCapabilities(profile);
  const params = await searchParams;
  const { products, categories, vehicleBrands, vehicleModels, total, page, pageSize, summary } = await getAdminProductCatalogPage(
    {
      query: params.q,
      status: params.status,
      categoryId: params.category,
      page: Number(params.page ?? 1),
      pageSize: 50,
    },
    { includeCost: capabilities.viewCost },
  );

  return (
    <AdminShell title="Productos">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <ProductManager
        key={`${params.q ?? ""}:${params.status ?? "all"}:${params.category ?? "all"}:${page}`}
        products={products}
        categories={categories}
        vehicleBrands={vehicleBrands}
        vehicleModels={vehicleModels}
        total={total}
        page={page}
        pageSize={pageSize}
        summary={summary}
        capabilities={capabilities}
        filters={{
          query: params.q ?? "",
          status: params.status ?? "all",
          categoryId: params.category ?? "all",
        }}
      />
    </AdminShell>
  );
}
