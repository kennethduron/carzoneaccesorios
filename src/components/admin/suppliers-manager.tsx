"use client";

import type { ReactNode } from "react";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Edit3, PlusCircle, Power, Search, X } from "lucide-react";
import { saveSupplierAction, setSupplierActiveAction, type SupplierFormInput } from "@/app/admin/proveedores/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { Supplier, SupplierSummary } from "@/types/purchases";

type SupplierDraft = SupplierFormInput & {
  is_active: boolean;
};

const emptyDraft: SupplierDraft = {
  name: "",
  contact_name: "",
  phone: "",
  email: "",
  tax_id: "",
  address: "",
  notes: "",
  is_active: true,
};

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-HN", { dateStyle: "medium" }).format(new Date(value));
}

export function SuppliersManager({ suppliers, summary, canManage }: { suppliers: Supplier[]; summary: SupplierSummary; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"active" | "inactive" | "all">("active");
  const [draft, setDraft] = useState<SupplierDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const visibleSuppliers = useMemo(() => {
    const needle = normalize(query.trim());
    return suppliers.filter((supplier) => {
      if (filter === "active" && !supplier.is_active) return false;
      if (filter === "inactive" && supplier.is_active) return false;
      if (!needle) return true;
      return normalize([supplier.name, supplier.contact_name, supplier.phone, supplier.email, supplier.tax_id].filter(Boolean).join(" ")).includes(needle);
    });
  }, [filter, query, suppliers]);

  function editSupplier(supplier: Supplier) {
    setEditingId(supplier.id);
    setDraft({
      id: supplier.id,
      name: supplier.name,
      contact_name: supplier.contact_name ?? "",
      phone: supplier.phone ?? "",
      email: supplier.email ?? "",
      tax_id: supplier.tax_id ?? "",
      address: supplier.address ?? "",
      notes: supplier.notes ?? "",
      is_active: supplier.is_active,
    });
  }

  function resetForm() {
    setEditingId(null);
    setDraft(emptyDraft);
  }

  function saveSupplier() {
    if (!canManage) return;
    startTransition(async () => {
      const result = await saveSupplierAction(draft).catch(() => ({ ok: false as const, message: "No se pudo guardar el proveedor." }));
      if (result.ok) {
        toast.success(result.message);
        resetForm();
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  function setActive(supplier: Supplier, isActive: boolean) {
    if (!canManage) return;
    startTransition(async () => {
      const result = await setSupplierActiveAction(supplier.id, isActive).catch(() => ({ ok: false as const, message: "No se pudo cambiar el estado." }));
      if (result.ok) {
        toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <div className="min-w-0 space-y-5">
      <section className="grid gap-3 sm:grid-cols-3">
        <Metric label="Proveedores" value={summary.total.toLocaleString("es-HN")} />
        <Metric label="Activos" value={summary.active.toLocaleString("es-HN")} />
        <Metric label="Inactivos" value={summary.inactive.toLocaleString("es-HN")} />
      </section>

      <section className="min-w-0 rounded-lg border border-black/10 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Proveedores</h2>
            <p className="text-sm text-black/55">Gestion operativa de proveedores y contactos.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["active", "inactive", "all"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setFilter(option)}
                className={`rounded-md border px-3 py-2 text-sm font-semibold ${filter === option ? "border-[#e4252c] bg-[#fff1f2] text-[#b91c25]" : "border-black/10 bg-white"}`}
              >
                {option === "active" ? "Activos" : option === "inactive" ? "Inactivos" : "Todos"}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <label className="flex min-w-0 items-center gap-2 rounded-md border border-black/10 px-3 py-2 focus-within:border-[#e4252c] focus-within:ring-2 focus-within:ring-[#e4252c]/15">
            <Search size={18} className="shrink-0 text-black/45" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nombre, contacto, telefono, correo o RTN" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
          </label>
          {query ? <Button type="button" variant="ghost" onClick={() => setQuery("")}><X size={16} />Limpiar busqueda</Button> : null}
        </div>

        <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 max-w-full overflow-x-auto rounded-md border border-black/10">
            <table className="w-full min-w-[760px] text-left text-sm [&_td]:break-words [&_td]:[overflow-wrap:anywhere]">
              <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
                <tr>
                  <th className="px-3 py-2">Proveedor</th>
                  <th className="px-3 py-2">Contacto</th>
                  <th className="px-3 py-2">RTN</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">Actualizado</th>
                  <th className="px-3 py-2">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {visibleSuppliers.map((supplier) => (
                  <tr key={supplier.id}>
                    <td className="px-3 py-3 align-top"><p className="font-semibold [overflow-wrap:anywhere]">{supplier.name}</p><p className="text-xs text-black/50">{supplier.email ?? supplier.phone ?? "Sin contacto"}</p></td>
                    <td className="px-3 py-3 align-top">{supplier.contact_name ?? "Sin contacto"}</td>
                    <td className="px-3 py-3 align-top">{supplier.tax_id ?? "Sin RTN"}</td>
                    <td className="px-3 py-3 align-top"><span className={`rounded-md px-2 py-1 text-xs font-semibold ${supplier.is_active ? "bg-[#edf7ed] text-[#2f6f3e]" : "bg-[#f4f4f5] text-black/55"}`}>{supplier.is_active ? "Activo" : "Inactivo"}</span></td>
                    <td className="px-3 py-3 align-top">{formatDate(supplier.updated_at)}</td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="ghost" onClick={() => editSupplier(supplier)} disabled={!canManage || isPending}><Edit3 size={16} />Editar</Button>
                        <Button type="button" variant="ghost" onClick={() => setActive(supplier, !supplier.is_active)} disabled={!canManage || isPending}><Power size={16} />{supplier.is_active ? "Desactivar" : "Activar"}</Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {visibleSuppliers.length === 0 ? <tr><td colSpan={6} className="px-3 py-6 text-center text-black/55">No hay proveedores para este filtro.</td></tr> : null}
              </tbody>
            </table>
          </div>

          <div className="min-w-0 rounded-lg border border-black/10 bg-[#fafafa] p-4 [&_select]:min-w-0 [&_select]:w-full [&_textarea]:min-w-0 [&_textarea]:w-full">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{editingId ? "Editar proveedor" : "Registrar proveedor"}</h3>
                <p className="text-sm text-black/55">Los datos quedan en el modulo operativo.</p>
              </div>
              {editingId ? <Button type="button" variant="ghost" onClick={resetForm}>Cancelar</Button> : null}
            </div>
            <div className="mt-4 grid gap-3">
              <Field label="Nombre"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} disabled={!canManage || isPending} /></Field>
              <Field label="Contacto"><Input value={draft.contact_name ?? ""} onChange={(event) => setDraft({ ...draft, contact_name: event.target.value })} disabled={!canManage || isPending} /></Field>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                <Field label="Telefono"><Input value={draft.phone ?? ""} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} disabled={!canManage || isPending} /></Field>
                <Field label="Correo"><Input type="email" value={draft.email ?? ""} onChange={(event) => setDraft({ ...draft, email: event.target.value })} disabled={!canManage || isPending} /></Field>
              </div>
              <Field label="RTN"><Input value={draft.tax_id ?? ""} onChange={(event) => setDraft({ ...draft, tax_id: event.target.value })} disabled={!canManage || isPending} /></Field>
              <Field label="Direccion"><textarea value={draft.address ?? ""} onChange={(event) => setDraft({ ...draft, address: event.target.value })} rows={2} className="rounded-md border border-black/10 px-3 py-2 text-sm" disabled={!canManage || isPending} /></Field>
              <Field label="Notas"><textarea value={draft.notes ?? ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} rows={3} className="rounded-md border border-black/10 px-3 py-2 text-sm" disabled={!canManage || isPending} /></Field>
              <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={draft.is_active} onChange={(event) => setDraft({ ...draft, is_active: event.target.checked })} disabled={!canManage || isPending} /> Activo</label>
              <Button type="button" onClick={saveSupplier} disabled={!canManage || isPending}><PlusCircle size={16} />{isPending ? "Guardando..." : "Guardar"}</Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-black/10 bg-white p-4"><p className="text-sm text-black/50">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1 text-sm font-semibold">{label}{children}</label>;
}




