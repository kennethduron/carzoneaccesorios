import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { InventoryManager } from "@/components/admin/inventory-manager";
import { requirePermission } from "@/lib/auth/session";
import { getAdminInventory } from "@/services/supabase/admin-inventory.service";

export const dynamic = "force-dynamic";

export default async function AdminInventoryPage() {
  await requirePermission("inventory:manage");
  const { products, movements } = await getAdminInventory();

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
      <InventoryManager products={products} movements={movements} />
    </AdminShell>
  );
}
