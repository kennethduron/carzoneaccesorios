"use client";

import { useId, type RefObject } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  CircleDollarSign,
  Edit3,
  Eye,
  FileText,
  PackageOpen,
  PlusCircle,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { PurchaseFormInput, PurchaseReturnFormInput } from "@/app/admin/compras/actions";
import { PurchaseProductCombobox } from "@/components/admin/purchase-product-combobox";
import { Button, Input } from "@/components/ui";
import type { PurchaseProductSearchResult } from "@/types/admin-search";
import type { AdminPurchase, SupplierOption } from "@/types/purchases";
import { formatCurrency } from "@/utils/pricing";
import type { PurchaseSelectionNotice, PurchaseStatusFilter } from "@/components/admin/purchases-responsive-state";
import { isPurchaseReturnEligible } from "@/components/admin/purchases-responsive-state";
import styles from "@/components/admin/admin-purchases-responsive.module.css";

export type PurchaseLineDraft = PurchaseFormInput["items"][number] & {
  key: string;
  selectedProduct?: PurchaseProductSearchResult | null;
};

export type PurchaseDraft = Omit<PurchaseFormInput, "items"> & { items: PurchaseLineDraft[] };
export type PurchaseReturnDraft = PurchaseReturnFormInput;

export const purchaseStatusLabels: Record<string, string> = {
  draft: "Borrador",
  confirmed: "Confirmada",
  received: "Recibida",
  cancelled: "Cancelada",
  returned: "Devuelta",
};

const statusFilterLabels: Record<PurchaseStatusFilter, string> = {
  active: "Activas",
  draft: "Borrador",
  confirmed: "Confirmada",
  cancelled: "Cancelada",
  all: "Todas",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-HN", { dateStyle: "medium" }).format(
    new Date(`${value.slice(0, 10)}T00:00:00-06:00`),
  );
}

function statusClasses(status: string) {
  if (status === "confirmed" || status === "received") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "cancelled" || status === "returned") return "border-red-200 bg-red-50 text-red-800";
  return "border-black/10 bg-[#f4f4f5] text-black/70";
}

function PurchaseStatus({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClasses(status)}`}>
      {purchaseStatusLabels[status] ?? status}
    </span>
  );
}

type PurchasesBrowserProps = {
  variant: "desktop" | "cards";
  idPrefix: string;
  purchases: AdminPurchase[];
  totalPurchases: number;
  suppliers: SupplierOption[];
  query: string;
  supplierFilter: string;
  statusFilter: PurchaseStatusFilter;
  selectedId: string | null;
  selectionNotice: PurchaseSelectionNotice;
  canManage: boolean;
  listRef?: RefObject<HTMLDivElement | null>;
  onQueryChange: (value: string) => void;
  onSupplierFilterChange: (value: string) => void;
  onStatusFilterChange: (value: PurchaseStatusFilter) => void;
  onSelect: (purchase: AdminPurchase, trigger: HTMLButtonElement) => void;
  onCreate: () => void;
};

export function PurchasesBrowser({
  variant,
  idPrefix,
  purchases,
  totalPurchases,
  suppliers,
  query,
  supplierFilter,
  statusFilter,
  selectedId,
  selectionNotice,
  canManage,
  listRef,
  onQueryChange,
  onSupplierFilterChange,
  onStatusFilterChange,
  onSelect,
  onCreate,
}: PurchasesBrowserProps) {
  const noLoadedPurchases = totalPurchases === 0;

  return (
    <section className="min-w-0 rounded-xl border border-black/10 bg-white p-4 shadow-sm sm:p-5" aria-labelledby={`${idPrefix}-title`}>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id={`${idPrefix}-title`} className="text-xl font-semibold">Compras</h2>
          <p className="mt-1 text-sm text-black/55">Consulta, gestión y detalle operativo de compras.</p>
        </div>
        <Button
          type="button"
          onClick={onCreate}
          disabled={!canManage}
          title={canManage ? "Registrar una nueva compra" : "No tienes permiso para registrar compras"}
          className="min-h-11 w-full sm:w-auto"
        >
          <PlusCircle size={17} /> Nueva compra
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" aria-label="Filtrar compras por estado">
        {(Object.keys(statusFilterLabels) as PurchaseStatusFilter[]).map((status) => (
          <button
            key={status}
            type="button"
            aria-pressed={statusFilter === status}
            onClick={() => onStatusFilterChange(status)}
            className={`min-h-11 rounded-md border px-3 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] ${
              statusFilter === status
                ? "border-[#e4252c] bg-[#fff1f2] text-[#b91c25]"
                : "border-black/10 bg-white text-black/70"
            }`}
          >
            {statusFilterLabels[status]}
          </button>
        ))}
      </div>

      <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,280px)]">
        <label htmlFor={`${idPrefix}-search`} className="grid min-w-0 gap-1 text-sm font-semibold">
          Buscar compra
          <span className="flex min-h-11 min-w-0 items-center gap-2 rounded-md border border-black/10 px-3 focus-within:border-[#e4252c] focus-within:ring-2 focus-within:ring-[#e4252c]/15">
            <Search aria-hidden size={18} className="shrink-0 text-black/45" />
            <input
              id={`${idPrefix}-search`}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Buscar por proveedor, número o estado"
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
            {query ? (
              <button type="button" aria-label="Limpiar búsqueda" onClick={() => onQueryChange("")} className="grid size-11 shrink-0 place-items-center rounded-md hover:bg-black/5">
                <X aria-hidden size={16} />
              </button>
            ) : null}
          </span>
        </label>
        <label htmlFor={`${idPrefix}-supplier`} className="grid min-w-0 gap-1 text-sm font-semibold">
          Proveedor
          <select
            id={`${idPrefix}-supplier`}
            value={supplierFilter}
            onChange={(event) => onSupplierFilterChange(event.target.value)}
            className="min-h-11 w-full min-w-0 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
          >
            <option value="all">Todos los proveedores</option>
            {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
          </select>
        </label>
      </div>

      {selectionNotice === "hidden" ? (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          La compra seleccionada quedó fuera del filtro. Selecciona otra compra visible.
        </p>
      ) : null}

      <div className="mt-4 overflow-hidden rounded-lg border border-black/10">
        <div className="border-b border-black/10 bg-[#fafafa] px-3 py-3">
          <h3 className="font-semibold">Lista de compras</h3>
          <p className="text-xs text-black/50">{purchases.length.toLocaleString("es-HN")} de {totalPurchases.toLocaleString("es-HN")} compras</p>
        </div>

        {variant === "desktop" ? (
          <div ref={listRef} className={styles.desktopListScroller} aria-label="Lista desplazable de compras" tabIndex={0}>
            <table className="w-full table-fixed text-left text-sm">
              <thead className="bg-[#e7e5e4] text-[11px] uppercase text-black/55">
                <tr>
                  <th className="w-[19%] px-3 py-2">Compra</th>
                  <th className="w-[25%] px-3 py-2">Proveedor</th>
                  <th className="w-[15%] px-3 py-2">Fecha</th>
                  <th className="w-[14%] px-3 py-2">Estado</th>
                  <th className="w-[14%] px-3 py-2 text-right">Total</th>
                  <th className="w-[13%] px-3 py-2 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {purchases.map((purchase) => {
                  const selected = purchase.id === selectedId;
                  return (
                    <tr key={purchase.id} aria-selected={selected} className={selected ? "bg-[#fff1f2] shadow-[inset_3px_0_0_#e4252c]" : "bg-white"}>
                      <td className="px-3 py-3 align-top font-semibold text-[#b91c25] [overflow-wrap:anywhere]">{purchase.purchase_number}</td>
                      <td className="px-3 py-3 align-top [overflow-wrap:anywhere]">{purchase.supplier_name}</td>
                      <td className="px-3 py-3 align-top">{formatDate(purchase.purchase_date)}</td>
                      <td className="px-3 py-3 align-top"><PurchaseStatus status={purchase.status} /></td>
                      <td className="px-3 py-3 text-right align-top font-semibold tabular-nums">{formatCurrency(purchase.total)}</td>
                      <td className="px-3 py-2 text-right align-top">
                        <button
                          type="button"
                          aria-current={selected ? "true" : undefined}
                          onClick={(event) => onSelect(purchase, event.currentTarget)}
                          className="inline-flex min-h-11 items-center justify-center gap-1 rounded-md border border-black/10 bg-white px-2 text-xs font-semibold text-[#b91c25] hover:border-[#e4252c]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c]"
                        >
                          <Eye aria-hidden size={15} /> Ver detalle
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div ref={listRef} className="grid gap-3 bg-[#f8fafc] p-3">
            {purchases.map((purchase) => {
              const selected = purchase.id === selectedId;
              return (
                <article key={purchase.id} aria-current={selected ? "true" : undefined} className={`min-w-0 rounded-lg border bg-white p-4 shadow-sm ${selected ? "border-[#e4252c] shadow-[inset_3px_0_0_#e4252c]" : "border-black/10"}`}>
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words font-semibold [overflow-wrap:anywhere]">{purchase.purchase_number}</p>
                      <p className="mt-1 break-words text-sm text-black/70">{purchase.supplier_name}</p>
                    </div>
                    <p className="shrink-0 font-semibold tabular-nums">{formatCurrency(purchase.total)}</p>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-black/60">
                    <span>{formatDate(purchase.purchase_date)}</span>
                    <span aria-hidden>•</span>
                    <PurchaseStatus status={purchase.status} />
                    <span aria-hidden>•</span>
                    <span>{purchase.items.length.toLocaleString("es-HN")} {purchase.items.length === 1 ? "línea" : "líneas"}</span>
                  </div>
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={(event) => onSelect(purchase, event.currentTarget)}
                    className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-[#e4252c] bg-white px-3 text-sm font-semibold text-[#b91c25] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c]"
                  >
                    <Eye aria-hidden size={16} /> Ver detalle
                  </button>
                </article>
              );
            })}
          </div>
        )}

        {purchases.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <PackageOpen aria-hidden className="mx-auto text-black/35" size={30} />
            <p className="mt-3 font-semibold">{noLoadedPurchases ? "No hay compras registradas." : "No hay compras para estos filtros."}</p>
            <p className="mt-1 text-sm text-black/50">{noLoadedPurchases ? "Registra una compra cuando el flujo operativo lo requiera." : "Ajusta la búsqueda o los filtros para ver resultados."}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

type PurchaseDetailProps = {
  purchase: AdminPurchase | null;
  notice: PurchaseSelectionNotice;
  canManage: boolean;
  pending: boolean;
  compact?: boolean;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  onBack?: () => void;
  onEdit: (purchase: AdminPurchase) => void;
  onConfirm: (purchase: AdminPurchase) => void;
  onCancel: (purchase: AdminPurchase) => void;
  onReturn: (purchase: AdminPurchase) => void;
};

export function PurchaseDetail({ purchase, notice, canManage, pending, compact = false, headingRef, onBack, onEdit, onConfirm, onCancel, onReturn }: PurchaseDetailProps) {
  const detailId = useId();
  if (!purchase) {
    const message = notice === "invalid"
      ? "La compra solicitada no está disponible."
      : notice === "hidden"
        ? "La compra seleccionada quedó fuera del filtro actual."
        : "Selecciona una compra para ver su detalle.";
    return (
      <section className="grid min-h-72 place-items-center rounded-xl border border-dashed border-black/15 bg-white p-8 text-center">
        <div>
          <FileText aria-hidden className="mx-auto text-black/35" size={34} />
          <h2 className="mt-3 text-lg font-semibold">Detalle de compra</h2>
          <p className="mt-1 text-sm text-black/55">{message}</p>
          {compact && onBack ? <Button type="button" variant="ghost" onClick={onBack} className="mt-5 min-h-11"><ArrowLeft size={17} /> Volver a compras</Button> : null}
        </div>
      </section>
    );
  }

  const editable = canManage && purchase.status === "draft";
  const confirmable = canManage && purchase.status === "draft";
  const cancellable = canManage && ["draft", "confirmed"].includes(purchase.status);
  const returnable = canManage && isPurchaseReturnEligible(purchase);

  return (
    <section className={`${styles.detailContainer} min-w-0 rounded-xl border border-black/10 bg-white p-4 shadow-sm sm:p-5`} aria-labelledby={`${detailId}-title`}>
      {compact && onBack ? (
        <Button type="button" variant="ghost" onClick={onBack} className="mb-4 min-h-11 w-full sm:w-auto">
          <ArrowLeft size={17} /> Volver a compras
        </Button>
      ) : null}

      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#e4252c]">Detalle de compra</p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
            <h2 ref={headingRef} id={`${detailId}-title`} tabIndex={compact ? -1 : undefined} className="break-words text-2xl font-semibold outline-none [overflow-wrap:anywhere]">
              {purchase.purchase_number}
            </h2>
            <PurchaseStatus status={purchase.status} />
          </div>
          <p className="mt-1 break-words text-sm font-semibold text-black/55">{purchase.supplier_name}</p>
        </div>
        <div className="shrink-0 sm:text-right">
          <p className="text-xs font-semibold uppercase text-black/45">Total</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatCurrency(purchase.total)}</p>
        </div>
      </div>

      <dl className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Mini label="Proveedor" value={purchase.supplier_name} />
        <Mini label="Fecha" value={formatDate(purchase.purchase_date)} />
        <Mini label="Estado" value={purchaseStatusLabels[purchase.status] ?? purchase.status} />
        <Mini label="Moneda" value={purchase.currency} />
      </dl>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {confirmable ? (
          <Button type="button" onClick={() => onConfirm(purchase)} disabled={pending} className="min-h-11"><CheckCircle2 size={17} /> Confirmar compra</Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={() => onEdit(purchase)} disabled={!editable || pending} title={editable ? "Editar esta compra" : "Solo se pueden editar compras en borrador con permiso de gestión"} className="min-h-11">
          <Edit3 size={17} /> Editar
        </Button>
        {purchase.payable ? (
          <Link href={`/admin/cuentas-por-pagar?purchaseId=${purchase.id}`} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c]">
            <CircleDollarSign size={17} /> Ver cuenta por pagar
          </Link>
        ) : null}
        <Button type="button" variant="ghost" onClick={() => onReturn(purchase)} disabled={!returnable || pending} title={returnable ? "Registrar una devolución para esta compra" : "Disponible para compras confirmadas, recibidas o devueltas con permiso de gestión"} className="min-h-11">
          <RotateCcw size={17} /> Registrar devolución
        </Button>
        <button type="button" onClick={() => onCancel(purchase)} disabled={!cancellable || pending} title={cancellable ? "Cancelar esta compra" : "Solo se pueden cancelar compras en borrador o confirmadas con permiso de gestión"} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-red-300 bg-white px-3 text-sm font-semibold text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:cursor-not-allowed disabled:opacity-50">
          <Ban size={17} /> Cancelar compra
        </button>
      </div>
      {!canManage ? <p className="mt-2 text-xs text-black/50">Vista de solo lectura: no tienes permiso para modificar compras.</p> : null}

      {purchase.payable ? (
        <section className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4" aria-label="Cuenta por pagar asociada">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Cuenta por pagar asociada</p>
              <p className="mt-1 font-semibold text-emerald-950">Estado: {purchase.payable.status === "paid" ? "Pagada" : purchase.payable.status === "partial" ? "Pago parcial" : "Pendiente"}</p>
            </div>
            <Link href={`/admin/cuentas-por-pagar?purchaseId=${purchase.id}`} className="inline-flex min-h-11 items-center justify-center rounded-md border border-emerald-300 bg-white px-3 text-sm font-semibold text-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600">
              Ver cuenta por pagar
            </Link>
          </div>
          <dl className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Mini label="Original" value={formatCurrency(purchase.payable.total_amount)} />
            <Mini label="Pagado" value={formatCurrency(purchase.payable.paid_amount)} />
            <Mini label="Saldo" value={formatCurrency(purchase.payable.balance)} />
            <Mini label="Vencimiento" value={purchase.payable.due_date ? formatDate(purchase.payable.due_date) : "Sin vencimiento"} />
          </dl>
        </section>
      ) : null}

      <section className="mt-5" aria-labelledby={`${detailId}-lines`}>
        <h3 id={`${detailId}-lines`} className="font-semibold text-black/65">Productos / líneas de compra</h3>
        <div className={`${styles.lineTable} mt-3 overflow-hidden rounded-lg border border-black/10`}>
          <table className="w-full table-fixed text-left text-xs">
            <thead className="bg-[#e7e5e4] uppercase text-black/55">
              <tr><th className="w-[27%] px-2 py-2">Descripción</th><th className="w-[13%] px-2 py-2">Producto</th><th className="w-[10%] px-2 py-2">Cant.</th><th className="w-[12%] px-2 py-2">Costo</th><th className="w-[12%] px-2 py-2">Impuesto</th><th className="w-[12%] px-2 py-2">Desc.</th><th className="w-[14%] px-2 py-2">Total</th></tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {purchase.items.map((item) => (
                <tr key={item.id}>
                  <td className="break-words px-2 py-2 [overflow-wrap:anywhere]">{item.description}</td>
                  <td className="break-words px-2 py-2 [overflow-wrap:anywhere]">{item.product_sku ?? item.product_name ?? "Sin producto"}</td>
                  <td className="px-2 py-2">{item.quantity.toLocaleString("es-HN")}</td>
                  <td className="px-2 py-2 tabular-nums">{formatCurrency(item.unit_cost)}</td>
                  <td className="px-2 py-2 tabular-nums">{formatCurrency(item.tax_amount)}</td>
                  <td className="px-2 py-2 tabular-nums">{formatCurrency(item.discount_amount)}</td>
                  <td className="px-2 py-2 font-semibold tabular-nums">{formatCurrency(item.total_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={`${styles.lineCards} mt-3 gap-3`}>
          {purchase.items.map((item) => (
            <article key={item.id} className="min-w-0 rounded-lg border border-black/10 bg-white p-3">
              <p className="break-words font-semibold [overflow-wrap:anywhere]">{item.description}</p>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm sm:grid-cols-3">
                <CompactFact label="Producto" value={item.product_sku ?? item.product_name ?? "Sin producto"} />
                <CompactFact label="Cantidad" value={item.quantity.toLocaleString("es-HN")} />
                <CompactFact label="Costo" value={formatCurrency(item.unit_cost)} />
                <CompactFact label="Impuesto" value={formatCurrency(item.tax_amount)} />
                <CompactFact label="Descuento" value={formatCurrency(item.discount_amount)} />
                <CompactFact label="Total" value={formatCurrency(item.total_cost)} strong />
              </dl>
            </article>
          ))}
        </div>
        {purchase.items.length === 0 ? <p className="mt-3 rounded-lg border border-dashed border-black/15 p-5 text-center text-sm text-black/55">Sin líneas registradas.</p> : null}
      </section>

      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        <section className="rounded-lg border border-black/10 p-4">
          <h3 className="font-semibold">Información adicional</h3>
          <dl className="mt-3 grid gap-2 text-sm">
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2"><dt className="font-semibold">Moneda</dt><dd className="break-words text-black/60">{purchase.currency}</dd></div>
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2"><dt className="font-semibold">Notas</dt><dd className="break-words text-black/60">{purchase.notes || "Sin notas"}</dd></div>
          </dl>
        </section>
        <section className="rounded-lg border border-black/10 p-4" aria-labelledby={`${detailId}-returns`}>
          <div className="flex items-start gap-3">
            <PackageOpen aria-hidden className="shrink-0 text-black/45" size={28} />
            <div className="min-w-0 flex-1">
              <h3 id={`${detailId}-returns`} className="font-semibold">Devoluciones al proveedor</h3>
              {purchase.returns.length === 0 ? <p className="mt-1 text-sm text-black/55">No hay devoluciones registradas para esta compra.</p> : (
                <div className="mt-3 grid gap-2">
                  {purchase.returns.map((item) => (
                    <article key={item.id} className="rounded-md bg-[#f4f4f5] p-3 text-sm">
                      <div className="flex flex-wrap justify-between gap-2"><p className="font-semibold">{item.return_number}</p><p className="font-semibold tabular-nums">{formatCurrency(item.total)}</p></div>
                      <p className="mt-1 text-xs text-black/55">{formatDate(item.return_date)} · {item.status}</p>
                      {item.reason ? <p className="mt-2 break-words">{item.reason}</p> : null}
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}

type PurchaseCreateEditWorkspaceProps = {
  mode: "create" | "edit";
  draft: PurchaseDraft;
  suppliers: SupplierOption[];
  pending: boolean;
  dirty: boolean;
  totals: { subtotal: number; tax: number; discount: number; shipping: number; total: number };
  headingRef: RefObject<HTMLHeadingElement | null>;
  onDraftChange: (draft: PurchaseDraft) => void;
  onUpdateLine: (key: string, patch: Partial<PurchaseLineDraft>) => void;
  onChooseProduct: (line: PurchaseLineDraft, product: PurchaseProductSearchResult | null) => void;
  onAddLine: () => void;
  onRemoveLine: (key: string) => void;
  onBack: () => void;
  onSave: () => void;
};

export function PurchaseCreateEditWorkspace({ mode, draft, suppliers, pending, dirty, totals, headingRef, onDraftChange, onUpdateLine, onChooseProduct, onAddLine, onRemoveLine, onBack, onSave }: PurchaseCreateEditWorkspaceProps) {
  return (
    <section className="min-w-0 rounded-xl border border-black/10 bg-white p-4 shadow-sm sm:p-6" aria-labelledby="purchase-workspace-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#e4252c]">{mode === "edit" ? "Edición de compra" : "Nueva compra"}</p>
          <h2 ref={headingRef} id="purchase-workspace-title" tabIndex={-1} className="mt-1 text-2xl font-semibold outline-none">{mode === "edit" ? "Editar compra" : "Registrar compra"}</h2>
          <p className="mt-1 text-sm text-black/55">Al guardar, las líneas vinculadas actualizan inventario inmediatamente.</p>
          {dirty ? <p className="mt-2 text-xs font-semibold text-amber-800" role="status">Hay cambios sin guardar.</p> : null}
        </div>
        <Button type="button" variant="ghost" onClick={onBack} disabled={pending} className="min-h-11 w-full sm:w-auto"><ArrowLeft size={17} /> Volver</Button>
      </div>

      <form className="mt-5 grid gap-5" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
        <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Proveedor"><select value={draft.supplier_id} onChange={(event) => onDraftChange({ ...draft, supplier_id: event.target.value })} className="min-h-11 w-full min-w-0 rounded-md border border-black/10 bg-white px-3 py-2 text-sm" disabled={pending}><option value="">Seleccionar</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}{supplier.is_active ? "" : " (inactivo)"}</option>)}</select></Field>
          <Field label="Número de compra"><Input value={draft.purchase_number} onChange={(event) => onDraftChange({ ...draft, purchase_number: event.target.value })} disabled={pending} /></Field>
          <Field label="Fecha de compra"><Input type="date" value={draft.purchase_date} onChange={(event) => onDraftChange({ ...draft, purchase_date: event.target.value })} disabled={pending} /></Field>
          <Field label="Envío"><Input type="number" min="0" step="0.01" value={draft.shipping_amount ?? ""} onChange={(event) => onDraftChange({ ...draft, shipping_amount: event.target.value })} disabled={pending} /></Field>
          <Field label="Moneda"><Input value={draft.currency ?? ""} onChange={(event) => onDraftChange({ ...draft, currency: event.target.value })} disabled={pending} /></Field>
          <label className="grid min-w-0 gap-1 text-sm font-semibold md:col-span-2 xl:col-span-3">Notas<textarea value={draft.notes ?? ""} onChange={(event) => onDraftChange({ ...draft, notes: event.target.value })} rows={2} className="min-h-20 w-full min-w-0 rounded-md border border-black/10 px-3 py-2 text-sm" disabled={pending} /></label>
        </div>

        <section className="min-w-0 rounded-lg border border-black/10 bg-[#fafafa] p-3 sm:p-4" aria-labelledby="purchase-workspace-lines">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="purchase-workspace-lines" className="font-semibold">Líneas</h3>
            <Button type="button" variant="ghost" onClick={onAddLine} disabled={pending} className="min-h-11"><PlusCircle size={16} /> Agregar línea</Button>
          </div>
          <div className="mt-4 grid gap-4">
            {draft.items.map((line, index) => (
              <article key={line.key} className="min-w-0 rounded-lg border border-black/10 bg-white p-3 sm:p-4">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="font-semibold">Línea {index + 1}</h4>
                  <button type="button" onClick={() => onRemoveLine(line.key)} disabled={pending || draft.items.length === 1} aria-label={`Eliminar línea ${index + 1}`} className="grid size-11 shrink-0 place-items-center rounded-md border border-black/10 text-red-700 disabled:opacity-40"><Trash2 aria-hidden size={17} /></button>
                </div>
                <div className="mt-3 grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="min-w-0 md:col-span-2"><PurchaseProductCombobox value={line.product_id ?? ""} selectedOption={line.selectedProduct ?? null} onChange={(product) => onChooseProduct(line, product)} disabled={pending} /></div>
                  <Field label="Descripción"><Input value={line.description} onChange={(event) => onUpdateLine(line.key, { description: event.target.value })} disabled={pending} /></Field>
                  <LineNumberField label="Cantidad" min="0.01" step={line.product_id ? "1" : "0.01"} value={line.quantity} onChange={(value) => onUpdateLine(line.key, { quantity: value })} disabled={pending} />
                  <LineNumberField label="Costo unitario" min="0" value={line.unit_cost} onChange={(value) => onUpdateLine(line.key, { unit_cost: value })} disabled={pending} />
                  <LineNumberField label="Impuesto" min="0" value={line.tax_amount} onChange={(value) => onUpdateLine(line.key, { tax_amount: value })} disabled={pending} />
                  <LineNumberField label="Descuento" min="0" value={line.discount_amount} onChange={(value) => onUpdateLine(line.key, { discount_amount: value })} disabled={pending} />
                  <div className="rounded-md bg-[#f4f4f5] p-3"><p className="text-xs uppercase text-black/45">Total línea</p><p className="mt-1 font-semibold">{formatCurrency(Math.max(Number(line.quantity || 0) * Number(line.unit_cost || 0) + Number(line.tax_amount || 0) - Number(line.discount_amount || 0), 0))}</p></div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)] lg:items-end">
          <div className="rounded-lg border border-black/10 bg-[#fafafa] p-4 text-sm">
            <TotalRow label="Subtotal" value={totals.subtotal} />
            <TotalRow label="Impuesto" value={totals.tax} />
            <TotalRow label="Descuento" value={totals.discount} />
            <TotalRow label="Envío" value={totals.shipping} />
            <div className="my-3 border-t border-black/10" />
            <TotalRow label="Total" value={totals.total} strong />
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={onBack} disabled={pending} className="min-h-11">Cancelar</Button>
            <Button type="submit" disabled={pending} className="min-h-11">{pending ? "Guardando…" : "Guardar compra"}</Button>
          </div>
        </div>
      </form>
    </section>
  );
}

type SupplierReturnWorkspaceProps = {
  purchase: AdminPurchase;
  draft: PurchaseReturnDraft;
  pending: boolean;
  dirty: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onDraftChange: (draft: PurchaseReturnDraft) => void;
  onBack: () => void;
  onSave: () => void;
};

export function SupplierReturnWorkspace({ purchase, draft, pending, dirty, headingRef, onDraftChange, onBack, onSave }: SupplierReturnWorkspaceProps) {
  return (
    <section className="min-w-0 rounded-xl border border-black/10 bg-white p-4 shadow-sm sm:p-6" aria-labelledby="supplier-return-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#e4252c]">Flujo contextual</p>
          <h2 ref={headingRef} id="supplier-return-title" tabIndex={-1} className="mt-1 text-2xl font-semibold outline-none">Devolución a proveedor</h2>
          <p className="mt-1 text-sm text-black/55">La compra queda fijada para evitar devolver sobre un registro incorrecto.</p>
          {dirty ? <p className="mt-2 text-xs font-semibold text-amber-800" role="status">Hay cambios sin guardar.</p> : null}
        </div>
        <Button type="button" variant="ghost" onClick={onBack} disabled={pending} className="min-h-11"><ArrowLeft size={17} /> Volver al detalle</Button>
      </div>

      <dl className="mt-5 grid gap-3 rounded-lg bg-[#f8fafc] p-4 sm:grid-cols-3">
        <Mini label="Compra" value={purchase.purchase_number} />
        <Mini label="Proveedor" value={purchase.supplier_name} />
        <Mini label="Estado" value={purchaseStatusLabels[purchase.status] ?? purchase.status} />
      </dl>

      <form className="mt-5 grid gap-4" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Número de devolución"><Input value={draft.return_number} onChange={(event) => onDraftChange({ ...draft, return_number: event.target.value })} disabled={pending} /></Field>
          <Field label="Fecha"><Input type="date" value={draft.return_date} onChange={(event) => onDraftChange({ ...draft, return_date: event.target.value })} disabled={pending} /></Field>
          <Field label="Monto"><Input type="number" min="0.01" step="0.01" value={draft.amount} onChange={(event) => onDraftChange({ ...draft, amount: event.target.value })} disabled={pending} /></Field>
          <label className="grid min-w-0 gap-1 text-sm font-semibold">Motivo<textarea value={draft.reason ?? ""} onChange={(event) => onDraftChange({ ...draft, reason: event.target.value })} rows={3} className="min-h-24 w-full min-w-0 rounded-md border border-black/10 px-3 py-2 text-sm" disabled={pending} /></label>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onBack} disabled={pending} className="min-h-11">No registrar</Button>
          <Button type="submit" disabled={pending} className="min-h-11"><RotateCcw size={17} /> {pending ? "Registrando…" : "Registrar devolución"}</Button>
        </div>
      </form>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid min-w-0 gap-1 text-sm font-semibold [overflow-wrap:anywhere]">{label}{children}</label>;
}

function LineNumberField({ label, min, step = "0.01", value, onChange, disabled }: { label: string; min: string; step?: string; value: number | string | null | undefined; onChange: (value: string) => void; disabled: boolean }) {
  return <Field label={label}><Input type="number" min={min} step={step} value={value ?? 0} onChange={(event) => onChange(event.target.value)} disabled={disabled} /></Field>;
}

function Mini({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-md border border-black/5 bg-[#f4f4f5] p-3"><dt className="text-xs uppercase text-black/45">{label}</dt><dd className="mt-1 break-words font-semibold [overflow-wrap:anywhere]">{value}</dd></div>;
}

function CompactFact({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className="min-w-0 border-t border-black/10 pt-2"><dt className="text-xs text-black/50">{label}</dt><dd className={`mt-0.5 break-words tabular-nums [overflow-wrap:anywhere] ${strong ? "font-bold" : "font-semibold"}`}>{value}</dd></div>;
}

function TotalRow({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return <div className="flex items-center justify-between gap-3 py-1"><span className="text-black/55">{label}</span><span className={strong ? "text-lg font-semibold" : "font-semibold"}>{formatCurrency(value)}</span></div>;
}
