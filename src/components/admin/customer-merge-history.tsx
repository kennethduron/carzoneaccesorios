import { ArrowRightLeft, FileClock, LockKeyhole, ShieldCheck } from "lucide-react";
import type { CustomerMergeHistoryDetails, CustomerMergeHistoryItem, CustomerMergeHistoryMetric } from "@/types/customer-merge";
import { formatCurrency } from "@/utils/pricing";

type Props = { details: CustomerMergeHistoryDetails };

const metricLabels: Record<string, string> = {
  orders: "Pedidos",
  invoices: "Facturas",
  payments: "Pagos",
  receivables: "CxC",
  receivablePayments: "Abonos",
  accountingEntries: "Partidas",
  reservations: "Reservas",
  inventoryMovements: "Movimientos",
  crmNotes: "Notas CRM",
  crmFollowups: "Seguimientos",
  checkoutRequests: "Solicitudes Checkout",
};

const emptyMessages: Record<string, string> = {
  orders: "No existen pedidos asociados a estos registros.",
  invoices: "No existen facturas asociadas a estos registros.",
  payments: "No existen pagos asociados a estos registros.",
  receivables: "No existen CxC asociadas a estos registros.",
  receivablePayments: "No existen abonos asociados.",
  accountingEntries: "No existen partidas contables relacionadas.",
  reservations: "No existen reservas de inventario relacionadas.",
  inventoryMovements: "No existen movimientos de inventario relacionados.",
  crmNotes: "No existen notas CRM para trasladar.",
  crmFollowups: "No existen seguimientos para trasladar.",
  checkoutRequests: "No existen solicitudes Checkout relacionadas.",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-HN", { dateStyle: "medium", timeZone: "America/Tegucigalpa" }).format(new Date(value));
}

function amount(value: unknown) {
  return typeof value === "number" ? formatCurrency(value) : null;
}

function DetailItem({ item }: { item: CustomerMergeHistoryItem }) {
  const subtotal = amount(item.details.subtotal);
  const tax = amount(item.details.tax);
  const debit = amount(item.details.debit);
  const credit = amount(item.details.credit);
  const quantity = typeof item.details.quantity === "number" ? Number(item.details.quantity).toLocaleString("es-HN") : null;
  const method = typeof item.details.method === "string" ? item.details.method.replaceAll("_", " ") : null;
  const modality = typeof item.details.modalityLabel === "string" ? item.details.modalityLabel : null;

  return (
    <article className="min-w-0 rounded-lg border border-black/10 bg-white p-4 shadow-sm">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-black/45">{item.title}</p>
          <h4 className="mt-1 break-words font-semibold [overflow-wrap:anywhere]">{item.reference}</h4>
        </div>
        {item.amount !== null ? <p className="shrink-0 text-lg font-semibold">{formatCurrency(item.amount)}</p> : null}
      </div>
      <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-black/45">Estado</dt><dd className="font-medium">{item.statusLabel}</dd></div>
        <div><dt className="text-xs text-black/45">Fecha</dt><dd>{formatDate(item.date)}</dd></div>
        <div><dt className="text-xs text-black/45">Origen</dt><dd>{item.sourceCustomerLabel}</dd></div>
        {modality ? <div><dt className="text-xs text-black/45">Modalidad</dt><dd>{modality}</dd></div> : null}
        {method ? <div><dt className="text-xs text-black/45">Método</dt><dd className="capitalize">{method}</dd></div> : null}
        {quantity ? <div><dt className="text-xs text-black/45">Cantidad</dt><dd>{quantity}</dd></div> : null}
        {subtotal ? <div><dt className="text-xs text-black/45">Base</dt><dd>{subtotal}</dd></div> : null}
        {tax ? <div><dt className="text-xs text-black/45">ISV</dt><dd>{tax}</dd></div> : null}
        {debit ? <div><dt className="text-xs text-black/45">Débitos</dt><dd>{debit}</dd></div> : null}
        {credit ? <div><dt className="text-xs text-black/45">Créditos</dt><dd>{credit}</dd></div> : null}
      </dl>
      <p className={`mt-3 rounded-md px-3 py-2 text-sm font-medium ${item.protected ? "bg-[#f0fdf4] text-[#166534]" : "bg-[#eff6ff] text-[#1d4ed8]"}`}>
        Acción: {item.actionLabel}
      </p>
    </article>
  );
}

function Section({ title, description, items, tone }: { title: string; description: string; items: CustomerMergeHistoryItem[]; tone: "move" | "history" | "protected" }) {
  const Icon = tone === "move" ? ArrowRightLeft : tone === "history" ? FileClock : LockKeyhole;
  const color = tone === "move" ? "text-[#1d4ed8]" : tone === "history" ? "text-[#92400e]" : "text-[#166534]";
  return (
    <section className="rounded-xl border border-black/10 bg-[#fafaf9] p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 shrink-0 ${color}`} size={20} />
        <div><h3 className="font-semibold">{title}</h3><p className="mt-1 text-sm text-black/55">{description}</p></div>
      </div>
      {items.length > 0 ? <div className="mt-4 grid gap-3 lg:grid-cols-2">{items.map((item) => <DetailItem key={`${item.category}-${item.id}`} item={item} />)}</div> : <p className="mt-4 rounded-md bg-white px-3 py-2 text-sm text-black/55">No hay registros en esta sección.</p>}
    </section>
  );
}

function metricValue(metric: CustomerMergeHistoryMetric) {
  if (typeof metric.total === "number") return formatCurrency(metric.total);
  if (typeof metric.openBalance === "number") return `Saldo ${formatCurrency(metric.openBalance)}`;
  if (typeof metric.debit === "number" && typeof metric.credit === "number") return `${formatCurrency(metric.debit)} / ${formatCurrency(metric.credit)}`;
  if (typeof metric.quantity === "number") return `Cantidad ${metric.quantity.toLocaleString("es-HN")}`;
  return null;
}

export function CustomerMergeHistory({ details }: Props) {
  const moving = details.items.filter((item) => item.action === "move_to_primary");
  const historical = details.items.filter((item) => item.action === "remain_historical" || item.action === "resolve_through_alias");
  const protectedItems = details.items.filter((item) => item.action === "preserve_immutable" || item.action === "no_change");
  const availableMetrics = Object.entries(details.summary).filter(([, metric]) => metric.state === "available" && metric.count > 0);
  const emptyStates = Object.entries(details.summary).filter(([, metric]) => metric.state === "empty");

  return (
    <div className="space-y-5" data-testid="customer-merge-history">
      <Section title="Se trasladará al cliente principal" description="Relaciones operativas que cambiarán de propietario sin recrearse." items={moving} tone="move" />
      <Section title="Conservará su referencia histórica" description="Documentos que aparecerán desde el perfil principal mediante el historial consolidado." items={historical} tone="history" />
      <Section title="Permanecerá histórico e inmutable" description="Evidencia fiscal, financiera, contable y de inventario que no será reescrita." items={protectedItems} tone="protected" />

      <section className="rounded-xl border border-[#22c55e]/30 bg-[#f0fdf4] p-4 sm:p-5">
        <h3 className="flex items-center gap-2 font-semibold text-[#166534]"><ShieldCheck size={20} /> Resumen de integridad</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {availableMetrics.map(([key, metric]) => (
            <div key={key} className="rounded-lg bg-white p-3 ring-1 ring-[#22c55e]/20">
              <p className="text-xs text-black/50">{metricLabels[key] ?? key}</p>
              <p className="mt-1 text-xl font-semibold">{metric.count.toLocaleString("es-HN")}</p>
              {metricValue(metric) ? <p className="mt-1 text-xs text-black/55">{metricValue(metric)}</p> : null}
            </div>
          ))}
        </div>
        {emptyStates.length > 0 ? <div className="mt-4 grid gap-1 text-sm text-[#166534]">{emptyStates.map(([key]) => <p key={key}>• {emptyMessages[key] ?? `No existen registros de ${metricLabels[key] ?? key}.`}</p>)}</div> : null}
      </section>
    </div>
  );
}
