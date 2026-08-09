"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { reverseInventoryAdjustmentAction } from "@/app/admin/inventario/ajustes/actions";
import { PosConfirmationDialog } from "@/components/admin/pos-confirmation-dialog";
import { useToast } from "@/contexts/toast-context";
import type { InventoryAdjustmentDocument } from "@/types/inventory-adjustments";

const statusLabels: Record<string, string> = {
  draft: "Borrador",
  confirmed: "Confirmado",
  cancelled: "Cancelado",
  reversed: "Revertido",
};

const reasonLabels: Record<string, string> = {
  physical_count_surplus: "Sobrante en conteo físico",
  recovery: "Recuperación",
  physical_count_shortage: "Faltante en conteo físico",
  damage_or_shrinkage: "Daño o merma",
  loss: "Pérdida",
  operational_error: "Error operativo",
  other: "Otro",
  reversal: "Reversión completa",
};

export function InventoryAdjustmentDetail({document,canReverse,canCost}:{document:InventoryAdjustmentDocument;canReverse:boolean;canCost:boolean}){const [dialog,setDialog]=useState(false);const [pending,startTransition]=useTransition();const toast=useToast();const router=useRouter();function reverse(){startTransition(async()=>{const r=await reverseInventoryAdjustmentAction(document.id,crypto.randomUUID());if(r.ok){toast.success(r.message);router.refresh();router.push(`/admin/inventario/ajustes/${r.id}`);}else toast.error(r.message);setDialog(false);});}return <div className="space-y-5"><section className="grid gap-3 rounded-xl border border-black/10 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"><Info label="Número" value={document.adjustment_number}/><Info label="Estado" value={statusLabels[document.status]??document.status}/><Info label="Fecha efectiva" value={document.effective_date}/><Info label="Contabilidad" value={document.accounting_status==="pending_mapping"?"Mapeo pendiente":document.accounting_status}/><Info label="Bodega" value="Principal — Inventario general"/><Info label="Usuario" value={document.created_by_name}/><Info label="Referencia" value={document.reference||"Sin referencia"}/>{canCost?<Info label="Valor total" value={`L ${(document.total_cost??0).toLocaleString("es-HN",{minimumFractionDigits:2})}`}/>:null}{document.notes?<div className="sm:col-span-2 lg:col-span-4"><Info label="Observación" value={document.notes}/></div>:null}</section><section className="overflow-hidden rounded-xl border border-black/10 bg-white"><div className="border-b p-4"><h2 className="font-semibold">Líneas inmutables</h2><p className="text-sm text-black/50">Snapshots capturados por el servidor al confirmar.</p></div><div className="grid gap-3 p-3 md:hidden">{document.lines.map(line=><article key={line.id} className="rounded-lg border p-4"><h3 className="font-semibold">{line.product_name_snapshot}</h3><p className="text-xs text-black/50">{line.product_sku_snapshot}</p><dl className="mt-3 grid grid-cols-3 gap-2"><Info label="Antes" value={String(line.stock_before)}/><Info label="Reservado" value={String(line.reserved_before)}/><Info label="Después" value={String(line.stock_after??"—")}/></dl><p className="mt-3 text-sm">{line.direction==="increase"?"Incremento":"Disminución"} · {line.quantity} · {reasonLabels[line.reason_code]??line.reason_code}</p>{line.reason_detail?<p className="mt-1 text-sm text-black/60">{line.reason_detail}</p>:null}{canCost?<p className="mt-1 text-sm text-black/60">Costo: L {(line.unit_cost_snapshot??0).toLocaleString("es-HN",{minimumFractionDigits:2})}</p>:null}</article>)}</div><div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[850px] text-left text-sm"><thead className="bg-[#e7e5e4] text-xs uppercase text-black/55"><tr>{["Producto","Tipo","Cantidad","Motivo","Stock antes","Reservado","Disponible","Stock después",...(canCost?["Costo"]:[])].map(h=><th key={h} className="px-3 py-3">{h}</th>)}</tr></thead><tbody className="divide-y">{document.lines.map(line=><tr key={line.id}><td className="px-3 py-3"><strong>{line.product_name_snapshot}</strong><span className="block text-xs text-black/45">{line.product_sku_snapshot}</span></td><td className="px-3 py-3">{line.direction==="increase"?"Incremento":"Disminución"}</td><td className="px-3 py-3">{line.quantity}</td><td className="px-3 py-3">{reasonLabels[line.reason_code]??line.reason_code}{line.reason_detail?<span className="block text-xs">{line.reason_detail}</span>:null}</td><td className="px-3 py-3">{line.stock_before}</td><td className="px-3 py-3">{line.reserved_before}</td><td className="px-3 py-3">{line.available_before}</td><td className="px-3 py-3 font-semibold">{line.stock_after??"—"}</td>{canCost?<td className="px-3 py-3">L {(line.unit_cost_snapshot??0).toLocaleString("es-HN",{minimumFractionDigits:2})}</td>:null}</tr>)}</tbody></table></div></section>{canReverse&&document.status==="confirmed"&&!document.reversal_of_id?<button type="button" onClick={()=>setDialog(true)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-200 px-4 font-semibold text-red-700"><RotateCcw aria-hidden size={18}/>Revertir ajuste completo</button>:null}{dialog?<PosConfirmationDialog title="Revertir ajuste completo" description="Se creará un documento inverso con movimientos opuestos. El original permanecerá intacto y la operación se rechazará si las reservas actuales no permiten revertirla." confirmLabel="Revertir completamente" cancelLabel="Cancelar" pending={pending} onCancel={()=>setDialog(false)} onConfirm={reverse}/>:null}</div>}
function Info({label,value}:{label:string;value:string}){return <div className="min-w-0"><dt className="text-xs uppercase text-black/45">{label}</dt><dd className="mt-1 break-words font-semibold">{value}</dd></div>}
