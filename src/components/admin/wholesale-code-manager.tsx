"use client";

import { useMemo, useState, useTransition } from "react";
import { CheckCircle2, Download, KeyRound, Pencil, Save, Search, X } from "lucide-react";
import {
  saveWholesaleCodeAction,
  setWholesaleCodeActiveAction,
} from "@/app/admin/codigos-mayoristas/actions";
import { Button, Input } from "@/components/ui";
import { formatCurrency } from "@/utils/pricing";
import type {
  WholesaleCodeAdminRow,
  WholesaleCodeFormInput,
  WholesaleCodeStatus,
  WholesaleCustomerOption,
} from "@/types/wholesale";

type WholesaleCodeManagerProps = {
  codes: WholesaleCodeAdminRow[];
  customers: WholesaleCustomerOption[];
};

const statusLabels: Record<WholesaleCodeStatus, string> = {
  active: "Activo",
  inactive: "Inactivo",
  expired: "Vencido",
  disabled: "Bloqueado",
};

const emptyCode: WholesaleCodeFormInput = {
  customer_id: null,
  code: "",
  label: "",
  minimum_order: 0,
  max_uses: null,
  used_count: 0,
  status: "active",
  active: true,
  starts_at: null,
  expires_at: null,
};

function toDateInput(value: string | null) {
  return value ? value.slice(0, 10) : "";
}

function toForm(row: WholesaleCodeAdminRow): WholesaleCodeFormInput {
  return {
    id: row.id,
    customer_id: row.customer_id,
    code: row.code,
    label: row.label,
    minimum_order: row.minimum_order,
    max_uses: row.max_uses,
    used_count: row.used_count,
    status: row.status,
    active: row.active,
    starts_at: toDateInput(row.starts_at),
    expires_at: toDateInput(row.expires_at),
  };
}

function numberValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function csvValue(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function WholesaleCodeManager({ codes, customers }: WholesaleCodeManagerProps) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<WholesaleCodeFormInput | null>(null);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const filteredCodes = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return codes.filter((code) => {
      if (!normalizedQuery) {
        return true;
      }

      return `${code.code} ${code.label} ${code.customer_name ?? ""} ${code.business_name ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [codes, query]);

  const activeCount = codes.filter((code) => code.active && code.status === "active").length;
  const totalUses = codes.reduce((sum, code) => sum + code.used_count, 0);
  const expiredCount = codes.filter((code) => code.expires_at && new Date(code.expires_at) < new Date()).length;

  function updateField<K extends keyof WholesaleCodeFormInput>(field: K, value: WholesaleCodeFormInput[K]) {
    setEditing((current) => (current ? { ...current, [field]: value } : current));
  }

  function submitCode() {
    if (!editing) {
      return;
    }

    startTransition(async () => {
      const result = await saveWholesaleCodeAction(editing);
      setMessage(result.message);
      if (result.ok) {
        setEditing(null);
      }
    });
  }

  function toggleActive(code: WholesaleCodeAdminRow) {
    startTransition(async () => {
      const result = await setWholesaleCodeActiveAction(code.id, !code.active);
      setMessage(result.message);
    });
  }

  function exportCsv() {
    const headers = ["code", "cliente", "estado", "expires_at", "used_count", "minimum_order", "max_uses", "active"];
    const rows = filteredCodes.map((code) => [
      code.code,
      code.business_name ?? code.customer_name ?? "",
      code.status,
      code.expires_at ?? "",
      code.used_count,
      code.minimum_order,
      code.max_uses ?? "",
      code.active,
    ]);
    const csv = [headers.join(","), ...rows.map((row) => row.map(csvValue).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "car-zone-codigos-mayoristas.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-3">
        <Metric label="Codigos activos" value={activeCount.toLocaleString("es-HN")} />
        <Metric label="Usos registrados" value={totalUses.toLocaleString("es-HN")} />
        <Metric label="Vencidos por fecha" value={expiredCount.toLocaleString("es-HN")} />
      </div>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
          <label className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2">
            <Search size={18} className="text-black/45" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por codigo o cliente"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
          <Button onClick={() => setEditing(emptyCode)} variant="dark">
            <KeyRound size={17} />
            Nuevo codigo
          </Button>
          <Button onClick={exportCsv} variant="ghost">
            <Download size={17} />
            CSV
          </Button>
        </div>
        {message ? <p className="mt-3 text-sm text-black/60">{message}</p> : null}
      </section>

      <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="bg-[#f0ede2] text-xs uppercase text-black/55">
              <tr>
                <th className="px-4 py-3">Codigo</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Expira</th>
                <th className="px-4 py-3">Usos</th>
                <th className="px-4 py-3">Minimo</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {filteredCodes.map((code) => (
                <tr key={code.id}>
                  <td className="px-4 py-3">
                    <p className="font-semibold">{code.code}</p>
                    <p className="text-xs text-black/50">{code.label}</p>
                  </td>
                  <td className="px-4 py-3">{code.business_name ?? code.customer_name ?? "Sin cliente"}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-md bg-[#e8f3f2] px-2 py-1 text-xs">{statusLabels[code.status]}</span>
                  </td>
                  <td className="px-4 py-3">{code.expires_at ? new Date(code.expires_at).toLocaleDateString("es-HN") : "Sin fecha"}</td>
                  <td className="px-4 py-3">
                    {code.used_count}
                    {code.max_uses ? <span className="text-black/45"> / {code.max_uses}</span> : null}
                  </td>
                  <td className="px-4 py-3">{formatCurrency(code.minimum_order)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <IconButton label="Editar" onClick={() => setEditing(toForm(code))}>
                        <Pencil size={16} />
                      </IconButton>
                      <IconButton label={code.active ? "Desactivar" : "Activar"} onClick={() => toggleActive(code)}>
                        {code.active ? <X size={16} /> : <CheckCircle2 size={16} />}
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editing ? (
        <CodeEditor
          code={editing}
          customers={customers}
          pending={isPending}
          onClose={() => setEditing(null)}
          onField={updateField}
          onSubmit={submitCode}
        />
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-9 place-items-center rounded-md border border-black/10 bg-white transition-colors hover:bg-[#f7f7f2]"
    >
      {children}
    </button>
  );
}

function CodeEditor({
  code,
  customers,
  pending,
  onClose,
  onField,
  onSubmit,
}: {
  code: WholesaleCodeFormInput;
  customers: WholesaleCustomerOption[];
  pending: boolean;
  onClose: () => void;
  onField: <K extends keyof WholesaleCodeFormInput>(field: K, value: WholesaleCodeFormInput[K]) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/45 p-4">
      <section className="mx-auto my-8 w-full max-w-3xl rounded-lg bg-white text-[#1c1d1b]">
        <div className="flex items-center justify-between border-b border-black/10 px-5 py-4">
          <div>
            <p className="text-sm text-black/50">{code.id ? "Editar codigo" : "Crear codigo"}</p>
            <h2 className="text-xl font-semibold">{code.code || "Nuevo codigo mayorista"}</h2>
          </div>
          <button onClick={onClose} className="grid size-10 place-items-center rounded-md border border-black/10" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Cliente mayorista">
            <select
              value={code.customer_id ?? ""}
              onChange={(event) => onField("customer_id", event.target.value || null)}
              className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
            >
              <option value="">Sin cliente asignado</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.business_name ?? customer.contact_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Codigo unico">
            <Input value={code.code} onChange={(event) => onField("code", event.target.value.toUpperCase())} placeholder="MAYOREO-LOPEZ2026" />
          </Field>
          <Field label="Etiqueta">
            <Input value={code.label} onChange={(event) => onField("label", event.target.value)} />
          </Field>
          <Field label="Estado">
            <select
              value={code.status}
              onChange={(event) => onField("status", event.target.value as WholesaleCodeStatus)}
              className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
            >
              {Object.entries(statusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Fecha de inicio">
            <Input type="date" value={code.starts_at ?? ""} onChange={(event) => onField("starts_at", event.target.value || null)} />
          </Field>
          <Field label="Fecha de expiracion">
            <Input type="date" value={code.expires_at ?? ""} onChange={(event) => onField("expires_at", event.target.value || null)} />
          </Field>
          <Field label="Pedido minimo">
            <Input type="number" min={0} value={code.minimum_order} onChange={(event) => onField("minimum_order", numberValue(event.target.value))} />
          </Field>
          <Field label="Maximo de usos">
            <Input
              type="number"
              min={0}
              value={code.max_uses ?? ""}
              onChange={(event) => onField("max_uses", event.target.value ? numberValue(event.target.value) : null)}
            />
          </Field>
          <Field label="Cantidad de usos">
            <Input type="number" min={0} value={code.used_count} onChange={(event) => onField("used_count", numberValue(event.target.value))} />
          </Field>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={code.active}
              onChange={(event) => onField("active", event.target.checked)}
              className="size-4"
            />
            Codigo activo
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-black/10 px-5 py-4">
          <Button onClick={onClose} variant="ghost">
            Cancelar
          </Button>
          <Button onClick={onSubmit} disabled={pending} variant="dark">
            <Save size={17} />
            {pending ? "Guardando..." : "Guardar codigo"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase text-black/50">{label}</span>
      {children}
    </label>
  );
}
