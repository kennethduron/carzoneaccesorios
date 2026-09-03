import { AdminShell } from "@/components/admin/admin-shell";
import { CommercialNav } from "@/components/admin/commercial-nav";
import { MyCommissionsDashboard } from "@/components/admin/my-commissions-dashboard";
import { requirePermission } from "@/lib/auth/session";
export const dynamic="force-dynamic";
export default async function MyCommissionPage(){const profile=await requirePermission("commissions:read_own");return <AdminShell title="Mi comision" variant="wide" eyebrow="Panel de ventas" backHref="/admin"><CommercialNav sellerMode={profile.role==="vendedor"}/><MyCommissionsDashboard/></AdminShell>}
