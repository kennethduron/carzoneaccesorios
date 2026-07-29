"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { WholesaleGrantDialog } from "@/components/admin/wholesale-grant-dialog";
import type { CrmCustomerOption, CrmCustomerProfile } from "@/types/crm";
import type { WholesaleCustomerType } from "@/types/wholesale";
import { formatHnDateTime } from "@/utils/format";
import { formatCurrency } from "@/utils/pricing";

export function CustomerProfileWholesale({
  profile,
  pending,
  canManageWholesale,
  firstWholesaleMinimum,
  onApproveWholesale,
  onGrantWholesale,
  onChangeWholesaleType,
  onRejectWholesale,
  onSuspendWholesale,
  onReactivateWholesale,
}: {
  profile: CrmCustomerProfile;
  pending: boolean;
  canManageWholesale: boolean;
  firstWholesaleMinimum: number;
  onApproveWholesale: (customer: CrmCustomerOption, type: WholesaleCustomerType) => void;
  onGrantWholesale: (customer: CrmCustomerOption, type: WholesaleCustomerType, reason: string) => void;
  onChangeWholesaleType: (customer: CrmCustomerOption, type: WholesaleCustomerType) => void;
  onRejectWholesale: (customer: CrmCustomerOption) => void;
  onSuspendWholesale: (customer: CrmCustomerOption) => void;
  onReactivateWholesale: (customer: CrmCustomerOption) => void;
}) {
  const { customer, wholesaleHistory } = profile;
  const [grantType, setGrantType] = useState<WholesaleCustomerType | null>(null);
  const isExisting = customer.wholesale_customer_type === "existing";
  const hasPendingRequest = customer.wholesale_status === "pending";
  const canDirectGrant = customer.wholesale_status === "none" || customer.wholesale_status === "rejected";

  return (
    <section className="rounded-lg border border-black/10 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Información mayorista</h3>
          <p className="mt-1 text-sm text-black/55">
            {customer.wholesale_status === "approved" ? "Aprobación comercial mayorista activa." : hasPendingRequest ? "Solicitud mayorista pendiente." : "Cliente sin acceso mayorista activo."}
          </p>
        </div>
        <span className="rounded-md bg-[#f4f4f5] px-2 py-1 text-xs font-semibold">{customer.wholesale_lifecycle_status}</span>
      </div>

      {customer.wholesale_status === "approved" && !customer.user_id ? (
        <div className="mt-4 rounded-md border border-[#f59e0b]/25 bg-[#fff7ed] p-4 text-sm text-[#7c2d12]">
          <p className="font-semibold">Mayoreo aprobado — cuenta del portal todavía no vinculada</p>
          <p className="mt-1">La aprobación comercial está activa, pero el cliente deberá vincular su cuenta para consultar sus beneficios desde el portal.</p>
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Summary label="Estado" value={customer.wholesale_status} />
        <Summary label="Tipo" value={isExisting ? "Mayorista existente" : "Mayorista nuevo"} />
        <Summary label="Primera compra" value={isExisting ? "No requerida" : customer.wholesale_first_purchase_completed ? "Completada" : `Pendiente: ${formatCurrency(firstWholesaleMinimum)}`} />
        <Summary label="Portal" value={customer.user_id ? "Cuenta vinculada" : "Sin vincular"} />
      </div>

      {canManageWholesale ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {hasPendingRequest ? <>
            <Button type="button" variant="dark" disabled={pending} onClick={() => onApproveWholesale(customer, "new")}>Aprobar como mayorista nuevo</Button>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => onApproveWholesale(customer, "existing")}>Aprobar como mayorista existente</Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onRejectWholesale(customer)}>Rechazar</Button>
          </> : null}
          {canDirectGrant ? <>
            <Button type="button" variant="dark" disabled={pending} onClick={() => setGrantType("new")}>Otorgar como mayorista nuevo</Button>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => setGrantType("existing")}>Otorgar como mayorista existente</Button>
          </> : null}
          {customer.wholesale_status === "approved" ? <Button type="button" variant="ghost" disabled={pending} onClick={() => onSuspendWholesale(customer)}>Suspender mayorista</Button> : null}
          {customer.wholesale_status === "suspended" ? <Button type="button" variant="dark" disabled={pending} onClick={() => onReactivateWholesale(customer)}>Reactivar mayorista</Button> : null}
          {customer.wholesale_status === "approved" || customer.wholesale_status === "suspended" ? (
            <Button type="button" variant="secondary" disabled={pending} onClick={() => onChangeWholesaleType(customer, isExisting ? "new" : "existing")}>
              Cambiar a mayorista {isExisting ? "nuevo" : "existente"}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">Puedes consultar el estado; las acciones requieren el permiso wholesale:manage.</p>
      )}

      <div className="mt-5 space-y-2">
        <h4 className="text-sm font-semibold">Historial mayorista</h4>
        {wholesaleHistory.length === 0 ? <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/55">Sin transiciones mayoristas registradas.</p> : wholesaleHistory.map((item) => (
          <article key={item.id} className="rounded-md border border-black/10 p-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <div>
                <p className="font-semibold">{item.note}</p>
                <p className="mt-1 text-xs text-black/50">{item.user_name ?? "Usuario autorizado"} · {item.source === "admin_direct_grant" ? "Gestión administrativa" : "Solicitud del cliente"}</p>
                {item.reason ? <p className="mt-2 text-black/60">Motivo: {item.reason}</p> : null}
              </div>
              <time className="text-xs text-black/50">{formatHnDateTime(item.created_at)}</time>
            </div>
          </article>
        ))}
      </div>

      {grantType ? <WholesaleGrantDialog customer={customer} type={grantType} firstWholesaleMinimum={firstWholesaleMinimum} pending={pending} onCancel={() => setGrantType(null)} onConfirm={(reason) => {
        onGrantWholesale(customer, grantType, reason);
        setGrantType(null);
      }} /> : null}
    </section>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-[#f4f4f5] p-3"><p className="text-xs uppercase text-black/45">{label}</p><p className="mt-1 font-medium">{value}</p></div>;
}
