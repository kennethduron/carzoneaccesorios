import { AdminShell } from "@/components/admin/admin-shell";
import { SellersManager } from "@/components/admin/sellers-manager";
import { requirePermission } from "@/lib/auth/session";
export const dynamic="force-dynamic";
export default async function SellersPage(){await requirePermission("commissions:read_all");return <AdminShell title="Vendedores" variant="wide" backHref="/admin"><SellersManager/></AdminShell>}
