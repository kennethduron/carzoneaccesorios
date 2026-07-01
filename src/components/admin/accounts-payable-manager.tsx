"use client";

import type { ReactNode } from "react";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, CheckCircle2, Edit3, PlusCircle, ReceiptText, Search, X } from "lucide-react";
import {
  cancelAccountsPayableAction,
  cancelSupplierInvoiceAction,
  receiveSupplierInvoiceAction,
  registerSupplierPaymentAction,
  saveAccountsPayableAction,
  saveSupplierInvoiceAction,
  voidSupplierPaymentAction,
  type AccountsPayableFormInput,
  type SupplierInvoiceFormInput,
  type SupplierPaymentFormInput,
} from "@/app/admin/cuentas-por-pagar/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { AdminAccountsPayable, AdminSupplierInvoice, PayablesSummary, SupplierOption } from "@/types/purchases";
import { formatCurrency } from "@/utils/pricing";

const payableLabels: Record<string, string> = { pending: "Pendiente", partial: "Parcial", paid: "Pagado", cancelled: "Anulado", overdue: "Vencido" };
const invoiceLabels: Record<string, string> = { draft: "Borrador", received: "Recibida", posted_to_ap: "En cuentas por pagar", cancelled: "Anulada", paid: "Pagada" };
const paymentLabels: Record<string, string> = { draft: "Borrador", paid: "Pagado", voided: "Anulado" };

type PurchaseOption = { id: string; supplier_id: string; purchase_number: string; status: string; total: number };

type InvoiceDraft = SupplierInvoiceFormInput;
type PayableDraft = AccountsPayableFormInput;
type PaymentDraft = SupplierPaymentFormInput;

function todayValue() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(new Date());
}

function emptyInvoiceDraft(): InvoiceDraft {
  return { supplier_id: "", purchase_id: "", invoice_number: "", invoice_date: todayValue(), due_date: "", subtotal: 0, tax_amount: 0, discount_amount: 0, currency: "HNL", notes: "" };
}

function emptyPayableDraft(): PayableDraft {
  return { supplier_id: "", purchase_id: "", supplier_invoice_id: "", total_amount: 0, due_date: "", currency: "HNL", notes: "" };
}

function emptyPaymentDraft(): PaymentDraft {
  return { accounts_payable_id: "", amount: "", payment_method: "", paid_at: todayValue(), notes: "" };
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function formatDate(value: string | null) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-HN", { dateStyle: "medium" }).format(new Date(`${value.slice(0, 10)}T00:00:00-06:00`));
}

function invoiceTotal(draft: InvoiceDraft) {
  return Math.max(Number(draft.subtotal || 0) + Number(draft.tax_amount || 0) - Number(draft.discount_amount || 0), 0);
}

export function AccountsPayableManager({
  payables,
  invoices,
  suppliers,
  purchases,
  summary,
  canManage,
}: {
  payables: AdminAccountsPayable[];
  invoices: AdminSupplierInvoice[];
  suppliers: SupplierOption[];
  purchases: PurchaseOption[];
  summary: PayablesSummary;
  canManage: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");
  const [tab, setTab] = useState<"payables" | "invoices">("payables");
  const [invoiceDraft, setInvoiceDraft] = useState<InvoiceDraft>(emptyInvoiceDraft());
  const [payableDraft, setPayableDraft] = useState<PayableDraft>(emptyPayableDraft());
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft>(emptyPaymentDraft());
  const [isPending, startTransition] = useTransition();

  const invoiceById = useMemo(() => new Map(invoices.map((invoice) => [invoice.id, invoice])), [invoices]);

  const visiblePayables = useMemo(() => {
    const needle = normalize(query.trim());
    return payables.filter((payable) => {
      if (statusFilter === "open" && ["paid", "cancelled"].includes(payable.status)) return false;
      if (statusFilter !== "open" && statusFilter !== "all" && payable.status !== statusFilter) return false;
      if (supplierFilter !== "all" && payable.supplier_id !== supplierFilter) return false;
      if (!needle) return true;
      return normalize([payable.supplier_name, payable.invoice_number, payable.purchase_number, payable.notes, payableLabels[payable.status]].filter(Boolean).join(" ")).includes(needle);
    });
  }, [payables, query, statusFilter, supplierFilter]);

  const visibleInvoices = useMemo(() => {
    const needle = normalize(query.trim());
    return invoices.filter((invoice) => {
      if (supplierFilter !== "all" && invoice.supplier_id !== supplierFilter) return false;
      if (!needle) return true;
      return normalize([invoice.supplier_name, invoice.invoice_number, invoice.purchase_number, invoiceLabels[invoice.status]].filter(Boolean).join(" ")).includes(needle);
    });
  }, [invoices, query, supplierFilter]);

  function runAction(action: Promise<{ ok: boolean; message: string }>, reset?: () => void) {
    startTransition(async () => {
      const result = await action.catch(() => ({ ok: false, message: "No se pudo completar la accion." }));
      if (result.ok) {
        toast.success(result.message);
        reset?.();
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  function editInvoice(invoice: AdminSupplierInvoice) {
    setTab("invoices");
    setInvoiceDraft({ id: invoice.id, supplier_id: invoice.supplier_id, purchase_id: invoice.purchase_id ?? "", invoice_number: invoice.invoice_number, invoice_date: invoice.invoice_date, due_date: invoice.due_date ?? "", subtotal: invoice.subtotal, tax_amount: invoice.tax_amount, discount_amount: invoice.discount_amount, currency: invoice.currency, notes: invoice.notes ?? "" });
  }

  function editPayable(payable: AdminAccountsPayable) {
    setTab("payables");
    setPayableDraft({ id: payable.id, supplier_id: payable.supplier_id, purchase_id: payable.purchase_id ?? "", supplier_invoice_id: payable.supplier_invoice_id ?? "", total_amount: payable.total_amount, due_date: payable.due_date ?? "", currency: payable.currency, notes: payable.notes ?? "" });
  }

  function createPayableFromInvoice(invoice: AdminSupplierInvoice) {
    setTab("payables");
    setPayableDraft({ supplier_id: invoice.supplier_id, purchase_id: invoice.purchase_id ?? "", supplier_invoice_id: invoice.id, total_amount: invoice.total, due_date: invoice.due_date ?? "", currency: invoice.currency, notes: "" });
  }

  function selectInvoiceForPayable(invoiceId: string) {
    const invoice = invoiceById.get(invoiceId);
    setPayableDraft({
      ...payableDraft,
      supplier_invoice_id: invoiceId,
      supplier_id: invoice?.supplier_id ?? payableDraft.supplier_id,
      purchase_id: invoice?.purchase_id ?? payableDraft.purchase_id,
      total_amount: invoice?.total ?? payableDraft.total_amount,
      due_date: invoice?.due_date ?? payableDraft.due_date,
      currency: invoice?.currency ?? payableDraft.currency,
    });
  }

  function selectPayableForPayment(payable: AdminAccountsPayable) {
    setPaymentDraft({ accounts_payable_id: payable.id, amount: payable.balance.toFixed(2), payment_method: "", paid_at: todayValue(), notes: "" });
  }

  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Saldo pendiente" value={formatCurrency(summary.totalPending)} />
        <Metric label="Saldo vencido" value={formatCurrency(summary.totalOverdue)} />
        <Metric label="Pagado este mes" value={formatCurrency(summary.paidThisMonth)} />
        <Metric label="Cuentas abiertas" value={summary.pendingCount.toLocaleString("es-HN")} />
        <Metric label="Cuentas vencidas" value={summary.overdueCount.toLocaleString("es-HN")} />
      </section>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div><h2 className="text-lg font-semibold">Cuentas por pagar</h2><p className="text-sm text-black/55">Facturas, saldos y pagos a proveedores.</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => setTab("payables")} className={`rounded-md border px-3 py-2 text-sm font-semibold ${tab === "payables" ? "border-[#e4252c] bg-[#fff1f2] text-[#b91c25]" : "border-black/10 bg-white"}`}>Cuentas por pagar</button><button type="button" onClick={() => setTab("invoices")} className={`rounded-md border px-3 py-2 text-sm font-semibold ${tab === "invoices" ? "border-[#e4252c] bg-[#fff1f2] text-[#b91c25]" : "border-black/10 bg-white"}`}>Facturas de proveedor</button></div></div>
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_240px_220px_auto] lg:items-center"><label className="flex min-w-0 items-center gap-2 rounded-md border border-black/10 px-3 py-2 focus-within:border-[#e4252c] focus-within:ring-2 focus-within:ring-[#e4252c]/15"><Search size={18} className="shrink-0 text-black/45" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por proveedor, factura, compra o estado" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label><select value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm"><option value="all">Todos los proveedores</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm"><option value="open">Abiertas</option><option value="pending">Pendientes</option><option value="partial">Parciales</option><option value="paid">Pagadas</option><option value="cancelled">Anuladas</option><option value="all">Todas</option></select>{query ? <Button type="button" variant="ghost" onClick={() => setQuery("")}><X size={16} />Limpiar</Button> : null}</div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="min-w-0 space-y-4">
            {tab === "payables" ? (
              <PayablesTable payables={visiblePayables} canManage={canManage} isPending={isPending} onEdit={editPayable} onPay={selectPayableForPayment} onCancel={(payable) => runAction(cancelAccountsPayableAction(payable.id))} onVoid={(paymentId) => runAction(voidSupplierPaymentAction(paymentId, prompt("Motivo de anulacion") ?? undefined))} />
            ) : (
              <InvoicesTable invoices={visibleInvoices} canManage={canManage} isPending={isPending} onEdit={editInvoice} onCreatePayable={createPayableFromInvoice} onReceive={(invoice) => runAction(receiveSupplierInvoiceAction(invoice.id))} onCancel={(invoice) => runAction(cancelSupplierInvoiceAction(invoice.id))} />
            )}
          </div>

          <div className="space-y-4">
            <FormPanel title={invoiceDraft.id ? "Editar factura de proveedor" : "Registrar factura de proveedor"} onReset={() => setInvoiceDraft(emptyInvoiceDraft())} showReset={Boolean(invoiceDraft.id)}>
              <Field label="Proveedor"><select value={invoiceDraft.supplier_id} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, supplier_id: event.target.value })} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm" disabled={!canManage || isPending}><option value="">Seleccionar</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></Field>
              <Field label="Compra opcional"><select value={invoiceDraft.purchase_id ?? ""} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, purchase_id: event.target.value })} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm" disabled={!canManage || isPending}><option value="">Sin compra</option>{purchases.map((purchase) => <option key={purchase.id} value={purchase.id}>{purchase.purchase_number}</option>)}</select></Field>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Numero de factura"><Input value={invoiceDraft.invoice_number} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, invoice_number: event.target.value })} disabled={!canManage || isPending} /></Field><Field label="Fecha de factura"><Input type="date" value={invoiceDraft.invoice_date} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, invoice_date: event.target.value })} disabled={!canManage || isPending} /></Field></div>
              <Field label="Fecha de vencimiento"><Input type="date" value={invoiceDraft.due_date ?? ""} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, due_date: event.target.value })} disabled={!canManage || isPending} /></Field>
              <div className="grid gap-3 sm:grid-cols-3"><Field label="Subtotal"><Input type="number" min="0" step="0.01" value={invoiceDraft.subtotal} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, subtotal: event.target.value })} disabled={!canManage || isPending} /></Field><Field label="Impuesto"><Input type="number" min="0" step="0.01" value={invoiceDraft.tax_amount ?? 0} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, tax_amount: event.target.value })} disabled={!canManage || isPending} /></Field><Field label="Descuento"><Input type="number" min="0" step="0.01" value={invoiceDraft.discount_amount ?? 0} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, discount_amount: event.target.value })} disabled={!canManage || isPending} /></Field></div>
              <p className="text-sm font-semibold">Total: {formatCurrency(invoiceTotal(invoiceDraft))}</p>
              <Field label="Notas"><textarea value={invoiceDraft.notes ?? ""} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, notes: event.target.value })} rows={2} className="rounded-md border border-black/10 px-3 py-2 text-sm" disabled={!canManage || isPending} /></Field>
              <Button type="button" onClick={() => runAction(saveSupplierInvoiceAction(invoiceDraft), () => setInvoiceDraft(emptyInvoiceDraft()))} disabled={!canManage || isPending}><ReceiptText size={16} />Guardar factura</Button>
            </FormPanel>

            <FormPanel title={payableDraft.id ? "Editar cuenta por pagar" : "Crear cuenta por pagar"} onReset={() => setPayableDraft(emptyPayableDraft())} showReset={Boolean(payableDraft.id)}>
              <Field label="Factura opcional"><select value={payableDraft.supplier_invoice_id ?? ""} onChange={(event) => selectInvoiceForPayable(event.target.value)} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm" disabled={!canManage || isPending}><option value="">Sin factura</option>{invoices.filter((invoice) => invoice.status !== "cancelled").map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.invoice_number} - {invoice.supplier_name}</option>)}</select></Field>
              <Field label="Proveedor"><select value={payableDraft.supplier_id} onChange={(event) => setPayableDraft({ ...payableDraft, supplier_id: event.target.value })} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm" disabled={!canManage || isPending}><option value="">Seleccionar</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></Field>
              <Field label="Compra opcional"><select value={payableDraft.purchase_id ?? ""} onChange={(event) => setPayableDraft({ ...payableDraft, purchase_id: event.target.value })} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm" disabled={!canManage || isPending}><option value="">Sin compra</option>{purchases.map((purchase) => <option key={purchase.id} value={purchase.id}>{purchase.purchase_number}</option>)}</select></Field>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Total"><Input type="number" min="0.01" step="0.01" value={payableDraft.total_amount} onChange={(event) => setPayableDraft({ ...payableDraft, total_amount: event.target.value })} disabled={!canManage || isPending} /></Field><Field label="Vencimiento"><Input type="date" value={payableDraft.due_date ?? ""} onChange={(event) => setPayableDraft({ ...payableDraft, due_date: event.target.value })} disabled={!canManage || isPending} /></Field></div>
              <Field label="Notas"><textarea value={payableDraft.notes ?? ""} onChange={(event) => setPayableDraft({ ...payableDraft, notes: event.target.value })} rows={2} className="rounded-md border border-black/10 px-3 py-2 text-sm" disabled={!canManage || isPending} /></Field>
              <Button type="button" onClick={() => runAction(saveAccountsPayableAction(payableDraft), () => setPayableDraft(emptyPayableDraft()))} disabled={!canManage || isPending}><PlusCircle size={16} />Guardar cuenta</Button>
            </FormPanel>

            <FormPanel title="Registrar pago a proveedor">
              <Field label="Cuenta por pagar"><select value={paymentDraft.accounts_payable_id} onChange={(event) => setPaymentDraft({ ...paymentDraft, accounts_payable_id: event.target.value })} className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm" disabled={!canManage || isPending}><option value="">Seleccionar</option>{payables.filter((payable) => payable.balance > 0 && !["paid", "cancelled"].includes(payable.status)).map((payable) => <option key={payable.id} value={payable.id}>{payable.supplier_name} - {formatCurrency(payable.balance)}</option>)}</select></Field>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Monto"><Input type="number" min="0.01" step="0.01" value={paymentDraft.amount} onChange={(event) => setPaymentDraft({ ...paymentDraft, amount: event.target.value })} disabled={!canManage || isPending} /></Field><Field label="Fecha de pago"><Input type="date" value={paymentDraft.paid_at ?? ""} onChange={(event) => setPaymentDraft({ ...paymentDraft, paid_at: event.target.value })} disabled={!canManage || isPending} /></Field></div>
              <Field label="Metodo de pago"><Input value={paymentDraft.payment_method} onChange={(event) => setPaymentDraft({ ...paymentDraft, payment_method: event.target.value })} placeholder="Transferencia, cheque, efectivo" disabled={!canManage || isPending} /></Field>
              <Field label="Notas"><textarea value={paymentDraft.notes ?? ""} onChange={(event) => setPaymentDraft({ ...paymentDraft, notes: event.target.value })} rows={2} className="rounded-md border border-black/10 px-3 py-2 text-sm" disabled={!canManage || isPending} /></Field>
              <Button type="button" onClick={() => runAction(registerSupplierPaymentAction(paymentDraft), () => setPaymentDraft(emptyPaymentDraft()))} disabled={!canManage || isPending}><ReceiptText size={16} />Registrar pago</Button>
            </FormPanel>
          </div>
        </div>
      </section>
    </div>
  );
}

function PayablesTable({ payables, canManage, isPending, onEdit, onPay, onCancel, onVoid }: { payables: AdminAccountsPayable[]; canManage: boolean; isPending: boolean; onEdit: (payable: AdminAccountsPayable) => void; onPay: (payable: AdminAccountsPayable) => void; onCancel: (payable: AdminAccountsPayable) => void; onVoid: (paymentId: string) => void }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[1120px] text-left text-sm"><thead className="bg-[#e7e5e4] text-xs uppercase text-black/55"><tr><th className="px-3 py-2">Proveedor</th><th className="px-3 py-2">Factura</th><th className="px-3 py-2">Vencimiento</th><th className="px-3 py-2">Total</th><th className="px-3 py-2">Pagado</th><th className="px-3 py-2">Saldo</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2">Historial</th><th className="px-3 py-2">Acciones</th></tr></thead><tbody className="divide-y divide-black/10">{payables.map((payable) => <tr key={payable.id}><td className="px-3 py-3 align-top"><p className="font-semibold">{payable.supplier_name}</p><p className="text-xs text-black/50">{payable.purchase_number ?? "Sin compra"}</p></td><td className="px-3 py-3 align-top">{payable.invoice_number ?? "Sin factura"}</td><td className="px-3 py-3 align-top">{formatDate(payable.due_date)}</td><td className="px-3 py-3 align-top">{formatCurrency(payable.total_amount)}</td><td className="px-3 py-3 align-top">{formatCurrency(payable.paid_amount)}</td><td className="px-3 py-3 align-top font-semibold">{formatCurrency(payable.balance)}</td><td className="px-3 py-3 align-top">{payableLabels[payable.status]}</td><td className="px-3 py-3 align-top"><div className="grid gap-1">{payable.payments.length === 0 ? <span className="text-xs text-black/45">Sin pagos</span> : payable.payments.map((payment) => <div key={payment.id} className="rounded-md bg-[#f4f4f5] p-2 text-xs"><p className="font-semibold">{formatCurrency(payment.amount)} - {paymentLabels[payment.status]}</p><p>{payment.payment_method} - {formatDate(payment.paid_at ?? payment.created_at)}</p>{payment.status === "paid" && canManage ? <button type="button" onClick={() => onVoid(payment.id)} disabled={isPending} className="mt-1 font-semibold text-[#b91c25]">Anular pago</button> : null}</div>)}</div></td><td className="px-3 py-3 align-top"><div className="flex flex-wrap gap-2"><Button type="button" variant="ghost" onClick={() => onEdit(payable)} disabled={!canManage || isPending || ["paid", "cancelled"].includes(payable.status)}><Edit3 size={16} />Editar</Button><Button type="button" variant="ghost" onClick={() => onPay(payable)} disabled={!canManage || isPending || payable.balance <= 0 || ["paid", "cancelled"].includes(payable.status)}><ReceiptText size={16} />Registrar pago</Button><Button type="button" variant="ghost" onClick={() => onCancel(payable)} disabled={!canManage || isPending || ["paid", "cancelled"].includes(payable.status) || payable.paid_amount > 0}><Ban size={16} />Anular</Button></div></td></tr>)}{payables.length === 0 ? <tr><td colSpan={9} className="px-3 py-6 text-center text-black/55">No hay cuentas por pagar para este filtro.</td></tr> : null}</tbody></table></div>;
}

function InvoicesTable({ invoices, canManage, isPending, onEdit, onCreatePayable, onReceive, onCancel }: { invoices: AdminSupplierInvoice[]; canManage: boolean; isPending: boolean; onEdit: (invoice: AdminSupplierInvoice) => void; onCreatePayable: (invoice: AdminSupplierInvoice) => void; onReceive: (invoice: AdminSupplierInvoice) => void; onCancel: (invoice: AdminSupplierInvoice) => void }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-left text-sm"><thead className="bg-[#e7e5e4] text-xs uppercase text-black/55"><tr><th className="px-3 py-2">Factura</th><th className="px-3 py-2">Proveedor</th><th className="px-3 py-2">Compra</th><th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Vence</th><th className="px-3 py-2">Total</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2">Acciones</th></tr></thead><tbody className="divide-y divide-black/10">{invoices.map((invoice) => <tr key={invoice.id}><td className="px-3 py-3 align-top font-semibold">{invoice.invoice_number}</td><td className="px-3 py-3 align-top">{invoice.supplier_name}</td><td className="px-3 py-3 align-top">{invoice.purchase_number ?? "Sin compra"}</td><td className="px-3 py-3 align-top">{formatDate(invoice.invoice_date)}</td><td className="px-3 py-3 align-top">{formatDate(invoice.due_date)}</td><td className="px-3 py-3 align-top font-semibold">{formatCurrency(invoice.total)}</td><td className="px-3 py-3 align-top">{invoiceLabels[invoice.status]}</td><td className="px-3 py-3 align-top"><div className="flex flex-wrap gap-2"><Button type="button" variant="ghost" onClick={() => onEdit(invoice)} disabled={!canManage || isPending || !["draft", "received"].includes(invoice.status)}><Edit3 size={16} />Editar</Button><Button type="button" variant="ghost" onClick={() => onReceive(invoice)} disabled={!canManage || isPending || invoice.status !== "draft"}><CheckCircle2 size={16} />Recibir</Button><Button type="button" variant="ghost" onClick={() => onCreatePayable(invoice)} disabled={!canManage || isPending || !["received", "posted_to_ap"].includes(invoice.status)}><PlusCircle size={16} />Crear cuenta</Button><Button type="button" variant="ghost" onClick={() => onCancel(invoice)} disabled={!canManage || isPending || ["cancelled", "paid"].includes(invoice.status)}><Ban size={16} />Anular</Button></div></td></tr>)}{invoices.length === 0 ? <tr><td colSpan={8} className="px-3 py-6 text-center text-black/55">No hay facturas para este filtro.</td></tr> : null}</tbody></table></div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-black/10 bg-white p-4"><p className="text-sm text-black/50">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div>; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="grid gap-1 text-sm font-semibold">{label}{children}</label>; }
function FormPanel({ title, children, onReset, showReset = false }: { title: string; children: ReactNode; onReset?: () => void; showReset?: boolean }) { return <div className="rounded-lg border border-black/10 bg-[#fafafa] p-4"><div className="mb-4 flex items-start justify-between gap-3"><h3 className="font-semibold">{title}</h3>{showReset && onReset ? <Button type="button" variant="ghost" onClick={onReset}>Cancelar</Button> : null}</div><div className="grid gap-3">{children}</div></div>; }







