import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { PosWorkspace } from "@/components/admin/pos-workspace";
import { CommercialNav } from "@/components/admin/commercial-nav";
import { hasDatabasePosPermission } from "@/lib/auth/pos-server-authorization";
import { hasPosPermission } from "@/lib/auth/pos-permissions";
import { requirePermission } from "@/lib/auth/session";
import { getPosCreditOverdueOverrideCapability } from "@/services/supabase/pos-draft.service";

export const dynamic = "force-dynamic";

export default async function PointOfSalePage() {
  const profile = await requirePermission("pos:access");
  const [databaseAccess, databaseSearch, creditOverrideCapability] = await Promise.all([
    hasDatabasePosPermission("pos:access"),
    hasDatabasePosPermission("pos:customers:search"),
    getPosCreditOverdueOverrideCapability(),
  ]);
  const allowed = hasPosPermission(profile, "pos:access")
    && hasPosPermission(profile, "pos:customers:search")
    && databaseAccess
    && databaseSearch;

  if (!allowed) redirect("/sin-permiso");

  return (
    <AdminShell title="Punto de Venta" variant="wide" backHref="/admin" backLabel="Volver al inicio">
      <main className="mx-auto w-full px-0 py-1 sm:px-1 lg:px-2">
        <CommercialNav canApprove={profile.permissions.includes("pos:price_approvals:read")} />
        <PosWorkspace
          operatorName={profile.full_name ?? profile.username ?? profile.email ?? "Usuario autorizado"}
          creditOverrideCapability={creditOverrideCapability}
          sellerMode={profile.role === "vendedor"}
        />
      </main>
    </AdminShell>
  );
}
