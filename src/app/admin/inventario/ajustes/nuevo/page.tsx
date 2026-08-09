import Link from "next/link";
import { AdminBackButton } from "@/components/admin/admin-back-button";
import { AdminShell } from "@/components/admin/admin-shell";
import { InventoryAdjustmentBuilder } from "@/components/admin/inventory-adjustment-builder";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";

export const dynamic="force-dynamic";
function hondurasToday(){const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/Tegucigalpa",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const get=(t:string)=>parts.find(p=>p.type===t)?.value??"";return `${get("year")}-${get("month")}-${get("day")}`;}
export default async function NewInventoryAdjustmentPage(){const profile=await requirePermission("inventory:adjust_create");const canCost=hasEffectivePermission(profile.role,profile.permissions,"inventory:cost_read",profile.email);const canConfirm=hasEffectivePermission(profile.role,profile.permissions,"inventory:adjust_confirm",profile.email);return <AdminShell title="Crear ajuste de inventario"><AdminBackButton/><div className="mb-5 flex flex-wrap gap-2"><Link href="/admin/inventario/ajustes" className="min-h-11 rounded-lg border border-black/10 px-4 py-2.5 font-semibold">Historial</Link><span className="min-h-11 rounded-lg bg-black px-4 py-2.5 font-semibold text-white">Crear ajuste</span></div><InventoryAdjustmentBuilder today={hondurasToday()} canCost={canCost} canConfirm={canConfirm}/></AdminShell>}
