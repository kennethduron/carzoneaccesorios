import { AdminShell } from "@/components/admin/admin-shell";
import { ReportCenterV2 } from "@/components/admin/report-center-v2";
import { Phase4CommercialNav } from "@/components/admin/phase4-commercial-nav";
import { requirePermission } from "@/lib/auth/session";
export const dynamic="force-dynamic";
export default async function Page(){await requirePermission("commercial:reports:generate");return <AdminShell title="Centro de reportes" variant="wide" backHref="/admin"><Phase4CommercialNav/><ReportCenterV2/></AdminShell>}
