"use client";

import { useMemo, useState, useTransition } from "react";
import { Ban, CheckCircle2, RotateCcw, Search, ShieldAlert, X } from "lucide-react";
import {
  approveWholesaleRequestAction,
  changeWholesaleCustomerTypeAction,
  reactivateWholesaleAccessAction,
  rejectWholesaleRequestAction,
  suspendWholesaleAccessAction,
} from "@/app/admin/crm/actions";
import { ActiveFilterBanner } from "@/components/admin/active-filter-banner";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { CrmCustomerOption, CrmWholesaleStatus } from "@/types/crm";
import type { WholesaleCustomerType } from "@/types/wholesale";
import { formatHnDateTime } from "@/utils/format";

type WholesaleCustomersManagerProps = {
  customers: CrmCustomerOption[];
  activeFilter?: { id: Filter; label: string } | null;
  canManageWholesale: boolean;
};

type Filter = "all" | CrmWholesaleStatus;

const statusLabels: Record<CrmWholesaleStatus, string> = {
  none: "Sin solicitud",
  pending: "Pendiente",
  approved: "Aprobado",
  rejected: "Rechazado",
  suspended: "Suspendido",
};

const filters: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Todos" },
  { id: "pending", label: "Pendientes" },
  { id: "approved", label: "Aprobados" },
  { id: "rejected", label: "Rechazados" },
  { id: "suspended", label: "Suspendidos" },
];

const sourceLabels: Record<NonNullable<CrmCustomerOption["wholesale_request_source"]>, string> = {
  formulario_publico: "Formulario público",
  cuenta_registrada: "Cuenta registrada",
  admin: "Admin",
};

function customerName(customer: CrmCustomerOption) {
  return customer.business_name || customer.company_name || customer.contact_name;
}

export function WholesaleCustomersManager({ customers, activeFilter = null, canManageWholesale }: WholesaleCustomersManagerProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(activeFilter?.id ?? "all");
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  const wholesaleCustomers = useMemo(
    () =>
      customers.filter((customer) =>
        ["pending", "approved", "rejected", "suspended"].includes(customer.wholesale_status),
      ),
    [customers],
  );

  const counts = useMemo(() => {
    const next: Record<CrmWholesaleStatus, number> = {
      none: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      suspended: 0,
    };

    for (const customer of customers) {
      next[customer.wholesale_status] += 1;
    }

    return next;
  }, [customers]);

  const filteredCustomers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return wholesaleCustomers.filter((customer) => {
      const matchesFilter = filter === "all" || customer.wholesale_status === filter;
      const haystack = `${customerName(customer)} ${customer.email ?? ""} ${customer.phone ?? ""}`.toLowerCase();
      return matchesFilter && (!normalizedQuery || haystack.includes(normalizedQuery));
    });
  }, [filter, query, wholesaleCustomers]);

  function runAction(action: () => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => {
      const result = await action();
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function approve(customerId: string, wholesaleCustomerType: WholesaleCustomerType) {
    runAction(() => approveWholesaleRequestAction(customerId, wholesaleCustomerType));
  }

  async function changeType(customer: CrmCustomerOption) {
    const confirmed = await toast.confirm({
      title: "Cambiar tipo mayorista",
      message: "Cambiar el tipo mayorista puede afectar la regla de primera compra mínima. ¿Deseas continuar?",
      confirmLabel: "Cambiar tipo",
      cancelLabel: "Cancelar",
      tone: "neutral",
    });

    if (confirmed) {
      runAction(() =>
        changeWholesaleCustomerTypeAction(
          customer.id,
          customer.wholesale_customer_type === "existing" ? "new" : "existing",
        ),
      );
    }
  }

  return (
    <div className="space-y-5">
      {activeFilter ? <ActiveFilterBanner label={activeFilter.label} clearHref="/admin/clientes-mayoristas" /> : null}

      <section className="grid gap-3 md:grid-cols-4">
        {(["pending", "approved", "rejected", "suspended"] as const).map((status) => (
          <article key={status} className="rounded-lg border border-black/10 bg-white p-4">
            <p className="text-sm text-black/50">{statusLabels[status]}</p>
            <p className="mt-2 text-2xl font-semibold">{counts[status].toLocaleString("es-HN")}</p>
          </article>
        ))}
      </section>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-black/10 px-3 py-2">
            <Search size={17} className="text-black/45" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar cliente mayorista"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} aria-label="Limpiar búsqueda">
                <X size={16} />
              </button>
            ) : null}
          </label>
          <div className="flex flex-wrap gap-2">
            {filters.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={`rounded-md px-3 py-2 text-sm font-semibold ${
                  filter === item.id ? "bg-[#080808] text-white" : "border border-black/10 bg-white"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        {message ? <p className="mt-3 rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">{message}</p> : null}
        {!canManageWholesale ? (
          <p className="mt-3 rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">
            Puedes consultar clientes mayoristas. Los cambios de estado requieren autorización adicional.
          </p>
        ) : null}
      </section>

      <section className="rounded-lg border border-black/10 bg-white">
        <div className="border-b border-black/10 p-4">
          <h2 className="font-semibold">Clientes Mayoristas</h2>
          <p className="mt-1 text-sm text-black/55">El estado de la cuenta es la única credencial mayorista.</p>
        </div>
        <div className="divide-y divide-black/10">
          {filteredCustomers.length === 0 ? (
            <p className="p-5 text-sm text-black/55">No hay clientes en este filtro.</p>
          ) : (
            filteredCustomers.map((customer) => (
              <article key={customer.id} className="grid gap-4 p-4 xl:grid-cols-[1.2fr_0.7fr_1fr_auto] xl:items-center">
                <div>
                  <p className="font-semibold">{customerName(customer)}</p>
                  <p className="text-sm text-black/55">{customer.email ?? "Sin correo"} / {customer.phone}</p>
                  <p className="mt-1 text-xs text-black/45">
                    Solicitud: {formatHnDateTime(customer.wholesale_requested_at ?? customer.created_at)} / Origen:{" "}
                    {customer.wholesale_request_source ? sourceLabels[customer.wholesale_request_source] : "Admin"}
                  </p>
                  <p className="mt-1 text-xs text-black/45">Actualizado: {formatHnDateTime(customer.updated_at)}</p>
                </div>
                <span className="w-fit rounded-md bg-[#fff1f2] px-2 py-1 text-xs font-semibold text-[#b91c25]">
                  {statusLabels[customer.wholesale_status]}
                </span>
                <p className="text-sm text-black/60">
                  {customer.wholesale_status === "approved"
                    ? customer.wholesale_customer_type === "existing"
                      ? "Mayorista existente: sin primera compra mínima."
                      : customer.wholesale_first_purchase_completed
                        ? "Mayorista nuevo: primera compra completada."
                        : "Mayorista nuevo: primera compra mínima de L 10,000 pendiente."
                    : customer.wholesale_status === "pending"
                      ? "Solicitud pendiente de revisión administrativa."
                      : customer.wholesale_status === "suspended"
                        ? "Acceso mayorista suspendido; conserva compra al detalle."
                        : "Sin acceso mayorista activo."}
                </p>
                {canManageWholesale ? <div className="flex flex-wrap gap-2 xl:justify-end">
                  {customer.wholesale_status === "pending" || customer.wholesale_status === "rejected" ? (
                    <>
                      <Button onClick={() => approve(customer.id, "new")} disabled={isPending} variant="dark">
                        <CheckCircle2 size={16} />
                        Aprobar como nuevo
                      </Button>
                      <Button onClick={() => approve(customer.id, "existing")} disabled={isPending} variant="secondary">
                        Aprobar como existente
                      </Button>
                    </>
                  ) : null}
                  {customer.wholesale_status === "pending" ? (
                    <Button onClick={() => runAction(() => rejectWholesaleRequestAction(customer.id))} disabled={isPending} variant="ghost">
                      <ShieldAlert size={16} />
                      Rechazar
                    </Button>
                  ) : null}
                  {customer.wholesale_status === "approved" ? (
                    <>
                      <Button
                        onClick={() => changeType(customer)}
                        disabled={isPending}
                        variant="secondary"
                      >
                        Cambiar a {customer.wholesale_customer_type === "existing" ? "nuevo" : "existente"}
                      </Button>
                      <Button onClick={() => runAction(() => suspendWholesaleAccessAction(customer.id))} disabled={isPending} variant="ghost">
                        <Ban size={16} />
                        Suspender
                      </Button>
                    </>
                  ) : null}
                  {customer.wholesale_status === "suspended" ? (
                    <Button onClick={() => runAction(() => reactivateWholesaleAccessAction(customer.id))} disabled={isPending} variant="dark">
                      <RotateCcw size={16} />
                      Reactivar
                    </Button>
                  ) : null}
                </div> : null}
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
