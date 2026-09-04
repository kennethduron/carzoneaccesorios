import { AdminShell } from "@/components/admin/admin-shell";
import { CommissionPoliciesManager } from "@/components/admin/commission-policies-manager";
import { Phase4CommercialNav } from "@/components/admin/phase4-commercial-nav";
import { requirePermission } from "@/lib/auth/session";
export const dynamic="force-dynamic";
export default async function Page(){await requirePermission("commissions:policies:manage");return <AdminShell title="Políticas de comisión" variant="wide" backHref="/admin"><Phase4CommercialNav/><CommissionPoliciesManager/></AdminShell>}
