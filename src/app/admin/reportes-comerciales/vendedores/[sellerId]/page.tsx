import { AdminShell } from "@/components/admin/admin-shell";
import { CommercialReportsDashboardV2 } from "@/components/admin/commercial-reports-dashboard-v2";
import { Phase4CommercialNav } from "@/components/admin/phase4-commercial-nav";
import { requirePermission } from "@/lib/auth/session";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{sellerId:string}>}){await requirePermission("commercial:reports:read");const {sellerId}=await params;return <AdminShell title="Análisis del vendedor" variant="wide" backHref="/admin/reportes-comerciales" backLabel="Volver a reportes"><Phase4CommercialNav/><CommercialReportsDashboardV2 sellerId={sellerId}/></AdminShell>}
