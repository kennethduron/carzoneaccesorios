"use client";

import type { ReactNode } from "react";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, CheckCircle2, Edit3, PlusCircle, Search, X } from "lucide-react";
import { cancelPurchaseAction, confirmPurchaseAction, savePurchaseAction, type PurchaseFormInput } from "@/app/admin/compras/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { AdminPurchase, ProductPurchaseOption, PurchasesSummary, SupplierOption } from "@/types/purchases";
import { formatCurrency } from "@/utils/pricing";

type LineDraft = PurchaseFormInput["items"][number] & { key: string };
type PurchaseDraft = Omit<PurchaseFormInput, "items"> & { items: LineDraft[] };

const statusLabels: Record<string, string> = {
  draft: "Borrador",
  confirmed: "Confirmada",
  received: "Recibida",
  cancelled: "Cancelada",
  returned: "Devuelta",
};

function todayValue() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(new Date());
}

function newLine(): LineDraft {
  return { key: crypto.randomUUID(), product_id: "", description: "", quantity: 1, unit_cost: 0, tax_amount: 0, discount_amount: 0 };
}

function emptyDraft(): PurchaseDraft {
  return { supplier_id: "", purchase_number: "", purchase_date: todayValue(), shipping_amount: 0, currency: "HNL", notes: "", items: [newLine()] };
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-HN", { dateStyle: "medium" }).format(new Date(`${value.slice(0, 10)}T00:00:00-06:00`));
}

function lineTotal(line: LineDraft) {
  const quantity = Number(line.quantity || 0);
  const unitCost = Number(line.unit_cost || 0);
  const tax = Number(line.tax_amount || 0);
  const discount = Number(line.discount_amount || 0);
  return Math.max(Math.round((quantity * unitCost + tax - discount) * 100) / 100, 0);
}

export function PurchasesManager({
  purchases,
  suppliers,
  products,
  summary,
  canManage,
}: {
  purchases: AdminPurchase[];
  suppliers: SupplierOption[];
  products: ProductPurchaseOption[];
  summary: PurchasesSummary;
  canManage: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [draft, setDraft] = useState<PurchaseDraft>(emptyDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(purchases[0]?.id ?? null);
  const [isPending, startTransition] = useTransition();

  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);

  const visiblePurchases = useMemo(() => {
    const needle = normalize(query.trim());
    return purchases.filter((purchase) => {
      if (statusFilter === "active" && ["cancelled", "returned"].includes(purchase.status)) return false;
      if (statusFilter !== "active" && statusFilter !== "all" && purchase.status !== statusFilter) return false;
      if (supplierFilter !== "all" && purchase.supplier_id !== supplierFilter) return false;
      if (!needle) return true;
      return normalize([purchase.purchase_number, purchase.supplier_name, purchase.notes, statusLabels[purchase.status]].filter(Boolean).join(" ")).includes(needle);
    });
  }, [purchases, query, statusFilter, supplierFilter]);

  const selectedPurchase = purchases.find((purchase) => purchase.id === selectedId) ?? visiblePurchases[0] ?? null;
  const draftTotals = useMemo(() => {
    const subtotal = draft.items.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unit_cost || 0), 0);
    const tax = draft.items.reduce((sum, line) => sum + Number(line.tax_amount || 0), 0);
    const discount = draft.items.reduce((sum, line) => sum + Number(line.discount_amount || 0), 0);
    const shipping = Number(draft.shipping_amount || 0);
    return { subtotal, tax, discount, shipping, total: Math.max(subtotal + tax + shipping - discount, 0) };
  }, [draft]);

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setDraft((current) => ({ ...current, items: current.items.map((line) => (line.key === key ? { ...line, ...patch } : line)) }));
  }

  function chooseProduct(line: LineDraft, productId: string) {
    const product = productById.get(productId);
    updateLine(line.key, {
      product_id: productId,
      description: product ? `${product.sku ? `${product.sku} - ` : ""}${product.name}` : line.description,
      unit_cost: product ? product.cost_price : line.unit_cost,
    });
  }

  function editPurchase(purchase: AdminPurchase) {
    setEditingId(purchase.id);
    setSelectedId(purchase.id);
    setDraft({
      id: purchase.id,
      supplier_id: purchase.supplier_id,
      purchase_number: purchase.purchase_number,
      purchase_date: purchase.purchase_date,
      shipping_amount: purchase.shipping_amount,
      currency: purchase.currency,
      notes: purchase.notes ?? "",
      items: purchase.items.length > 0 ? purchase.items.map((item) => ({ ...item, key: item.id, product_id: item.product_id ?? "" })) : [newLine()],
    });
  }

  function resetForm() {
    setEditingId(null);
    setDraft(emptyDraft());
  }

  function savePurchase() {
    if (!canManage) return;
    startTransition(async () => {
      const result = await savePurchaseAction({ ...draft, items: draft.items.map((line) => ({ id: line.id, product_id: line.product_id, description: line.description, quantity: line.quantity, unit_cost: line.unit_cost, tax_amount: line.tax_amount, discount_amount: line.discount_amount })) }).catch(() => ({ ok: false as const, message: "No se pudo guardar la compra." }));
      if (result.ok) {
        toast.success(result.message);
        resetForm();
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  function confirmPurchase(purchase: AdminPurchase) {
    startTransition(async () => {
      const result = await confirmPurchaseAction(purchase.id).catch(() => ({ ok: false as const, message: "No se pudo confirmar la compra." }));
      if (result.ok) { toast.success(result.message); router.refresh(); } else { toast.error(result.message); }
    });
  }

  function cancelPurchase(purchase: AdminPurchase) {
    startTransition(async () => {
      const result = await cancelPurchaseAction(purchase.id).catch(() => ({ ok: false as const, message: "No se pudo cancelar la compra." }));
      if (result.ok) { toast.success(result.message); router.refresh(); } else { toast.error(result.message); }
    });
  }

  return (
    <div className="min-w-0 space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Borradores" value={summary.totalDraft.toLocaleString("es-HN")} />
        <Metric label="Confirmadas" value={summary.totalConfirmed.toLocaleString("es-HN")} />
        <Metric label="Canceladas" value={summary.totalCancelled.toLocaleString("es-HN")} />
        <Metric label="Total operativo" value={formatCurrency(summary.totalAmount)} />
      </section>

      <section className="min-w-0 rounded-lg border border-black/10 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div><h2 className="text-lg font-semibold">Compras</h2><p className="text-sm text-black/55">Borradores, confirmacion y detalle operativo.</p></div>
          <div className="flex flex-wrap gap-2">
            {(["active", "draft", "confirmed", "cancelled", "all"] as const).map((status) => (
              <button key={status} type="button" onClick={() => setStatusFilter(status)} className={`rounded-md border px-3 py-2 text-sm font-semibold ${statusFilter === status ? "border-[#e4252c] bg-[#fff1f2] text-[#b91c25]" : "border-black/10 bg-white"}`}>{status === "active" ? "Activas" : status === "all" ? "Todas" : statusLabels[status]}</button>
            ))}
          </div>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px_auto] lg:items-center">
          <label className="flex min-w-0 items-center gap-2 rounded-md border border-black/10 px-3 py-2 focus-within:border-[#e4252c] focus-within:ring-2 focus-within:ring-[#e4252c]/15"><Search size={18} className="shrink-0 text-black/45" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por proveedor, numero o estado" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
          <select value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm"><option value="all">Todos los proveedores</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select>
          {query ? <Button type="button" variant="ghost" onClick={() => setQuery("")}><X size={16} />Limpiar</Button> : null}
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
          <div className="min-w-0 space-y-3">
            <div className="min-w-0 max-w-full overflow-x-auto rounded-md border border-black/10">
              <table className="w-full min-w-[900px] text-left text-sm [&_td]:break-words [&_td]:[overflow-wrap:anywhere]">
                <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55"><tr><th className="px-3 py-2">Compra</th><th className="px-3 py-2">Proveedor</th><th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2">Lineas</th><th className="px-3 py-2">Total</th><th className="px-3 py-2">Acciones</th></tr></thead>
                <tbody className="divide-y divide-black/10">
                  {visiblePurchases.map((purchase) => (
                    <tr key={purchase.id} className={purchase.id === selectedPurchase?.id ? "bg-[#fff7ed]" : undefined}>
                      <td className="px-3 py-3 align-top"><button type="button" onClick={() => setSelectedId(purchase.id)} className="break-words text-left font-semibold text-[#b91c25] [overflow-wrap:anywhere]">{purchase.purchase_number}</button></td>
                      <td className="px-3 py-3 align-top">{purchase.supplier_name}</td>
                      <td className="px-3 py-3 align-top">{formatDate(purchase.purchase_date)}</td>
                      <td className="px-3 py-3 align-top">{statusLabels[purchase.status]}</td>
                      <td className="px-3 py-3 align-top">{purchase.items.length.toLocaleString("es-HN")}</td>
                      <td className="px-3 py-3 align-top font-semibold">{formatCurrency(purchase.total)}</td>
                      <td className="px-3 py-3 align-top"><div className="flex flex-wrap gap-2"><Button type="button" variant="ghost" onClick={() => editPurchase(purchase)} disabled={!canManage || isPending || purchase.status !== "draft"}><Edit3 size={16} />Editar</Button><Button type="button" variant="ghost" onClick={() => confirmPurchase(purchase)} disabled={!canManage || isPending || purchase.status !== "draft"}><CheckCircle2 size={16} />Confirmar</Button><Button type="button" variant="ghost" onClick={() => cancelPurchase(purchase)} disabled={!canManage || isPending || !["draft", "confirmed"].includes(purchase.status)}><Ban size={16} />Cancelar</Button></div></td>
                    </tr>
                  ))}
                  {visiblePurchases.length === 0 ? <tr><td colSpan={7} className="px-3 py-6 text-center text-black/55">No hay compras para este filtro.</td></tr> : null}
                </tbody>
              </table>
            </div>

            {selectedPurchase ? <PurchaseDetails purchase={selectedPurchase} /> : null}
          </div>

          <div className="min-w-0 rounded-lg border border-black/10 bg-[#fafafa] p-4 [&_select]:min-w-0 [&_select]:w-full [&_textarea]:min-w-0 [&_textarea]:w-full">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{editingId ? "Editar compra" : "Registrar compra"}</h3><p className="text-sm text-black/55">Las lineas no crean movimientos de inventario.</p></div>{editingId ? <Button type="button" variant="ghost" onClick={resetForm}>Cancelar</Button> : null}</div>
            <div className="mt-4 grid gap-3">
              <Field label="Proveedor"><select value={draft.supplier_id} onChange={(event) => setDraft({ ...draft, supplier_id: event.target.value })} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm" disabled={!canManage || isPending}><option value="">Seleccionar</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}{supplier.is_active ? "" : " (inactivo)"}</option>)}</select></Field>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Numero de compra"><Input value={draft.purchase_number} onChange={(event) => setDraft({ ...draft, purchase_number: event.target.value })} disabled={!canManage || isPending} /></Field><Field label="Fecha de compra"><Input type="date" value={draft.purchase_date} onChange={(event) => setDraft({ ...draft, purchase_date: event.target.value })} disabled={!canManage || isPending} /></Field></div>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Envio"><Input type="number" min="0" step="0.01" value={draft.shipping_amount ?? 0} onChange={(event) => setDraft({ ...draft, shipping_amount: event.target.value })} disabled={!canManage || isPending} /></Field><Field label="Moneda"><Input value={draft.currency ?? "HNL"} onChange={(event) => setDraft({ ...draft, currency: event.target.value })} disabled={!canManage || isPending} /></Field></div>
              <Field label="Notas"><textarea value={draft.notes ?? ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} rows={2} className="rounded-md border border-black/10 px-3 py-2 text-sm" disabled={!canManage || isPending} /></Field>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3"><h4 className="font-semibold">Lineas</h4><Button type="button" variant="ghost" onClick={() => setDraft({ ...draft, items: [...draft.items, newLine()] })} disabled={!canManage || isPending}><PlusCircle size={16} />Agregar linea</Button></div>
                {draft.items.map((line, index) => (
                  <div key={line.key} className="rounded-md border border-black/10 bg-white p-3">
                    <p className="mb-2 text-sm font-semibold">Linea {index + 1}</p>
                    <div className="grid gap-2">
                      <select value={line.product_id ?? ""} onChange={(event) => chooseProduct(line, event.target.value)} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm" disabled={!canManage || isPending}><option value="">Sin producto vinculado</option>{products.map((product) => <option key={product.id} value={product.id}>{product.sku ? `${product.sku} - ` : ""}{product.name}</option>)}</select>
                      <Input value={line.description} onChange={(event) => updateLine(line.key, { description: event.target.value })} placeholder="Descripcion" disabled={!canManage || isPending} />
                      <div className="grid gap-2 sm:grid-cols-2"><Input type="number" min="0.01" step="0.01" value={line.quantity} onChange={(event) => updateLine(line.key, { quantity: event.target.value })} disabled={!canManage || isPending} /><Input type="number" min="0" step="0.01" value={line.unit_cost} onChange={(event) => updateLine(line.key, { unit_cost: event.target.value })} disabled={!canManage || isPending} /></div>
                      <div className="grid gap-2 sm:grid-cols-2"><Input type="number" min="0" step="0.01" value={line.tax_amount ?? 0} onChange={(event) => updateLine(line.key, { tax_amount: event.target.value })} disabled={!canManage || isPending} /><Input type="number" min="0" step="0.01" value={line.discount_amount ?? 0} onChange={(event) => updateLine(line.key, { discount_amount: event.target.value })} disabled={!canManage || isPending} /></div>
                      <p className="text-sm font-semibold">Total linea: {formatCurrency(lineTotal(line))}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid gap-2 rounded-md border border-black/10 bg-white p-3 text-sm"><TotalRow label="Subtotal" value={draftTotals.subtotal} /><TotalRow label="Impuesto" value={draftTotals.tax} /><TotalRow label="Descuento" value={draftTotals.discount} /><TotalRow label="Envio" value={draftTotals.shipping} /><TotalRow label="Total" value={draftTotals.total} strong /></div>
              <Button type="button" onClick={savePurchase} disabled={!canManage || isPending}><PlusCircle size={16} />{isPending ? "Guardando..." : "Guardar"}</Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function PurchaseDetails({ purchase }: { purchase: AdminPurchase }) {
  return <section className="min-w-0 rounded-lg border border-black/10 bg-white p-4"><div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-end sm:justify-between"><div className="min-w-0"><p className="text-sm text-black/50">Detalle de compra</p><h3 className="break-words text-lg font-semibold [overflow-wrap:anywhere]">{purchase.purchase_number}</h3></div><p className="font-semibold">{formatCurrency(purchase.total)}</p></div><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><Mini label="Proveedor" value={purchase.supplier_name} /><Mini label="Fecha" value={formatDate(purchase.purchase_date)} /><Mini label="Estado" value={statusLabels[purchase.status]} /><Mini label="Moneda" value={purchase.currency} /></div><div className="mt-4 min-w-0 max-w-full overflow-x-auto rounded-md border border-black/10"><table className="w-full min-w-[700px] text-left text-sm [&_td]:break-words [&_td]:[overflow-wrap:anywhere]"><thead className="bg-[#e7e5e4] text-xs uppercase text-black/55"><tr><th className="px-3 py-2">Descripcion</th><th className="px-3 py-2">Producto</th><th className="px-3 py-2">Cantidad</th><th className="px-3 py-2">Costo</th><th className="px-3 py-2">Impuesto</th><th className="px-3 py-2">Descuento</th><th className="px-3 py-2">Total</th></tr></thead><tbody className="divide-y divide-black/10">{purchase.items.map((item) => <tr key={item.id}><td className="px-3 py-2">{item.description}</td><td className="px-3 py-2">{item.product_sku ?? item.product_name ?? "Sin producto"}</td><td className="px-3 py-2">{item.quantity.toLocaleString("es-HN")}</td><td className="px-3 py-2">{formatCurrency(item.unit_cost)}</td><td className="px-3 py-2">{formatCurrency(item.tax_amount)}</td><td className="px-3 py-2">{formatCurrency(item.discount_amount)}</td><td className="px-3 py-2 font-semibold">{formatCurrency(item.total_cost)}</td></tr>)}{purchase.items.length === 0 ? <tr><td colSpan={7} className="px-3 py-5 text-center text-black/55">Sin lineas registradas.</td></tr> : null}</tbody></table></div></section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-lg border border-black/10 bg-white p-4"><p className="text-sm text-black/50">{label}</p><p className="mt-1 break-words text-2xl font-semibold [overflow-wrap:anywhere]">{value}</p></div>; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="grid min-w-0 gap-1 text-sm font-semibold [overflow-wrap:anywhere]">{label}{children}</label>; }
function Mini({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-md bg-[#f4f4f5] p-3"><p className="text-xs uppercase text-black/45">{label}</p><p className="mt-1 break-words font-semibold [overflow-wrap:anywhere]">{value}</p></div>; }
function TotalRow({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) { return <div className="flex items-center justify-between gap-3"><span className="text-black/55">{label}</span><span className={strong ? "font-semibold" : ""}>{formatCurrency(value)}</span></div>; }







