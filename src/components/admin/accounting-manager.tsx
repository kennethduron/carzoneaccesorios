"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { BookOpen, CheckCircle2, Eye, FileText, Landmark, Plus, RotateCcw, Save, Trash2, ToggleLeft, ToggleRight } from "lucide-react";
import {
  postJournalEntryAction,
  reverseJournalEntryAction,
  saveAccountingAccountAction,
  saveJournalDraftAction,
  toggleAccountingAccountAction,
} from "@/app/admin/contabilidad/actions";
import { ChartOfAccountsTools } from "@/components/admin/chart-of-accounts-tools";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type {
  AccountingAccount,
  AccountingAccountInput,
  AccountingAccountType,
  AccountingNormalBalance,
  AccountingPageData,
  JournalEntry,
  JournalEntryLineInput,
} from "@/types/accounting";
import { formatHnDateTime } from "@/utils/format";

type AccountingManagerSection = "summary" | "accounts" | "journal" | "entries";

type AccountingManagerProps = {
  data: AccountingPageData;
  canManage: boolean;
  canCreate: boolean;
  canPost: boolean;
  canReverse: boolean;
  canExport?: boolean;
  canCsvExport?: boolean;
  visibleSections?: AccountingManagerSection[];
};

type JournalEntryLineFormInput = Omit<JournalEntryLineInput, "debit" | "credit"> & {
  debit: number | string;
  credit: number | string;
};

const accountTypeLabels: Record<AccountingAccountType, string> = {
  asset: "Activo",
  liability: "Pasivo",
  equity: "Patrimonio",
  revenue: "Ingreso",
  cost: "Costo",
  expense: "Gasto",
};

const normalBalanceLabels: Record<AccountingNormalBalance, string> = {
  debit: "Débito",
  credit: "Crédito",
};

const journalSourceLabels: Record<string, string> = {
  manual: "Partida manual",
  financial_event: "Evento financiero",
  order: "Venta",
  payment: "Pago recibido",
  invoice: "Factura",
  commercial_credit: "Credito comercial",
  accounts_receivable: "Cuenta por cobrar",
  receivable_payment: "Abono recibido",
  inventory_movement: "Inventario",
  purchase: "Compra",
  supplier_invoice: "Factura de proveedor",
  accounts_payable: "Cuenta por pagar",
  supplier_payment: "Pago a proveedor",
  purchase_return: "Devolucion a proveedor",
  supplier_credit: "Credito de proveedor",
};

function journalSourceLabel(sourceType: string | null) {
  if (!sourceType) return "Partida manual";
  return journalSourceLabels[sourceType] ?? "Origen contable";
}

const emptyAccount: AccountingAccountInput = {
  code: "",
  name: "",
  type: "asset",
  parent_id: null,
  normal_balance: "debit",
  is_active: true,
  description: "",
};

const emptyLine = (): JournalEntryLineFormInput => ({
  account_id: "",
  debit: 0,
  credit: 0,
  description: "",
});

function todayKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(new Date());
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("es-HN", {
    style: "currency",
    currency: "HNL",
  }).format(value);
}

function parseAccountingAmount(value: string | number | null | undefined): number {
  if (value === "" || value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function amountInputValue(value: string | number | null | undefined) {
  return value === null || value === undefined ? "" : String(value);
}

function normalizeJournalLines(lines: JournalEntryLineFormInput[]): JournalEntryLineInput[] {
  return lines.map((line) => ({
    ...line,
    debit: parseAccountingAmount(line.debit),
    credit: parseAccountingAmount(line.credit),
  }));
}

export function AccountingManager({ data, canManage, canCreate, canPost, canReverse, canExport = false, canCsvExport = false, visibleSections = ["summary", "accounts", "journal", "entries"] }: AccountingManagerProps) {
  const [accountForm, setAccountForm] = useState<AccountingAccountInput>(emptyAccount);
  const [journalForm, setJournalForm] = useState({
    id: "",
    entry_date: todayKey(),
    description: "",
    source_type: "",
    source_id: "",
    lines: [emptyLine(), emptyLine()],
  });
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();
  const canWriteAccounts = canManage || canCreate;
  const canWriteJournal = canCreate || canManage;
  const showSummary = visibleSections.includes("summary");
  const showAccounts = visibleSections.includes("accounts");
  const showJournal = visibleSections.includes("journal");
  const showEntries = visibleSections.includes("entries");

  const journalTotals = useMemo(() => {
    const debit = journalForm.lines.reduce((sum, line) => sum + parseAccountingAmount(line.debit), 0);
    const credit = journalForm.lines.reduce((sum, line) => sum + parseAccountingAmount(line.credit), 0);
    const debitTotal = Math.round(debit * 100) / 100;
    const creditTotal = Math.round(credit * 100) / 100;
    const difference = Math.round(Math.abs(debitTotal - creditTotal) * 100) / 100;

    return {
      debit: debitTotal,
      credit: creditTotal,
      difference,
      balanced: difference === 0 && debitTotal > 0,
    };
  }, [journalForm.lines]);

  function submitAccount() {
    startTransition(async () => {
      const result = await saveAccountingAccountAction(accountForm);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
        setAccountForm(emptyAccount);
      } else {
        toast.error(result.message);
      }
    });
  }

  function editAccount(account: AccountingAccount) {
    setAccountForm({
      id: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      parent_id: account.parent_id,
      normal_balance: account.normal_balance,
      is_active: account.is_active,
      description: account.description ?? "",
    });
  }

  function toggleAccount(account: AccountingAccount) {
    startTransition(async () => {
      const result = await toggleAccountingAccountAction(account.id, !account.is_active);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function saveDraft() {
    const lines = normalizeJournalLines(journalForm.lines);

    startTransition(async () => {
      const result = await saveJournalDraftAction({
        id: journalForm.id || undefined,
        entry_date: journalForm.entry_date,
        description: journalForm.description,
        source_type: journalForm.source_type || null,
        source_id: journalForm.source_id || null,
        lines,
      });
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
        setJournalForm({
          id: "",
          entry_date: todayKey(),
          description: "",
          source_type: "",
          source_id: "",
          lines: [emptyLine(), emptyLine()],
        });
      } else {
        toast.error(result.message);
      }
    });
  }

  function postEntry(entryId: string) {
    startTransition(async () => {
      const result = await postJournalEntryAction(entryId);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function reverseEntry(entryId: string) {
    startTransition(async () => {
      const result = await reverseJournalEntryAction(entryId);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <div className="space-y-6">
      {showSummary ? (
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Cuentas contables" value={data.summary.totalAccounts.toLocaleString("es-HN")} helper={`${data.summary.activeAccounts.toLocaleString("es-HN")} activas`} />
        <MetricCard label="Partidas del mes" value={data.summary.journalEntriesThisMonth.toLocaleString("es-HN")} helper="Libro diario" />
        <MetricCard label="Partidas en borrador" value={data.summary.draftEntries.toLocaleString("es-HN")} helper="Pendientes de publicar" />
        <MetricCard
          label="Última partida"
          value={data.summary.latestEntry?.entry_number ?? "Sin partidas"}
          helper={data.summary.latestEntry ? data.summary.latestEntry.description : "Crea la primera partida manual"}
        />
      </section>
      ) : null}

      {showAccounts || showJournal ? (
      <section className={showAccounts && showJournal ? "grid gap-6 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]" : "grid gap-6"}>
        {showAccounts ? (
        <div className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-black/10 bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Landmark size={19} />
                <h2 className="text-lg font-semibold">Catálogo de cuentas</h2>
              </div>
              <p className="mt-1 text-sm text-black/55">Activo, pasivo, patrimonio, ingreso, costo y gasto.</p>
            </div>
            <a href="#libro-diario" className="text-sm font-semibold text-[#e4252c]">Libro diario</a>
          </div>

          <ChartOfAccountsTools canManage={canManage} canExport={canExport} canCsvExport={canCsvExport} />

          {canWriteAccounts ? (
            <div className="mb-4 rounded-xl border border-black/10 bg-[#fafafa] p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase text-black/50">Código</span>
                  <Input value={accountForm.code} onChange={(event) => setAccountForm((current) => ({ ...current, code: event.target.value }))} placeholder="1101" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase text-black/50">Nombre</span>
                  <Input value={accountForm.name} onChange={(event) => setAccountForm((current) => ({ ...current, name: event.target.value }))} placeholder="Caja general" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase text-black/50">Tipo</span>
                  <select
                    value={accountForm.type}
                    onChange={(event) => {
                      const type = event.target.value as AccountingAccountType;
                      setAccountForm((current) => ({
                        ...current,
                        type,
                        normal_balance: ["asset", "cost", "expense"].includes(type) ? "debit" : "credit",
                      }));
                    }}
                    className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
                  >
                    {Object.entries(accountTypeLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase text-black/50">Naturaleza</span>
                  <select
                    value={accountForm.normal_balance}
                    onChange={(event) => setAccountForm((current) => ({ ...current, normal_balance: event.target.value as AccountingNormalBalance }))}
                    className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
                  >
                    {Object.entries(normalBalanceLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="mt-3 block">
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Descripción</span>
                <textarea
                  value={accountForm.description ?? ""}
                  onChange={(event) => setAccountForm((current) => ({ ...current, description: event.target.value }))}
                  className="min-h-20 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
                />
              </label>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={submitAccount} disabled={isPending} variant="dark">
                  <Save size={16} />
                  {accountForm.id ? "Actualizar cuenta" : "Crear cuenta"}
                </Button>
                {accountForm.id ? (
                  <Button onClick={() => setAccountForm(emptyAccount)} disabled={isPending} variant="ghost">
                    Nueva cuenta
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="mb-4 rounded-xl border border-black/10 bg-[#fafafa] p-3 text-sm text-black/60">
              Tienes acceso de lectura. No puedes crear ni editar cuentas contables.
            </p>
          )}

          <AccountsTable accounts={data.accounts} canManage={canManage} onEdit={editAccount} onToggle={toggleAccount} />
          <div className="mt-3">
            <PaginationControls
              basePath="/admin/contabilidad"
              page={data.accountPage}
              pageSize={data.accountPageSize}
              total={data.accountTotal}
              label="cuentas"
              pageParam="account_page"
              params={{ journal_page: data.journalPage }}
            />
          </div>
        </div>

        ) : null}

        {showJournal ? (
        <div id="libro-diario" className="scroll-mt-24 rounded-2xl border border-black/10 bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <BookOpen size={19} />
                <h2 className="text-lg font-semibold">Libro diario</h2>
              </div>
              <p className="mt-1 text-sm text-black/55">Partidas manuales con líneas de débito y crédito.</p>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${journalTotals.balanced ? "bg-[#edf7ed] text-[#2f6f3e]" : "bg-[#fff7ed] text-[#7c2d12]"}`}>
              {journalTotals.balanced ? "Cuadrada" : "Pendiente de cuadrar"}
            </span>
          </div>

          {canWriteJournal ? (
            <div className="mb-4 rounded-xl border border-black/10 bg-[#fafafa] p-3">
              <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase text-black/50">Fecha</span>
                  <Input type="date" value={journalForm.entry_date} onChange={(event) => setJournalForm((current) => ({ ...current, entry_date: event.target.value }))} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase text-black/50">Descripción</span>
                  <Input value={journalForm.description} onChange={(event) => setJournalForm((current) => ({ ...current, description: event.target.value }))} placeholder="Partida manual de apertura" />
                </label>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase text-black/50">Tipo de origen</span>
                  <Input value={journalForm.source_type} onChange={(event) => setJournalForm((current) => ({ ...current, source_type: event.target.value }))} placeholder="manual" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase text-black/50">ID de origen</span>
                  <Input value={journalForm.source_id} onChange={(event) => setJournalForm((current) => ({ ...current, source_id: event.target.value }))} placeholder="Opcional" />
                </label>
              </div>

              <div className="mt-4 overflow-hidden rounded-xl border border-black/10 bg-white">
                <div className="hidden grid-cols-[minmax(190px,1.2fr)_minmax(150px,1fr)_112px_112px_56px] gap-2 border-b border-black/10 bg-[#f3f4f6] px-3 py-2 text-xs font-semibold uppercase text-black/50 lg:grid">
                  <span>Cuenta</span>
                  <span>Descripción</span>
                  <span>Débito</span>
                  <span>Crédito</span>
                  <span className="text-center">Acción</span>
                </div>
                <div className="divide-y divide-black/10">
                  {journalForm.lines.map((line, index) => (
                    <div key={index} className="grid gap-3 p-3 lg:grid-cols-[minmax(190px,1.2fr)_minmax(150px,1fr)_112px_112px_56px] lg:items-center">
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium uppercase text-black/50 lg:hidden">Cuenta</span>
                        <select
                          value={line.account_id}
                          onChange={(event) =>
                            setJournalForm((current) => ({
                              ...current,
                              lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, account_id: event.target.value } : item),
                            }))
                          }
                          className="h-10 w-full rounded-md border border-black/10 bg-white px-3 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
                        >
                          <option value="">Seleccionar cuenta</option>
                          {data.activeAccounts.map((account) => (
                            <option key={account.id} value={account.id}>{account.code} - {account.name}</option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium uppercase text-black/50 lg:hidden">Descripción</span>
                        <Input
                          value={line.description ?? ""}
                          onChange={(event) =>
                            setJournalForm((current) => ({
                              ...current,
                              lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item),
                            }))
                          }
                          placeholder="Descripción"
                          className="h-10 text-sm"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium uppercase text-black/50 lg:hidden">Débito</span>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={amountInputValue(line.debit)}
                          onChange={(event) =>
                            setJournalForm((current) => ({
                              ...current,
                              lines: current.lines.map((item, itemIndex) => {
                                if (itemIndex !== index) return item;
                                const debit = event.target.value;
                                return {
                                  ...item,
                                  debit,
                                  credit: parseAccountingAmount(debit) > 0 ? "" : item.credit,
                                };
                              }),
                            }))
                          }
                          placeholder="0.00"
                          className="h-10 text-sm"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium uppercase text-black/50 lg:hidden">Crédito</span>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={amountInputValue(line.credit)}
                          onChange={(event) =>
                            setJournalForm((current) => ({
                              ...current,
                              lines: current.lines.map((item, itemIndex) => {
                                if (itemIndex !== index) return item;
                                const credit = event.target.value;
                                return {
                                  ...item,
                                  credit,
                                  debit: parseAccountingAmount(credit) > 0 ? "" : item.debit,
                                };
                              }),
                            }))
                          }
                          placeholder="0.00"
                          className="h-10 text-sm"
                        />
                      </label>
                      <div className="flex justify-end lg:justify-center">
                        <button
                          type="button"
                          aria-label="Quitar línea"
                          title="Quitar línea"
                          disabled={journalForm.lines.length <= 2}
                          onClick={() =>
                            setJournalForm((current) => ({
                              ...current,
                              lines: current.lines.filter((_, itemIndex) => itemIndex !== index),
                            }))
                          }
                          className="grid size-10 place-items-center rounded-md border border-black/10 bg-white text-black/60 transition-colors hover:border-[#e4252c]/35 hover:bg-[#fff1f2] hover:text-[#b91c25] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="grid gap-2 text-sm text-black/65 sm:grid-cols-3">
                  <span className="rounded-full border border-black/10 bg-white px-3 py-2">Total débito: <strong className="text-black">{formatCurrency(journalTotals.debit)}</strong></span>
                  <span className="rounded-full border border-black/10 bg-white px-3 py-2">Total crédito: <strong className="text-black">{formatCurrency(journalTotals.credit)}</strong></span>
                  <span className={`rounded-full border px-3 py-2 ${journalTotals.balanced ? "border-[#2f6f3e]/20 bg-[#edf7ed] text-[#2f6f3e]" : "border-[#e4252c]/20 bg-[#fff1f2] text-[#b91c25]"}`}>
                    Diferencia: <strong>{formatCurrency(journalTotals.difference)}</strong>
                  </span>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <Button className="w-full sm:w-auto" variant="ghost" onClick={() => setJournalForm((current) => ({ ...current, lines: [...current.lines, emptyLine()] }))}>
                    <Plus size={16} />
                    Agregar línea
                  </Button>
                  <Button className="w-full sm:w-auto" onClick={saveDraft} disabled={isPending} variant="dark">
                    <Save size={16} />
                    Guardar borrador
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <p className="mb-4 rounded-xl border border-black/10 bg-[#fafafa] p-3 text-sm text-black/60">
              Tienes acceso de lectura. No puedes crear, publicar ni reversar partidas.
            </p>
          )}

        </div>
        ) : null}
      </section>
      ) : null}

      {showEntries ? (
      <section className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-black/10 bg-white p-4 shadow-sm sm:p-5">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <FileText size={19} />
              <h2 className="text-lg font-semibold">Últimas partidas</h2>
            </div>
            <p className="mt-1 text-sm text-black/55">Movimientos recientes del libro diario.</p>
          </div>
        </div>
        <JournalEntries entries={data.journalEntries} canPost={canPost} canReverse={canReverse} onPost={postEntry} onReverse={reverseEntry} isPending={isPending} />
        <div className="mt-4">
          <PaginationControls
            basePath="/admin/contabilidad"
            page={data.journalPage}
            pageSize={data.journalPageSize}
            total={data.journalTotal}
            label="partidas"
            pageParam="journal_page"
            params={{ account_page: data.accountPage }}
          />
        </div>
      </section>
      ) : null}

      {message ? <p className="rounded-xl border border-black/10 bg-white p-3 text-sm text-black/65">{message}</p> : null}
    </div>
  );
}

function MetricCard({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <article className="rounded-lg border border-black/10 bg-white p-4 shadow-sm">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 break-words text-2xl font-semibold">{value}</p>
      <p className="mt-1 line-clamp-2 text-sm text-black/55">{helper}</p>
    </article>
  );
}

function AccountsTable({
  accounts,
  canManage,
  onEdit,
  onToggle,
}: {
  accounts: AccountingAccount[];
  canManage: boolean;
  onEdit: (account: AccountingAccount) => void;
  onToggle: (account: AccountingAccount) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-black/10">
      <div className="grid gap-2 p-2 md:hidden">
        {accounts.map((account) => (
          <article key={account.id} className="rounded-md border border-black/10 bg-white p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold">{account.code} - {account.name}</p>
                <p className="text-sm text-black/55">{accountTypeLabels[account.type]} · {normalBalanceLabels[account.normal_balance]}</p>
              </div>
              <StatusBadge active={account.is_active} />
            </div>
            {canManage ? (
              <div className="mt-3 flex gap-2">
                <Button variant="ghost" onClick={() => onEdit(account)}>Editar</Button>
                <Button variant="ghost" onClick={() => onToggle(account)}>{account.is_active ? "Desactivar" : "Activar"}</Button>
              </div>
            ) : null}
          </article>
        ))}
        {accounts.length === 0 ? <p className="p-3 text-sm text-black/55">No hay cuentas contables registradas.</p> : null}
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
            <tr>
              <th className="px-3 py-3">Código</th>
              <th className="px-3 py-3">Cuenta</th>
              <th className="px-3 py-3">Tipo</th>
              <th className="px-3 py-3">Naturaleza</th>
              <th className="px-3 py-3">Estado</th>
              {canManage ? <th className="px-3 py-3">Acciones</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-black/10">
            {accounts.map((account) => (
              <tr key={account.id}>
                <td className="px-3 py-3 font-semibold">{account.code}</td>
                <td className="px-3 py-3">
                  <p className="font-medium">{account.name}</p>
                  <p className="text-xs text-black/45">{account.description ?? "Sin descripción"}</p>
                </td>
                <td className="px-3 py-3">{accountTypeLabels[account.type]}</td>
                <td className="px-3 py-3">{normalBalanceLabels[account.normal_balance]}</td>
                <td className="px-3 py-3"><StatusBadge active={account.is_active} /></td>
                {canManage ? (
                  <td className="px-3 py-3">
                    <div className="flex gap-2">
                      <Button variant="ghost" onClick={() => onEdit(account)}>Editar</Button>
                      <Button variant="ghost" onClick={() => onToggle(account)}>
                        {account.is_active ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                        {account.is_active ? "Desactivar" : "Activar"}
                      </Button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
            {accounts.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-black/55" colSpan={canManage ? 6 : 5}>No hay cuentas contables registradas.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function JournalEntries({
  entries,
  canPost,
  canReverse,
  onPost,
  onReverse,
  isPending,
}: {
  entries: JournalEntry[];
  canPost: boolean;
  canReverse: boolean;
  onPost: (entryId: string) => void;
  onReverse: (entryId: string) => void;
  isPending: boolean;
}) {
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);

  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-black/15 bg-[#fafafa] p-5 text-sm text-black/60">
        <p className="font-semibold text-black">No hay partidas contables registradas.</p>
        <p className="mt-1">Crea la primera partida para comenzar.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="grid gap-3 md:hidden">
        {entries.map((entry) => (
          <article key={entry.id} id={`partida-${entry.id}`} className="rounded-xl border border-black/10 bg-white p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase text-black/45">{entry.entry_date}</p>
                <h3 className="mt-1 break-words font-semibold">{entry.description}</h3>
                <p className="mt-1 text-xs text-black/45">{entry.entry_number} · {journalSourceLabel(entry.source_type)}</p>
              </div>
              <EntryStatus status={entry.status} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <span className="rounded-md bg-[#f7f7f8] px-3 py-2">Débito: <strong>{formatCurrency(entry.total_debit)}</strong></span>
              <span className="rounded-md bg-[#f7f7f8] px-3 py-2">Crédito: <strong>{formatCurrency(entry.total_credit)}</strong></span>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="text-xs uppercase text-black/45">
                  <tr>
                    <th className="py-2 pr-3">Cuenta</th>
                    <th className="py-2 pr-3 text-right">Débito</th>
                    <th className="py-2 pr-3 text-right">Crédito</th>
                    <th className="py-2 pr-3">Descripción</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/10">
                  {entry.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="py-2 pr-3">{line.account ? `${line.account.code} - ${line.account.name}` : "Cuenta"}</td>
                      <td className="py-2 pr-3 text-right font-semibold">{line.debit > 0 ? formatCurrency(line.debit) : "-"}</td>
                      <td className="py-2 pr-3 text-right font-semibold">{line.credit > 0 ? formatCurrency(line.credit) : "-"}</td>
                      <td className="py-2 pr-3 text-black/55">{line.description ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <EntryActions entry={entry} canPost={canPost} canReverse={canReverse} onPost={onPost} onReverse={onReverse} isPending={isPending} />
          </article>
        ))}
      </div>

      <div className="hidden overflow-x-auto rounded-xl border border-black/10 md:block">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="bg-[#f3f4f6] text-xs uppercase text-black/50">
            <tr>
              <th className="px-3 py-3">Fecha</th>
              <th className="px-3 py-3">Descripción</th>
              <th className="px-3 py-3">Origen</th>
              <th className="px-3 py-3 text-right">Débito</th>
              <th className="px-3 py-3 text-right">Crédito</th>
              <th className="px-3 py-3">Estado</th>
              <th className="px-3 py-3 text-right">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/10">
            {entries.map((entry) => {
              const expanded = expandedEntryId === entry.id;

              return (
                <Fragment key={entry.id}>
                  <tr id={`partida-${entry.id}`} className="align-top">
                    <td className="px-3 py-3 font-medium">{entry.entry_date}</td>
                    <td className="px-3 py-3">
                      <p className="font-medium">{entry.description}</p>
                      <p className="mt-1 text-xs text-black/45">{entry.entry_number} · Creada: {formatHnDateTime(entry.created_at)}</p>
                    </td>
                    <td className="px-3 py-3">{journalSourceLabel(entry.source_type)}</td>
                    <td className="px-3 py-3 text-right font-semibold">{formatCurrency(entry.total_debit)}</td>
                    <td className="px-3 py-3 text-right font-semibold">{formatCurrency(entry.total_credit)}</td>
                    <td className="px-3 py-3"><EntryStatus status={entry.status} /></td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button className="px-3 py-1.5" variant="ghost" onClick={() => setExpandedEntryId(expanded ? null : entry.id)} aria-expanded={expanded}>
                          <Eye size={15} />
                          Ver
                        </Button>
                        <EntryActions entry={entry} canPost={canPost} canReverse={canReverse} onPost={onPost} onReverse={onReverse} isPending={isPending} compact />
                      </div>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr>
                      <td className="bg-[#fafafa] px-3 py-3" colSpan={7}>
                        <div className="overflow-x-auto rounded-lg border border-black/10 bg-white">
                          <table className="w-full min-w-[620px] text-left text-sm">
                            <thead className="text-xs uppercase text-black/45">
                              <tr>
                                <th className="px-3 py-2">Cuenta</th>
                                <th className="px-3 py-2 text-right">Débito</th>
                                <th className="px-3 py-2 text-right">Crédito</th>
                                <th className="px-3 py-2">Descripción</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-black/10">
                              {entry.lines.map((line) => (
                                <tr key={line.id}>
                                  <td className="px-3 py-2">{line.account ? `${line.account.code} - ${line.account.name}` : "Cuenta"}</td>
                                  <td className="px-3 py-2 text-right font-semibold">{line.debit > 0 ? formatCurrency(line.debit) : "-"}</td>
                                  <td className="px-3 py-2 text-right font-semibold">{line.credit > 0 ? formatCurrency(line.credit) : "-"}</td>
                                  <td className="px-3 py-2 text-black/55">{line.description ?? "-"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EntryActions({
  entry,
  canPost,
  canReverse,
  onPost,
  onReverse,
  isPending,
  compact = false,
}: {
  entry: JournalEntry;
  canPost: boolean;
  canReverse: boolean;
  onPost: (entryId: string) => void;
  onReverse: (entryId: string) => void;
  isPending: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-wrap gap-2 ${compact ? "justify-end" : "mt-3"}`}>
      {canPost && entry.status === "borrador" ? (
        <Button className={compact ? "px-3 py-1.5" : ""} disabled={isPending} variant="dark" onClick={() => onPost(entry.id)}>
          <CheckCircle2 size={16} />
          Publicar
        </Button>
      ) : null}
      {canReverse && entry.status === "publicada" ? (
        <Button className={compact ? "px-3 py-1.5" : ""} disabled={isPending} variant="ghost" onClick={() => onReverse(entry.id)}>
          <RotateCcw size={16} />
          Reversar
        </Button>
      ) : null}
    </div>
  );
}
function StatusBadge({ active }: { active: boolean }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${active ? "bg-[#edf7ed] text-[#2f6f3e]" : "bg-[#f4f4f5] text-black/55"}`}>
      {active ? "Activa" : "Inactiva"}
    </span>
  );
}

function EntryStatus({ status }: { status: JournalEntry["status"] }) {
  const classes = {
    borrador: "bg-[#fff7ed] text-[#7c2d12]",
    publicada: "bg-[#edf7ed] text-[#2f6f3e]",
    reversada: "bg-[#eef2ff] text-[#3730a3]",
    anulada: "bg-[#f4f4f5] text-black/55",
  }[status];

  const label = {
    borrador: "Borrador",
    publicada: "Publicada",
    reversada: "Reversada",
    anulada: "Anulada",
  }[status];

  return <span className={`rounded-full px-2 py-1 text-xs font-semibold ${classes}`}>{label}</span>;
}



