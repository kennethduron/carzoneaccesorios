"use client";

import type { ReactNode } from "react";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, CheckCircle2, Edit3, PlusCircle, Search, Trash2, X } from "lucide-react";
import { cancelPurchaseAction, confirmPurchaseAction, registerPurchaseReturnAction, savePurchaseAction, type PurchaseConfirmationInput, type PurchaseFormInput, type PurchaseReturnFormInput } from "@/app/admin/compras/actions";
import { Button, Input } from "@/components/ui";
import { PurchaseProductCombobox } from "@/components/admin/purchase-product-combobox";
import { PurchaseConfirmationDialog } from "@/components/admin/purchase-confirmation-dialog";
import { useToast } from "@/contexts/toast-context";
import type { AdminPurchase, PurchasesSummary, SupplierOption } from "@/types/purchases";
import type { PurchaseProductSearchResult } from "@/types/admin-search";
import { formatCurrency } from "@/utils/pricing";

type LineDraft = PurchaseFormInput["items"][number] & { key: string; selectedProduct?: PurchaseProductSearchResult | null };
type PurchaseDraft = Omit<PurchaseFormInput, "items"> & { items: LineDraft[] };
type ReturnDraft = PurchaseReturnFormInput;

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

function emptyReturnDraft(purchaseId = ""): ReturnDraft {
  return { purchase_id: purchaseId, return_number: "", return_date: todayValue(), amount: "", reason: "" };
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

function LineNumberField({
  label,
  min,
  step = "0.01",
  value,
  onChange,
  disabled,
}: {
  label: string;
  min: string;
  step?: string;
  value: number | string | null | undefined;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] font-semibold uppercase leading-none text-black/50">{label}</span>
      <Input type="number" min={min} step={step} value={value ?? 0} onChange={(event) => onChange(event.target.value)} disabled={disabled} />
    </label>
  );
}

export function PurchasesManager({
  purchases,
  suppliers,
  summary,
  canManage,
  purchaseApAutomationEnabled,
  initialPurchaseId,
}: {
  purchases: AdminPurchase[];
  suppliers: SupplierOption[];
  summary: PurchasesSummary;
  canManage: boolean;
  purchaseApAutomationEnabled: boolean;
  initialPurchaseId: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [draft, setDraft] = useState<PurchaseDraft>(emptyDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const initialSelectedId = purchases.some((purchase) => purchase.id === initialPurchaseId) ? initialPurchaseId : purchases[0]?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [returnDraft, setReturnDraft] = useState<ReturnDraft>(emptyReturnDraft(initialSelectedId ?? ""));
  const [confirmationPurchase, setConfirmationPurchase] = useState<AdminPurchase | null>(null);
  const [isPending, startTransition] = useTransition();
  const cancellationKeysRef = useRef(new Map<string, string>());

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

  function removeLine(key: string) {
    setDraft((current) => ({ ...current, items: current.items.length > 1 ? current.items.filter((line) => line.key !== key) : current.items }));
  }

  function chooseProduct(line: LineDraft, product: PurchaseProductSearchResult | null) {
    updateLine(line.key, {
      product_id: product?.id ?? "",
      selectedProduct: product,
      description: product ? `${product.sku ? `${product.sku} - ` : ""}${product.name}` : line.description,
      unit_cost: product ? product.costPrice : line.unit_cost,
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
      items: purchase.items.length > 0 ? purchase.items.map((item) => ({
        ...item,
        key: item.id,
        product_id: item.product_id ?? "",
        selectedProduct: item.product_id ? {
          id: item.product_id,
          sku: item.product_sku ?? "Producto",
          internalCode: null,
          name: item.product_name ?? item.description,
          brand: "",
          unit: null,
          status: "active",
          isActive: true,
          availableStock: 0,
          costPrice: item.unit_cost,
        } : null,
      })) : [newLine()],
    });
  }

  function resetForm() {
    setEditingId(null);
    setDraft(emptyDraft());
  }

  function savePurchase() {
    if (!canManage) return;
    if (draft.items.some((line) => line.product_id && !Number.isInteger(Number(line.quantity)))) {
      toast.error("La cantidad de un producto de inventario debe ser un número entero.");
      return;
    }
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
    if (purchaseApAutomationEnabled) {
      setConfirmationPurchase(purchase);
      return;
    }
    startTransition(async () => {
      const result = await confirmPurchaseAction(purchase.id).catch(() => ({ ok: false as const, message: "No se pudo confirmar la compra." }));
      if (result.ok) { toast.success(result.message); router.refresh(); } else { toast.error(result.message); }
    });
  }

  function confirmPurchaseWithPayable(input: PurchaseConfirmationInput) {
    startTransition(async () => {
      const result = await confirmPurchaseAction(input).catch(() => ({ ok: false as const, message: "No se pudo confirmar la compra." }));
      if (result.ok) {
        toast.success(result.message);
        setConfirmationPurchase(null);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  function cancelPurchase(purchase: AdminPurchase) {
    const requestKey = cancellationKeysRef.current.get(purchase.id) ?? globalThis.crypto.randomUUID();
    cancellationKeysRef.current.set(purchase.id, requestKey);
    startTransition(async () => {
      const result = await cancelPurchaseAction(purchase.id, requestKey).catch(() => ({ ok: false as const, message: "No se pudo cancelar la compra." }));
      if (result.ok) { cancellationKeysRef.current.delete(purchase.id); toast.success(result.message); router.refresh(); } else { toast.error(result.message); }
    });
  }


  function saveReturn() {
    startTransition(async () => {
      const result = await registerPurchaseReturnAction(returnDraft).catch(() => ({ ok: false as const, message: "No se pudo registrar la devolución." }));
      if (result.ok) {
        toast.success(result.message);
        setReturnDraft(emptyReturnDraft(returnDraft.purchase_id));
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }
  return (
    <div className="min-w-0 space-y-5">
      {confirmationPurchase ? <PurchaseConfirmationDialog purchase={confirmationPurchase} pending={isPending} onCancel={() => !isPending && setConfirmationPurchase(null)} onConfirm={confirmPurchaseWithPayable} /> : null}
      {purchaseApAutomationEnabled ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"><strong>Automatización Compra → CxP activa.</strong> Toda compra nueva debe confirmar su condición de pago.</div> : null}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Borradores" value={summary.totalDraft.toLocaleString("es-HN")} />
        <Metric label="Confirmadas" value={summary.totalConfirmed.toLocaleString("es-HN")} />
        <Metric label="Canceladas" value={summary.totalCancelled.toLocaleString("es-HN")} />
        <Metric label="Total operativo" value={formatCurrency(summary.totalAmount)} />
      </section>

      <section className="min-w-0 rounded-lg border border-black/10 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div><h2 className="text-lg font-semibold">Compras</h2><p className="text-sm text-black/55">Borradores, confirmación y detalle operativo.</p></div>
          <div className="flex flex-wrap gap-2">
            {(["active", "draft", "confirmed", "cancelled", "all"] as const).map((status) => (
              <button key={status} type="button" onClick={() => setStatusFilter(status)} className={`rounded-md border px-3 py-2 text-sm font-semibold ${statusFilter === status ? "border-[#e4252c] bg-[#fff1f2] text-[#b91c25]" : "border-black/10 bg-white"}`}>{status === "active" ? "Activas" : status === "all" ? "Todas" : statusLabels[status]}</button>
            ))}
          </div>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px_auto] lg:items-center">
          <label className="flex min-w-0 items-center gap-2 rounded-md border border-black/10 px-3 py-2 focus-within:border-[#e4252c] focus-within:ring-2 focus-within:ring-[#e4252c]/15"><Search size={18} className="shrink-0 text-black/45" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por proveedor, número o estado" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
          <select value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm"><option value="all">Todos los proveedores</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select>
          {query ? <Button type="button" variant="ghost" onClick={() => setQuery("")}><X size={16} />Limpiar</Button> : null}
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
          <div className="min-w-0 space-y-3">
            <div className="min-w-0 max-w-full overflow-x-auto rounded-md border border-black/10">
              <table className="w-full min-w-[900px] text-left text-sm [&_td]:break-words [&_td]:[overflow-wrap:anywhere]">
                <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55"><tr><th className="px-3 py-2">Compra</th><th className="px-3 py-2">Proveedor</th><th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2">Líneas</th><th className="px-3 py-2">Total</th><th className="px-3 py-2">Acciones</th></tr></thead>
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
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{editingId ? "Editar compra" : "Registrar compra"}</h3><p className="text-sm text-black/55">Al guardar, las líneas vinculadas actualizan inventario inmediatamente.</p></div>{editingId ? <Button type="button" variant="ghost" onClick={resetForm}>Cancelar</Button> : null}</div>
            <div className="mt-4 grid gap-3">
              <Field label="Proveedor"><select value={draft.supplier_id} onChange={(event) => setDraft({ ...draft, supplier_id: event.target.value })} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm" disabled={!canManage || isPending}><option value="">Seleccionar</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}{supplier.is_active ? "" : " (inactivo)"}</option>)}</select></Field>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Número de compra"><Input value={draft.purchase_number} onChange={(event) => setDraft({ ...draft, purchase_number: event.target.value })} disabled={!canManage || isPending} /></Field><Field label="Fecha de compra"><Input type="date" value={draft.purchase_date} onChange={(event) => setDraft({ ...draft, purchase_date: event.target.value })} disabled={!canManage || isPending} /></Field></div>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Envío"><Input type="number" min="0" step="0.01" value={draft.shipping_amount ?? 0} onChange={(event) => setDraft({ ...draft, shipping_amount: event.target.value })} disabled={!canManage || isPending} /></Field><Field label="Moneda"><Input value={draft.currency ?? "HNL"} onChange={(event) => setDraft({ ...draft, currency: event.target.value })} disabled={!canManage || isPending} /></Field></div>
              <Field label="Notas"><textarea value={draft.notes ?? ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} rows={2} className="rounded-md border border-black/10 px-3 py-2 text-sm" disabled={!canManage || isPending} /></Field>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3"><h4 className="font-semibold">Líneas</h4><Button type="button" variant="ghost" onClick={() => setDraft({ ...draft, items: [...draft.items, newLine()] })} disabled={!canManage || isPending}><PlusCircle size={16} />Agregar línea</Button></div>
                {draft.items.map((line, index) => (
                  <div key={line.key} className="rounded-md border border-black/10 bg-white p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold">Línea {index + 1}</p>
                      <button
                        type="button"
                        aria-label="Quitar línea"
                        title="Quitar línea"
                        onClick={() => removeLine(line.key)}
                        disabled={!canManage || isPending || draft.items.length <= 1}
                        className="grid size-9 place-items-center rounded-md border border-black/10 bg-white text-black/60 transition-colors hover:border-[#e4252c]/35 hover:bg-[#fff1f2] hover:text-[#b91c25] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <div className="grid gap-2">
                      <PurchaseProductCombobox value={line.product_id ?? ""} selectedOption={line.selectedProduct ?? null} onChange={(product) => chooseProduct(line, product)} disabled={!canManage || isPending} />
                      <Input value={line.description} onChange={(event) => updateLine(line.key, { description: event.target.value })} placeholder="Descripción" disabled={!canManage || isPending} />
                      <div className="grid gap-2 sm:grid-cols-2">
                        <LineNumberField label="Cantidad" min={line.product_id ? "1" : "0.01"} step={line.product_id ? "1" : "0.01"} value={line.quantity} onChange={(value) => updateLine(line.key, { quantity: value })} disabled={!canManage || isPending} />
                        <LineNumberField label="Costo unitario" min="0" value={line.unit_cost} onChange={(value) => updateLine(line.key, { unit_cost: value })} disabled={!canManage || isPending} />
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <LineNumberField label="Impuesto" min="0" value={line.tax_amount ?? 0} onChange={(value) => updateLine(line.key, { tax_amount: value })} disabled={!canManage || isPending} />
                        <LineNumberField label="Descuento" min="0" value={line.discount_amount ?? 0} onChange={(value) => updateLine(line.key, { discount_amount: value })} disabled={!canManage || isPending} />
                      </div>
                      <p className="text-sm font-semibold">Total línea: {formatCurrency(lineTotal(line))}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid gap-2 rounded-md border border-black/10 bg-white p-3 text-sm"><TotalRow label="Subtotal" value={draftTotals.subtotal} /><TotalRow label="Impuesto" value={draftTotals.tax} /><TotalRow label="Descuento" value={draftTotals.discount} /><TotalRow label="Envío" value={draftTotals.shipping} /><TotalRow label="Total" value={draftTotals.total} strong /></div>
              <Button type="button" onClick={savePurchase} disabled={!canManage || isPending}><PlusCircle size={16} />{isPending ? "Guardando..." : "Guardar"}</Button>
              <div className="mt-4 grid gap-3 border-t border-black/10 pt-4">
                <h4 className="font-semibold">Devolución a proveedor</h4>
                <Field label="Compra"><select value={returnDraft.purchase_id} onChange={(event) => setReturnDraft({ ...returnDraft, purchase_id: event.target.value })} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm" disabled={!canManage || isPending}><option value="">Seleccionar</option>{purchases.filter((purchase) => ["confirmed", "received", "returned"].includes(purchase.status)).map((purchase) => <option key={purchase.id} value={purchase.id}>{purchase.purchase_number} - {purchase.supplier_name}</option>)}</select></Field>
                <div className="grid gap-3 sm:grid-cols-2"><Field label="Número de devolución"><Input value={returnDraft.return_number} onChange={(event) => setReturnDraft({ ...returnDraft, return_number: event.target.value })} disabled={!canManage || isPending} /></Field><Field label="Fecha"><Input type="date" value={returnDraft.return_date} onChange={(event) => setReturnDraft({ ...returnDraft, return_date: event.target.value })} disabled={!canManage || isPending} /></Field></div>
                <Field label="Monto"><Input type="number" min="0.01" step="0.01" value={returnDraft.amount} onChange={(event) => setReturnDraft({ ...returnDraft, amount: event.target.value })} disabled={!canManage || isPending} /></Field>
                <Field label="Motivo"><textarea value={returnDraft.reason ?? ""} onChange={(event) => setReturnDraft({ ...returnDraft, reason: event.target.value })} rows={2} className="rounded-md border border-black/10 px-3 py-2 text-sm" disabled={!canManage || isPending} /></Field>
                <Button type="button" onClick={saveReturn} disabled={!canManage || isPending}><PlusCircle size={16} />Registrar devolución</Button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function PurchaseDetails({ purchase }: { purchase: AdminPurchase }) {
  return <section className="min-w-0 rounded-lg border border-black/10 bg-white p-4"><div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-end sm:justify-between"><div className="min-w-0"><p className="text-sm text-black/50">Detalle de compra</p><h3 className="break-words text-lg font-semibold [overflow-wrap:anywhere]">{purchase.purchase_number}</h3></div><p className="font-semibold">{formatCurrency(purchase.total)}</p></div><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><Mini label="Proveedor" value={purchase.supplier_name} /><Mini label="Fecha" value={formatDate(purchase.purchase_date)} /><Mini label="Estado" value={statusLabels[purchase.status]} /><Mini label="Moneda" value={purchase.currency} /></div>{purchase.payable ? <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Cuenta por pagar asociada</p><p className="mt-1 font-semibold text-emerald-950">{purchase.payable.status === "paid" ? "Pagada" : purchase.payable.status === "partial" ? "Pago parcial" : "Pendiente"}</p></div><Link href={`/admin/cuentas-por-pagar?purchaseId=${purchase.id}`} className="inline-flex min-h-11 items-center justify-center rounded-md border border-emerald-300 bg-white px-3 text-sm font-semibold text-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600">Ver cuenta por pagar</Link></div><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><Mini label="Original" value={formatCurrency(purchase.payable.total_amount)} /><Mini label="Pagado" value={formatCurrency(purchase.payable.paid_amount)} /><Mini label="Saldo" value={formatCurrency(purchase.payable.balance)} /><Mini label="Vencimiento" value={purchase.payable.due_date ? formatDate(purchase.payable.due_date) : "Sin vencimiento"} /></div></div> : null}<div className="mt-4 min-w-0 max-w-full overflow-x-auto rounded-md border border-black/10"><table className="w-full min-w-[700px] text-left text-sm [&_td]:break-words [&_td]:[overflow-wrap:anywhere]"><thead className="bg-[#e7e5e4] text-xs uppercase text-black/55"><tr><th className="px-3 py-2">Descripción</th><th className="px-3 py-2">Producto</th><th className="px-3 py-2">Cantidad</th><th className="px-3 py-2">Costo</th><th className="px-3 py-2">Impuesto</th><th className="px-3 py-2">Descuento</th><th className="px-3 py-2">Total</th></tr></thead><tbody className="divide-y divide-black/10">{purchase.items.map((item) => <tr key={item.id}><td className="px-3 py-2">{item.description}</td><td className="px-3 py-2">{item.product_sku ?? item.product_name ?? "Sin producto"}</td><td className="px-3 py-2">{item.quantity.toLocaleString("es-HN")}</td><td className="px-3 py-2">{formatCurrency(item.unit_cost)}</td><td className="px-3 py-2">{formatCurrency(item.tax_amount)}</td><td className="px-3 py-2">{formatCurrency(item.discount_amount)}</td><td className="px-3 py-2 font-semibold">{formatCurrency(item.total_cost)}</td></tr>)}{purchase.items.length === 0 ? <tr><td colSpan={7} className="px-3 py-5 text-center text-black/55">Sin líneas registradas.</td></tr> : null}</tbody></table></div>{purchase.returns.length > 0 ? <div className="mt-4 min-w-0 max-w-full overflow-x-auto rounded-md border border-black/10"><table className="w-full min-w-[620px] text-left text-sm [&_td]:break-words [&_td]:[overflow-wrap:anywhere]"><thead className="bg-[#e7e5e4] text-xs uppercase text-black/55"><tr><th className="px-3 py-2">Devolución</th><th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Monto</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2">Motivo</th></tr></thead><tbody className="divide-y divide-black/10">{purchase.returns.map((item) => <tr key={item.id}><td className="px-3 py-2 font-semibold">{item.return_number}</td><td className="px-3 py-2">{formatDate(item.return_date)}</td><td className="px-3 py-2 font-semibold">{formatCurrency(item.total)}</td><td className="px-3 py-2">{item.status}</td><td className="px-3 py-2">{item.reason ?? "-"}</td></tr>)}</tbody></table></div> : null}</section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-lg border border-black/10 bg-white p-4"><p className="text-sm text-black/50">{label}</p><p className="mt-1 break-words text-2xl font-semibold [overflow-wrap:anywhere]">{value}</p></div>; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="grid min-w-0 gap-1 text-sm font-semibold [overflow-wrap:anywhere]">{label}{children}</label>; }
function Mini({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-md bg-[#f4f4f5] p-3"><p className="text-xs uppercase text-black/45">{label}</p><p className="mt-1 break-words font-semibold [overflow-wrap:anywhere]">{value}</p></div>; }
function TotalRow({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) { return <div className="flex items-center justify-between gap-3"><span className="text-black/55">{label}</span><span className={strong ? "font-semibold" : ""}>{formatCurrency(value)}</span></div>; }
