"use client";

import { useMemo, useState, useTransition } from "react";
import { CheckCircle2, Download, KeyRound, Pencil, Save, Search, UserPlus, X } from "lucide-react";
import {
  createWholesaleCustomerAction,
  saveWholesaleCodeAction,
  setWholesaleCodeActiveAction,
} from "@/app/admin/codigos-mayoristas/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { formatHnDate } from "@/utils/format";
import { formatCurrency } from "@/utils/pricing";
import type {
  WholesaleCodeAdminRow,
  WholesaleCodeFormInput,
  WholesaleCodeStatus,
  WholesaleCustomerFormInput,
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

const customerStatusLabels: Record<WholesaleCustomerOption["status"], string> = {
  active: "Activa",
  inactive: "Inactiva",
  disabled: "Bloqueada",
  pending_account: "Cuenta pendiente",
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

const emptyCustomer: WholesaleCustomerFormInput = {
  business_name: "",
  contact_name: "",
  email: "",
  phone: "",
  status: "active",
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

function customerDisplayName(customer: Pick<WholesaleCustomerOption, "business_name" | "contact_name">) {
  return customer.business_name || customer.contact_name;
}

function accountLabel(customer: {
  user_id: string | null;
  status: WholesaleCustomerOption["status"] | null;
  active: boolean | null;
  account_email: string | null;
  account_active: boolean | null;
}) {
  if (!customer.user_id || customer.status === "pending_account") {
    return "Cuenta mayorista pendiente de crear.";
  }

  if (customer.account_active === false || customer.active === false || customer.status !== "active") {
    return "Cuenta inactiva";
  }

  return customer.account_email ? `Cuenta activa: ${customer.account_email}` : "Cuenta activa";
}

function generatedCodeForCustomer(customer: WholesaleCustomerOption | undefined) {
  const source = customer ? customerDisplayName(customer) : "MAYOREO";
  const slug = source
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toUpperCase()
    .slice(0, 18);
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `MAYOREO-${slug || "CLIENTE"}-${suffix}`;
}

export function WholesaleCodeManager({ codes, customers }: WholesaleCodeManagerProps) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<WholesaleCodeFormInput | null>(null);
  const [creatingCustomer, setCreatingCustomer] = useState<WholesaleCustomerFormInput | null>(null);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();
  const debouncedQuery = useDebouncedValue(query, 400);

  const filteredCodes = useMemo(() => {
    const normalizedQuery = debouncedQuery.trim().toLowerCase();

    return codes.filter((code) => {
      if (!normalizedQuery) {
        return true;
      }

      return `${code.code} ${code.label} ${code.customer_name ?? ""} ${code.business_name ?? ""} ${code.customer_email ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [codes, debouncedQuery]);

  const activeCount = codes.filter((code) => code.active && code.status === "active").length;
  const totalUses = codes.reduce((sum, code) => sum + code.used_count, 0);
  const expiredCount = codes.filter((code) => code.expires_at && new Date(code.expires_at) < new Date()).length;
  const pendingAccountCount = customers.filter((customer) => !customer.user_id || customer.status === "pending_account").length;

  function updateField<K extends keyof WholesaleCodeFormInput>(field: K, value: WholesaleCodeFormInput[K]) {
    setEditing((current) => (current ? { ...current, [field]: value } : current));
  }

  function updateCustomerField<K extends keyof WholesaleCustomerFormInput>(
    field: K,
    value: WholesaleCustomerFormInput[K],
  ) {
    setCreatingCustomer((current) => (current ? { ...current, [field]: value } : current));
  }

  function submitCode() {
    if (!editing) {
      return;
    }

    startTransition(async () => {
      const result = await saveWholesaleCodeAction(editing);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Codigo mayorista actualizado.");
      } else {
        toast.error(result.message || "No se pudo guardar el codigo mayorista.");
      }
      if (result.ok) {
        setEditing(null);
      }
    });
  }

  function submitCustomer() {
    if (!creatingCustomer) {
      return;
    }

    startTransition(async () => {
      const result = await createWholesaleCustomerAction(creatingCustomer);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Cliente mayorista creado correctamente.");
      } else {
        toast.error(result.message || "No se pudo crear el cliente mayorista.");
      }
      if (result.ok) {
        setCreatingCustomer(null);
      }
    });
  }

  function toggleActive(code: WholesaleCodeAdminRow) {
    startTransition(async () => {
      const result = await setWholesaleCodeActiveAction(code.id, !code.active);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Codigo mayorista actualizado.");
      } else {
        toast.error(result.message || "No se pudo actualizar el codigo mayorista.");
      }
    });
  }

  function exportCsv() {
    const headers = ["code", "cliente", "cuenta", "estado", "expires_at", "used_count", "minimum_order", "max_uses", "active"];
    const rows = filteredCodes.map((code) => [
      code.code,
      code.business_name ?? code.customer_name ?? "",
      accountLabel({
        user_id: code.customer_user_id,
        status: code.customer_status,
        active: code.customer_active,
        account_email: code.account_email,
        account_active: code.account_active,
      }),
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
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Codigos activos" value={activeCount.toLocaleString("es-HN")} />
        <Metric label="Usos registrados" value={totalUses.toLocaleString("es-HN")} />
        <Metric label="Vencidos por fecha" value={expiredCount.toLocaleString("es-HN")} />
        <Metric label="Cuentas pendientes" value={pendingAccountCount.toLocaleString("es-HN")} />
      </div>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto_auto]">
          <label className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2">
            <Search size={18} className="text-black/45" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por codigo, cliente, correo o cuenta"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
          <Button onClick={() => setEditing(emptyCode)} variant="dark">
            <KeyRound size={17} />
            Nuevo codigo
          </Button>
          <Button onClick={() => setCreatingCustomer(emptyCustomer)} variant="primary">
            <UserPlus size={17} />
            Cliente mayorista
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
          <table className="w-full min-w-[1160px] text-left text-sm">
            <thead className="bg-[#f0ede2] text-xs uppercase text-black/55">
              <tr>
                <th className="px-4 py-3">Codigo</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Cuenta</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Expira</th>
                <th className="px-4 py-3">Usos</th>
                <th className="px-4 py-3">Minimo</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {filteredCodes.map((code) => {
                const accountText = accountLabel({
                  user_id: code.customer_user_id,
                  status: code.customer_status,
                  active: code.customer_active,
                  account_email: code.account_email,
                  account_active: code.account_active,
                });
                const accountOk = code.customer_user_id && code.customer_status === "active" && code.account_active !== false;

                return (
                  <tr key={code.id}>
                    <td className="px-4 py-3">
                      <p className="font-semibold">{code.code}</p>
                      <p className="text-xs text-black/50">{code.label}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{code.business_name ?? code.customer_name ?? "Sin cliente"}</p>
                      <p className="text-xs text-black/45">{code.customer_email ?? "Sin correo"}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-1 text-xs ${
                          accountOk ? "bg-[#e8f3f2] text-[#1e5960]" : "bg-[#fff0ea] text-[#9b341b]"
                        }`}
                      >
                        {accountText}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-md bg-[#e8f3f2] px-2 py-1 text-xs">{statusLabels[code.status]}</span>
                    </td>
                    <td className="px-4 py-3">{code.expires_at ? formatHnDate(code.expires_at) : "Sin fecha"}</td>
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
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <WholesaleCustomerList customers={customers} />

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
      {creatingCustomer ? (
        <WholesaleCustomerEditor
          customer={creatingCustomer}
          pending={isPending}
          onClose={() => setCreatingCustomer(null)}
          onField={updateCustomerField}
          onSubmit={submitCustomer}
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

function WholesaleCustomerList({ customers }: { customers: WholesaleCustomerOption[] }) {
  return (
    <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
      <div className="border-b border-black/10 p-4">
        <h2 className="font-semibold">Clientes mayoristas</h2>
        <p className="mt-1 text-sm text-black/55">Estado de cuenta y vinculacion de usuarios.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-[#f0ede2] text-xs uppercase text-black/55">
            <tr>
              <th className="px-4 py-3">Cliente</th>
              <th className="px-4 py-3">Correo</th>
              <th className="px-4 py-3">Cuenta</th>
              <th className="px-4 py-3">Estado mayorista</th>
              <th className="px-4 py-3">Telefono</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/10">
            {customers.map((customer) => (
              <tr key={customer.id}>
                <td className="px-4 py-3">
                  <p className="font-semibold">{customerDisplayName(customer)}</p>
                  <p className="text-xs text-black/45">{customer.contact_name}</p>
                </td>
                <td className="px-4 py-3">{customer.email ?? "Sin correo"}</td>
                <td className="px-4 py-3">{accountLabel(customer)}</td>
                <td className="px-4 py-3">{customerStatusLabels[customer.status]}</td>
                <td className="px-4 py-3">{customer.phone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
  const selectedCustomer = customers.find((customer) => customer.id === code.customer_id);

  function applyGeneratedCode() {
    const nextCode = generatedCodeForCustomer(selectedCustomer);
    onField("code", nextCode);
    if (!code.label.trim()) {
      onField("label", `Codigo mayorista ${selectedCustomer ? customerDisplayName(selectedCustomer) : nextCode}`);
    }
  }

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
              <option value="">Selecciona cliente</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customerDisplayName(customer)} - {accountLabel(customer)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Codigo unico">
            <div className="flex gap-2">
              <Input
                value={code.code}
                onChange={(event) => onField("code", event.target.value.toUpperCase())}
                placeholder="MAYOREO-LOPEZ2026"
              />
              <button
                type="button"
                onClick={applyGeneratedCode}
                className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-medium"
              >
                Generar
              </button>
            </div>
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

function WholesaleCustomerEditor({
  customer,
  pending,
  onClose,
  onField,
  onSubmit,
}: {
  customer: WholesaleCustomerFormInput;
  pending: boolean;
  onClose: () => void;
  onField: <K extends keyof WholesaleCustomerFormInput>(field: K, value: WholesaleCustomerFormInput[K]) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/45 p-4">
      <section className="mx-auto my-8 w-full max-w-2xl rounded-lg bg-white text-[#1c1d1b]">
        <div className="flex items-center justify-between border-b border-black/10 px-5 py-4">
          <div>
            <p className="text-sm text-black/50">Crear cliente mayorista</p>
            <h2 className="text-xl font-semibold">{customer.business_name || "Nuevo cliente mayorista"}</h2>
          </div>
          <button onClick={onClose} className="grid size-10 place-items-center rounded-md border border-black/10" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Empresa">
            <Input value={customer.business_name} onChange={(event) => onField("business_name", event.target.value)} />
          </Field>
          <Field label="Contacto">
            <Input value={customer.contact_name} onChange={(event) => onField("contact_name", event.target.value)} />
          </Field>
          <Field label="Correo de cuenta">
            <Input type="email" value={customer.email} onChange={(event) => onField("email", event.target.value)} />
          </Field>
          <Field label="Telefono">
            <Input value={customer.phone} onChange={(event) => onField("phone", event.target.value)} placeholder="Ej. 31986284" />
          </Field>
          <Field label="Estado si la cuenta existe">
            <select
              value={customer.status}
              onChange={(event) => onField("status", event.target.value as WholesaleCustomerFormInput["status"])}
              className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
            >
              {Object.entries(customerStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <p className="self-end rounded-md bg-[#f7f7f2] p-3 text-sm text-black/60">
            Si no existe una cuenta con ese correo, se guardara como: Cuenta mayorista pendiente de crear.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-black/10 px-5 py-4">
          <Button onClick={onClose} variant="ghost">
            Cancelar
          </Button>
          <Button onClick={onSubmit} disabled={pending} variant="dark">
            <Save size={17} />
            {pending ? "Guardando..." : "Guardar cliente"}
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
