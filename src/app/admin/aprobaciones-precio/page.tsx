import { AdminShell } from "@/components/admin/admin-shell";
import { CommercialNav } from "@/components/admin/commercial-nav";
import { PriceApprovalsDashboard } from "@/components/admin/price-approvals-dashboard";
import { requirePermission } from "@/lib/auth/session";
export const dynamic="force-dynamic";
export default async function ApprovalsPage({searchParams}:{searchParams:Promise<{request?:string}>}){await requirePermission("pos:price_approvals:read");const {request}=await searchParams;return <AdminShell title="Aprobaciones de precio" variant="wide" backHref="/admin" backLabel="Volver al inicio"><CommercialNav canApprove/><PriceApprovalsDashboard initialRequestId={request}/></AdminShell>}
