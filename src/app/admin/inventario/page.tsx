import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { InventoryManager } from "@/components/admin/inventory-manager";
import { requirePermission } from "@/lib/auth/session";
import { getAdminInventory } from "@/services/supabase/admin-inventory.service";

export const dynamic = "force-dynamic";

export default async function AdminInventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; mov_page?: string }>;
}) {
  await requirePermission("inventory:manage");
  const params = await searchParams;
  const { products, movements, summary } = await getAdminInventory({
    query: params.q,
    movementPage: Number(params.mov_page ?? 1),
    movementPageSize: 50,
  });

  return (
    <AdminShell title="Inventario">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <InventoryManager products={products} movements={movements} summary={summary} productQuery={params.q ?? ""} />
    </AdminShell>
  );
}
