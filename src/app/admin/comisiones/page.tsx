import { AdminShell } from "@/components/admin/admin-shell";
import { CommissionsManager } from "@/components/admin/commissions-manager";
import { requirePermission } from "@/lib/auth/session";
import { Phase4CommercialNav } from "@/components/admin/phase4-commercial-nav";
export const dynamic="force-dynamic";
export default async function CommissionsPage(){await requirePermission("commissions:read_all");return <AdminShell title="Gestion de comisiones" variant="wide" backHref="/admin"><Phase4CommercialNav/><CommissionsManager/></AdminShell>}
