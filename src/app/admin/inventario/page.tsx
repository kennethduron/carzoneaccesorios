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
  searchParams: Promise<{ q?: string; filter?: string; mov_page?: string }>;
}) {
  await requirePermission("inventory:manage");
  const params = await searchParams;
  const activeFilter = params.filter === "low_stock" ? { id: "low_stock" as const, label: "Productos con bajo stock o sin stock" } : null;
  const { products, movements, summary } = await getAdminInventory({
    query: params.q,
    filter: activeFilter?.id ?? null,
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
      <InventoryManager
        products={products}
        movements={movements}
        summary={summary}
        productQuery={params.q ?? ""}
        activeFilter={activeFilter}
      />
    </AdminShell>
  );
}
