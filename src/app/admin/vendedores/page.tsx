import { AdminShell } from "@/components/admin/admin-shell";
import { SellersManager } from "@/components/admin/sellers-manager";
import { requirePermission } from "@/lib/auth/session";
import { Phase4CommercialNav } from "@/components/admin/phase4-commercial-nav";
export const dynamic="force-dynamic";
export default async function SellersPage(){await requirePermission("commissions:read_all");return <AdminShell title="Vendedores" variant="wide" backHref="/admin"><Phase4CommercialNav/><SellersManager/></AdminShell>}
