import { AdminShell } from "@/components/admin/admin-shell";
import { CommercialNav } from "@/components/admin/commercial-nav";
import { MySalesDashboard } from "@/components/admin/my-sales-dashboard";
import { requirePermission } from "@/lib/auth/session";
export const dynamic = "force-dynamic";
export default async function MySalesPage() {
  const profile = await requirePermission("pos:sales:read_own");
  return <AdminShell title="Mis ventas" variant="wide" eyebrow={profile.role === "vendedor" ? "Panel de ventas" : undefined} backHref="/admin" backLabel="Volver al inicio"><CommercialNav canApprove={profile.permissions.includes("pos:price_approvals:read")} sellerMode={profile.role === "vendedor"} /><MySalesDashboard /></AdminShell>;
}
