import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ProductManager } from "@/components/admin/product-manager";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";
import { getAdminProductCatalogPage } from "@/services/supabase/admin-products.service";

export const dynamic = "force-dynamic";

export default async function AdminProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; category?: string; page?: string }>;
}) {
  await requirePermission("products:manage");
  const params = await searchParams;
  const { products, categories, total, page, pageSize } = await getAdminProductCatalogPage({
    query: params.q,
    status: params.status,
    categoryId: params.category,
    page: Number(params.page ?? 1),
    pageSize: 50,
  });

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
        products={products}
        categories={categories}
        total={total}
        page={page}
        pageSize={pageSize}
        filters={{
          query: params.q ?? "",
          status: params.status ?? "all",
          categoryId: params.category ?? "all",
        }}
      />
    </AdminShell>
  );
}
