import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { PosWorkspace } from "@/components/admin/pos-workspace";
import { hasDatabasePosPermission } from "@/lib/auth/pos-server-authorization";
import { hasPosPermission } from "@/lib/auth/pos-permissions";
import { requirePermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function PointOfSalePage() {
  const profile = await requirePermission("pos:access");
  const [databaseAccess, databaseSearch] = await Promise.all([
    hasDatabasePosPermission("pos:access"),
    hasDatabasePosPermission("pos:customers:search"),
  ]);
  const allowed = hasPosPermission(profile, "pos:access")
    && hasPosPermission(profile, "pos:customers:search")
    && databaseAccess
    && databaseSearch;

  if (!allowed) redirect("/sin-permiso");

  return (
    <AdminShell title="Punto de Venta" variant="wide" backHref="/admin" backLabel="Volver al inicio">
      <main className="mx-auto w-full px-0 py-1 sm:px-1 lg:px-2">
        <PosWorkspace operatorName={profile.full_name ?? profile.username ?? profile.email ?? "Usuario autorizado"} />
      </main>
    </AdminShell>
  );
}
