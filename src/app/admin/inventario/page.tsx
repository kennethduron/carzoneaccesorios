import { redirect } from "next/navigation";
import { AdminBackButton } from "@/components/admin/admin-back-button";
import { AdminShell } from "@/components/admin/admin-shell";
import { InventoryManager } from "@/components/admin/inventory-manager";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getAdminInventory } from "@/services/supabase/admin-inventory.service";

export const dynamic = "force-dynamic";

export default async function AdminInventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string; mov_page?: string }>;
}) {
  const profile = await requirePermission("admin:access");
  const canManageInventory = hasEffectivePermission(profile.role, profile.permissions, "inventory:manage", profile.email);
  const canReadInventory =
    canManageInventory || hasEffectivePermission(profile.role, profile.permissions, "inventory:read", profile.email);

  if (!canReadInventory) {
    redirect("/sin-permiso");
  }

  const params = await searchParams;
  const activeFilter = params.filter === "low_stock" ? { id: "low_stock" as const, label: "Productos con bajo stock o sin stock" } : null;
  const { products, movements, summary } = await getAdminInventory({
    query: params.q,
    filter: activeFilter?.id ?? null,
    movementPage: Number(params.mov_page ?? 1),
    movementPageSize: 50,
  });

  return (
    <AdminShell title={canManageInventory ? "Inventario" : "Inventario — Consulta"}>
      <AdminBackButton />
      <InventoryManager
        products={products}
        movements={movements}
        summary={summary}
        productQuery={params.q ?? ""}
        activeFilter={activeFilter}
        canManageInventory={canManageInventory}
      />
    </AdminShell>
  );
}
