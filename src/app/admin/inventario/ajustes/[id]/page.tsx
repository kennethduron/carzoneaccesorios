import Link from "next/link";
import { AdminBackButton } from "@/components/admin/admin-back-button";
import { AdminShell } from "@/components/admin/admin-shell";
import { InventoryAdjustmentDetail } from "@/components/admin/inventory-adjustment-detail";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getInventoryAdjustment } from "@/services/supabase/inventory-adjustments.service";
export const dynamic="force-dynamic";
export default async function InventoryAdjustmentDetailPage({params}:{params:Promise<{id:string}>}){const profile=await requirePermission("inventory:adjust_read");const {id}=await params;const document=await getInventoryAdjustment(id);const canReverse=hasEffectivePermission(profile.role,profile.permissions,"inventory:adjust_reverse",profile.email);const canCost=hasEffectivePermission(profile.role,profile.permissions,"inventory:cost_read",profile.email);return <AdminShell title={`Ajuste ${document.adjustment_number}`}><AdminBackButton/><div className="mb-5"><Link href="/admin/inventario/ajustes" className="inline-flex min-h-11 items-center rounded-lg border border-black/10 px-4 font-semibold">Volver al historial</Link></div><InventoryAdjustmentDetail document={document} canReverse={canReverse} canCost={canCost}/></AdminShell>}
