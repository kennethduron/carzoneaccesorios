"use client";

import { useMemo, useState, useTransition } from "react";
import { BookOpen, CheckCircle2, FileText, Landmark, Plus, RotateCcw, Save, ToggleLeft, ToggleRight } from "lucide-react";
import {
  postJournalEntryAction,
  reverseJournalEntryAction,
  saveAccountingAccountAction,
  saveJournalDraftAction,
  toggleAccountingAccountAction,
} from "@/app/admin/contabilidad/actions";
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

type AccountingManagerProps = {
  data: AccountingPageData;
  canManage: boolean;
  canCreate: boolean;
  canPost: boolean;
  canReverse: boolean;
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

const emptyAccount: AccountingAccountInput = {
  code: "",
  name: "",
  type: "asset",
  parent_id: null,
  normal_balance: "debit",
  is_active: true,
  description: "",
};

const emptyLine = (): JournalEntryLineInput => ({
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

export function AccountingManager({ data, canManage, canCreate, canPost, canReverse }: AccountingManagerProps) {
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

  const journalTotals = useMemo(() => {
    const debit = journalForm.lines.reduce((sum, line) => sum + Number(line.debit ?? 0), 0);
    const credit = journalForm.lines.reduce((sum, line) => sum + Number(line.credit ?? 0), 0);
    return {
      debit: Math.round(debit * 100) / 100,
      credit: Math.round(credit * 100) / 100,
      balanced: Math.round(debit * 100) === Math.round(credit * 100) && debit > 0,
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
    startTransition(async () => {
      const result = await saveJournalDraftAction({
        id: journalForm.id || undefined,
        entry_date: journalForm.entry_date,
        description: journalForm.description,
        source_type: journalForm.source_type || null,
        source_id: journalForm.source_id || null,
        lines: journalForm.lines,
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
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Cuentas contables" value={data.summary.totalAccounts.toLocaleString("es-HN")} helper={`${data.summary.activeAccounts.toLocaleString("es-HN")} activas`} />
        <MetricCard label="Partidas del mes" value={data.summary.journalEntriesThisMonth.toLocaleString("es-HN")} helper="Libro diario" />
        <MetricCard label="Partidas en borrador" value={data.summary.draftEntries.toLocaleString("es-HN")} helper="Pendientes de publicar" />
        <MetricCard
          label="Última partida"
          value={data.summary.latestEntry?.entry_number ?? "Sin partidas"}
          helper={data.summary.latestEntry ? data.summary.latestEntry.description : "Crea la primera partida manual"}
        />
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="rounded-lg border border-black/10 bg-white p-4 shadow-sm">
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

          {canWriteAccounts ? (
            <div className="mb-4 rounded-md border border-black/10 bg-[#fafafa] p-3">
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
            <p className="mb-4 rounded-md border border-black/10 bg-[#fafafa] p-3 text-sm text-black/60">
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

        <div id="libro-diario" className="scroll-mt-24 rounded-lg border border-black/10 bg-white p-4 shadow-sm">
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
            <div className="mb-4 rounded-md border border-black/10 bg-[#fafafa] p-3">
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

              <div className="mt-4 space-y-2">
                {journalForm.lines.map((line, index) => (
                  <div key={index} className="grid gap-2 rounded-md border border-black/10 bg-white p-2 lg:grid-cols-[minmax(170px,1fr)_120px_120px_minmax(150px,1fr)_auto]">
                    <select
                      value={line.account_id}
                      onChange={(event) =>
                        setJournalForm((current) => ({
                          ...current,
                          lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, account_id: event.target.value } : item),
                        }))
                      }
                      className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
                    >
                      <option value="">Cuenta contable</option>
                      {data.activeAccounts.map((account) => (
                        <option key={account.id} value={account.id}>{account.code} - {account.name}</option>
                      ))}
                    </select>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.debit}
                      onChange={(event) =>
                        setJournalForm((current) => ({
                          ...current,
                          lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, debit: Number(event.target.value), credit: Number(event.target.value) > 0 ? 0 : item.credit } : item),
                        }))
                      }
                      placeholder="Débito"
                    />
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.credit}
                      onChange={(event) =>
                        setJournalForm((current) => ({
                          ...current,
                          lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, credit: Number(event.target.value), debit: Number(event.target.value) > 0 ? 0 : item.debit } : item),
                        }))
                      }
                      placeholder="Crédito"
                    />
                    <Input
                      value={line.description ?? ""}
                      onChange={(event) =>
                        setJournalForm((current) => ({
                          ...current,
                          lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item),
                        }))
                      }
                      placeholder="Detalle"
                    />
                    <Button
                      variant="ghost"
                      disabled={journalForm.lines.length <= 2}
                      onClick={() =>
                        setJournalForm((current) => ({
                          ...current,
                          lines: current.lines.filter((_, itemIndex) => itemIndex !== index),
                        }))
                      }
                    >
                      Quitar
                    </Button>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="grid gap-1 text-sm text-black/60 sm:grid-cols-2 sm:gap-4">
                  <span>Total débito: <strong className="text-black">{formatCurrency(journalTotals.debit)}</strong></span>
                  <span>Total crédito: <strong className="text-black">{formatCurrency(journalTotals.credit)}</strong></span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" onClick={() => setJournalForm((current) => ({ ...current, lines: [...current.lines, emptyLine()] }))}>
                    <Plus size={16} />
                    Agregar línea
                  </Button>
                  <Button onClick={saveDraft} disabled={isPending} variant="dark">
                    <Save size={16} />
                    Guardar borrador
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <p className="mb-4 rounded-md border border-black/10 bg-[#fafafa] p-3 text-sm text-black/60">
              Tienes acceso de lectura. No puedes crear, publicar ni reversar partidas.
            </p>
          )}

          <JournalEntries entries={data.journalEntries} canPost={canPost} canReverse={canReverse} onPost={postEntry} onReverse={reverseEntry} isPending={isPending} />
          <div className="mt-3">
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
        </div>
      </section>

      {message ? <p className="rounded-md border border-black/10 bg-white p-3 text-sm text-black/65">{message}</p> : null}
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
  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <article key={entry.id} className="rounded-md border border-black/10 bg-white p-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <FileText size={16} />
                <h3 className="font-semibold">{entry.entry_number}</h3>
                <EntryStatus status={entry.status} />
              </div>
              <p className="mt-1 text-sm text-black/60">{entry.description}</p>
              <p className="mt-1 text-xs text-black/45">
                Fecha: {entry.entry_date} · Creada: {formatHnDateTime(entry.created_at)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {canPost && entry.status === "borrador" ? (
                <Button disabled={isPending} variant="dark" onClick={() => onPost(entry.id)}>
                  <CheckCircle2 size={16} />
                  Publicar
                </Button>
              ) : null}
              {canReverse && entry.status === "publicada" ? (
                <Button disabled={isPending} variant="ghost" onClick={() => onReverse(entry.id)}>
                  <RotateCcw size={16} />
                  Reversar
                </Button>
              ) : null}
            </div>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[620px] text-left text-sm">
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
                    <td className="py-2 pr-3">
                      {line.account ? `${line.account.code} - ${line.account.name}` : "Cuenta"}
                    </td>
                    <td className="py-2 pr-3 text-right font-semibold">{line.debit > 0 ? formatCurrency(line.debit) : "-"}</td>
                    <td className="py-2 pr-3 text-right font-semibold">{line.credit > 0 ? formatCurrency(line.credit) : "-"}</td>
                    <td className="py-2 pr-3 text-black/55">{line.description ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-black/10 font-semibold">
                <tr>
                  <td className="py-2 pr-3">Totales</td>
                  <td className="py-2 pr-3 text-right">{formatCurrency(entry.total_debit)}</td>
                  <td className="py-2 pr-3 text-right">{formatCurrency(entry.total_credit)}</td>
                  <td className="py-2 pr-3">{entry.total_debit === entry.total_credit ? "Cuadrada" : "Descuadrada"}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </article>
      ))}
      {entries.length === 0 ? (
        <p className="rounded-md border border-dashed border-black/15 bg-[#fafafa] p-4 text-sm text-black/55">
          No hay partidas contables registradas.
        </p>
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



