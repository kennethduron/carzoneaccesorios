import { AdminShell } from "@/components/admin/admin-shell";
import { CommercialReportsDashboardV2 } from "@/components/admin/commercial-reports-dashboard-v2";
import { Phase4CommercialNav } from "@/components/admin/phase4-commercial-nav";
import { requirePermission } from "@/lib/auth/session";
export const dynamic="force-dynamic";
export default async function Page(){await requirePermission("commercial:reports:read");return <AdminShell title="Reportes comerciales" variant="wide" backHref="/admin"><Phase4CommercialNav/><CommercialReportsDashboardV2/></AdminShell>}
