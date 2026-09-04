"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleDollarSign,
  Clock3,
  LoaderCircle,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type {
  CommissionEntry,
  CommissionPage,
  SellerCommercialListItem,
} from "@/types/commissions";
import { commissionStatusLabels } from "@/types/commissions";
import { formatCurrency } from "@/utils/pricing";
function dateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
  }).format(date);
}
function monthStart() {
  const now = new Date();
  return dateKey(new Date(now.getFullYear(), now.getMonth(), 1));
}
type Detail = CommissionEntry & {
  rule?: Record<string, unknown>;
  payments?: Array<Record<string, unknown>>;
};

const filterControlClass =
  "h-11 w-full min-w-0 rounded-lg border border-black/15 bg-white px-3 text-sm font-normal text-black outline-none transition hover:border-black/30 focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15";

export function CommissionsManager() {
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(() => dateKey(new Date()));
  const [sellerId, setSellerId] = useState("");
  const [status, setStatus] = useState("");
  const [ruleType, setRuleType] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<CommissionPage | null>(null);
  const [sellers, setSellers] = useState<SellerCommercialListItem[]>([]);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  useEffect(() => {
    fetch("/api/admin/commission-sellers?limit=50", { cache: "no-store" })
      .then((r) => r.json())
      .then((p: { results?: SellerCommercialListItem[] }) =>
        setSellers(p.results ?? []),
      )
      .catch(() => setSellers([]));
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    const params = new URLSearchParams({
      from,
      to,
      sort,
      limit: "20",
      offset: String(offset),
    });
    if (sellerId) params.set("sellerId", sellerId);
    if (status) params.set("status", status);
    if (ruleType) params.set("ruleType", ruleType);
    if (query.trim()) params.set("q", query.trim());
    try {
      const response = await fetch(`/api/admin/commissions?${params}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as CommissionPage & {
        message?: string;
      };
      if (!response.ok) throw new Error(payload.message);
      setPage(payload);
      if (payload.results.length && !selected) void open(payload.results[0]);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "No se pudieron cargar las comisiones.",
      );
    } finally {
      setLoading(false);
    }
  }, [from, to, sort, offset, sellerId, status, ruleType, query, selected]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);
  async function open(entry: CommissionEntry) {
    const response = await fetch(`/api/admin/commissions/${entry.entryId}`, {
      cache: "no-store",
    });
    const payload = (await response.json()) as Detail & { message?: string };
    if (response.ok) setSelected(payload);
    else setMessage(payload.message ?? "No se pudo cargar el detalle.");
  }
  const summary = page?.summary;
  return (
    <div className="space-y-3">
      <header>
        <h2 className="text-2xl font-bold">Gestion de comisiones</h2>
        <p className="text-sm text-black/55">
          Comisiones generadas, cobros, ajustes y reversiones. Sin pagos ni
          exportaciones.
        </p>
      </header>
      <section className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Metric label="Comision potencial" value={summary?.potential ?? 0} />
        <Metric
          label="Comision ganada"
          value={summary?.earned ?? 0}
          tone="green"
        />
        <Metric
          label="Por ganar"
          value={summary?.remaining ?? 0}
          tone="amber"
        />
        <Metric
          label="Comision revertida"
          value={summary?.reversed ?? 0}
          tone="red"
        />
      </section>
      <section
        aria-label="Filtros de comisiones"
        className="grid min-w-0 items-end gap-x-3 gap-y-3 rounded-xl border bg-white p-3 shadow-sm sm:grid-cols-2 lg:grid-cols-12 2xl:grid-cols-[1.2fr_1fr_1.15fr_1fr_1fr_1.7fr_1fr]"
      >
        <FilterField label="Vendedor" className="lg:col-span-4 2xl:col-span-1">
          <select
            className={filterControlClass}
            value={sellerId}
            onChange={(event) => {
              setSellerId(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">Todos</option>
            {sellers.map((seller) => (
              <option key={seller.sellerId} value={seller.sellerId}>
                {seller.name}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Estado" className="lg:col-span-4 2xl:col-span-1">
          <select
            className={filterControlClass}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">Todos</option>
            {Object.entries(commissionStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField
          label="Tipo de regla"
          className="lg:col-span-4 2xl:col-span-1"
        >
          <select
            className={filterControlClass}
            value={ruleType}
            onChange={(event) => {
              setRuleType(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">Todos</option>
            <option value="PERCENTAGE">Porcentaje</option>
            <option value="FIXED_AMOUNT">Monto fijo</option>
          </select>
        </FilterField>
        <FilterField label="Desde" className="lg:col-span-3 2xl:col-span-1">
          <input
            className={filterControlClass}
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setOffset(0);
            }}
          />
        </FilterField>
        <FilterField label="Hasta" className="lg:col-span-3 2xl:col-span-1">
          <input
            className={filterControlClass}
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setOffset(0);
            }}
          />
        </FilterField>
        <FilterField label="Buscar" className="lg:col-span-4 2xl:col-span-1">
          <span className="relative block">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-black/40"
              size={17}
            />
            <input
              aria-label="Buscar por venta o cliente"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
              placeholder="Venta o cliente"
              className={`${filterControlClass} pl-10`}
            />
          </span>
        </FilterField>
        <FilterField label="Orden" className="lg:col-span-2 2xl:col-span-1">
          <select
            aria-label="Ordenar movimientos"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            className={filterControlClass}
          >
            <option value="newest">Mas recientes</option>
            <option value="oldest">Mas antiguos</option>
          </select>
        </FilterField>
      </section>
      {message ? (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">
          {message}
        </p>
      ) : null}
      <div className="grid min-w-0 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(320px,360px)]">
        <section className="overflow-hidden rounded-xl border bg-white shadow-sm">
          {loading ? (
            <div className="grid min-h-64 place-items-center">
              <LoaderCircle className="animate-spin" />
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto [scrollbar-color:rgba(15,23,42,.2)_transparent] [scrollbar-width:thin] md:block">
                <table className="w-full min-w-[800px] text-sm">
                  <thead className="bg-slate-50 text-left text-xs">
                    <tr>
                      {[
                        "Fecha",
                        "Vendedor",
                        "Venta",
                        "Cliente",
                        "Base elegible",
                        "Regla",
                        "Potencial",
                        "Ganada",
                        "Por ganar",
                        "Estado",
                        "",
                      ].map((head) => (
                        <th key={head} className="px-3 py-3">
                          {head}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {page?.results.map((entry) => (
                      <tr
                        key={entry.entryId}
                        className={`border-t ${selected?.entryId === entry.entryId ? "bg-red-50/50" : ""}`}
                      >
                        <td className="px-3 py-3">
                          {new Date(entry.sale.confirmedAt).toLocaleDateString(
                            "es-HN",
                          )}
                        </td>
                        <td className="px-3">{entry.sellerName}</td>
                        <td className="px-3 font-semibold">
                          {entry.sale.orderNumber}
                        </td>
                        <td className="px-3">{entry.sale.customerName}</td>
                        <td className="px-3">
                          {formatCurrency(entry.eligibleBase)}
                        </td>
                        <td className="px-3">
                          {entry.ruleType === "PERCENTAGE"
                            ? `${entry.ruleValue}%`
                            : formatCurrency(entry.ruleValue)}
                        </td>
                        <td className="px-3">
                          {formatCurrency(entry.potential)}
                        </td>
                        <td className="px-3 text-emerald-700">
                          {formatCurrency(entry.earned)}
                        </td>
                        <td className="px-3 text-amber-700">
                          {formatCurrency(entry.remaining)}
                        </td>
                        <td className="px-3">
                          <Badge entry={entry} />
                        </td>
                        <td>
                          <button
                            onClick={() => void open(entry)}
                            className="min-h-11 px-3 font-semibold text-blue-700"
                          >
                            Ver
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="divide-y md:hidden">
                {page?.results.map((entry) => (
                  <button
                    key={entry.entryId}
                    onClick={() => void open(entry)}
                    className="block w-full p-4 text-left"
                  >
                    <div className="flex justify-between">
                      <strong>{entry.sale.orderNumber}</strong>
                      <strong>{formatCurrency(entry.earned)}</strong>
                    </div>
                    <p className="text-sm">
                      {entry.sellerName} · {entry.sale.customerName}
                    </p>
                    <div className="mt-2">
                      <Badge entry={entry} />
                    </div>
                  </button>
                ))}
              </div>
              {!page?.results.length ? (
                <p className="p-8 text-center text-sm text-black/50">
                  No hay movimientos para estos filtros.
                </p>
              ) : null}
            </>
          )}
        </section>
        <aside className="xl:sticky xl:top-3">
          {selected ? (
            <CommissionDetail
              entry={selected}
              onAdjust={() => setAdjusting(true)}
            />
          ) : (
            <div className="grid min-h-64 place-items-center rounded-xl border bg-white text-black/45">
              Selecciona una comision.
            </div>
          )}
        </aside>
      </div>
      <footer className="flex items-center justify-between text-sm">
        <span>{page?.total ?? 0} movimientos</span>
        <div className="flex gap-2">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
            className="min-h-11 rounded-lg border px-3 disabled:opacity-40"
          >
            Anterior
          </button>
          <button
            disabled={
              offset + (page?.results.length ?? 0) >= (page?.total ?? 0)
            }
            onClick={() => setOffset(offset + 20)}
            className="min-h-11 rounded-lg border px-3 disabled:opacity-40"
          >
            Siguiente
          </button>
        </div>
      </footer>
      {adjusting && selected ? (
        <AdjustmentDialog
          entry={selected}
          onClose={() => setAdjusting(false)}
          onSaved={async () => {
            setAdjusting(false);
            await load();
            await open(selected);
          }}
        />
      ) : null}
    </div>
  );
}
function CommissionDetail({
  entry,
  onAdjust,
}: {
  entry: Detail;
  onAdjust: () => void;
}) {
  return (
    <article className="rounded-xl border bg-white p-4 shadow-sm">
      <header className="flex flex-wrap justify-between gap-3">
        <div>
          <p className="text-xs text-black/50">Detalle de comision</p>
          <h3 className="text-lg font-bold">{entry.sale.orderNumber}</h3>
          <p className="text-sm">{entry.sellerName}</p>
        </div>
        <Badge entry={entry} />
      </header>
      <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <Field label="Cliente" value={entry.sale.customerName} />
        <Field
          label="Fecha"
          value={new Date(entry.sale.confirmedAt).toLocaleString("es-HN")}
        />
        <Field
          label="Base elegible"
          value={formatCurrency(entry.eligibleBase)}
        />
        <Field
          label="Regla historica"
          value={
            entry.ruleType === "PERCENTAGE"
              ? `${entry.ruleValue}% · v${entry.ruleVersion}`
              : `${formatCurrency(entry.ruleValue)} · v${entry.ruleVersion}`
          }
        />
        <Field
          label="Cobrado"
          value={formatCurrency(entry.collection.collectedAmount)}
        />
        <Field label="Proporcion" value={`${entry.collection.ratio}%`} />
        <Field label="Potencial" value={formatCurrency(entry.potential)} />
        <Field label="Ganada" value={formatCurrency(entry.earned)} />
      </div>
      {entry.sale.specialPriceUsed ? (
        <p className="mt-3 rounded-lg bg-blue-50 p-2 text-xs text-blue-800">
          Esta venta utilizo un precio especial autorizado.
        </p>
      ) : null}
      <h4 className="mt-4 font-semibold">Cobros relacionados</h4>
      <div className="mt-2 divide-y rounded-lg border">
        {entry.payments?.map((payment, index) => (
          <div
            key={String(payment.paymentId ?? index)}
            className="flex justify-between p-2 text-xs"
          >
            <span>
              {new Date(String(payment.receivedAt ?? "")).toLocaleString(
                "es-HN",
              )}
            </span>
            <strong>{formatCurrency(Number(payment.amount ?? 0))}</strong>
          </div>
        ))}
        {!entry.payments?.length ? (
          <p className="p-3 text-xs text-black/45">Sin cobros validos.</p>
        ) : null}
      </div>
      <h4 className="mt-4 font-semibold">Historial inmutable</h4>
      <div className="mt-2 max-h-56 divide-y overflow-y-auto rounded-lg border">
        {entry.events.map((event) => (
          <div key={event.eventId} className="p-2 text-xs">
            <div className="flex justify-between">
              <strong>{event.type}</strong>
              <span>
                {event.amountDelta >= 0 ? "+" : ""}
                {formatCurrency(event.amountDelta)}
              </span>
            </div>
            <p className="text-black/50">
              {new Date(event.createdAt).toLocaleString("es-HN")} ·{" "}
              {event.reason}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Link
          href={`/admin/pedidos?orderId=${entry.orderId}`}
          className="grid min-h-11 place-items-center rounded-lg border font-semibold"
        >
          Ver venta
        </Link>
        <Link
          href={`/admin/vendedores?sellerId=${entry.sellerId}`}
          className="grid min-h-11 place-items-center rounded-lg border font-semibold"
        >
          Ver vendedor
        </Link>
        <button
          onClick={onAdjust}
          disabled={["VOIDED", "REVERSED"].includes(entry.status)}
          className="col-span-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border font-semibold disabled:opacity-40"
        >
          <SlidersHorizontal size={17} />
          Registrar ajuste
        </button>
      </div>
    </article>
  );
}
function AdjustmentDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: Detail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input")?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = [
        ...panel.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [onClose]);
  async function save() {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/commissions/${entry.entryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestKey: crypto.randomUUID(),
          amountDelta: Number(amount),
          reason,
        }),
      });
      const payload = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(payload.message);
      onSaved();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "No se pudo registrar el ajuste.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-3">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="adjust-title"
        className="w-full max-w-md rounded-xl bg-white p-4 shadow-2xl"
      >
        <header className="flex justify-between">
          <div>
            <h2 id="adjust-title" className="text-xl font-bold">
              Registrar ajuste
            </h2>
            <p className="text-sm text-black/50">
              {entry.sale.orderNumber} · disponible 0 a{" "}
              {formatCurrency(entry.potential)}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="grid size-11 place-items-center"
          >
            <X />
          </button>
        </header>
        <label className="mt-4 block text-sm font-semibold">
          Monto del ajuste
          <input
            type="number"
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="Positivo o negativo"
            className="mt-1 min-h-11 w-full rounded-lg border px-3"
          />
        </label>
        <label className="mt-3 block text-sm font-semibold">
          Motivo
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={4}
            maxLength={500}
            className="mt-1 w-full rounded-lg border p-3"
          />
        </label>
        {message ? (
          <p
            role="alert"
            className="mt-3 rounded-lg bg-red-50 p-2 text-sm text-red-800"
          >
            {message}
          </p>
        ) : null}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            onClick={onClose}
            className="min-h-11 rounded-lg border font-semibold"
          >
            Cancelar
          </button>
          <button
            onClick={() => void save()}
            disabled={busy || !Number(amount) || reason.trim().length < 10}
            className="min-h-11 rounded-lg bg-[#e4252c] font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Registrando..." : "Registrar ajuste"}
          </button>
        </div>
      </div>
    </div>
  );
}
function FilterField({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label
      className={`min-w-0 text-sm font-semibold text-black/70 ${className}`}
    >
      {label}
      <span className="mt-1.5 block min-w-0">{children}</span>
    </label>
  );
}
function Metric({
  label,
  value,
  tone = "blue",
}: {
  label: string;
  value: number;
  tone?: "blue" | "green" | "amber" | "red";
}) {
  const cls = {
    blue: "bg-blue-50 text-blue-700",
    green: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    red: "bg-red-50 text-red-700",
  }[tone];
  return (
    <article className="rounded-xl border bg-white p-4 shadow-sm">
      <span className={`grid size-10 place-items-center rounded-full ${cls}`}>
        {tone === "amber" ? (
          <Clock3 size={19} />
        ) : (
          <CircleDollarSign size={19} />
        )}
      </span>
      <p className="mt-2 text-xs text-black/50">{label}</p>
      <strong className="text-xl">{formatCurrency(value)}</strong>
    </article>
  );
}
function Badge({ entry }: { entry: CommissionEntry }) {
  const cls =
    entry.status === "EARNED"
      ? "bg-emerald-50 text-emerald-800"
      : entry.status === "ACCRUED" || entry.status === "PARTIALLY_EARNED"
        ? "bg-amber-50 text-amber-800"
        : "bg-red-50 text-red-800";
  return (
    <span
      className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${cls}`}
    >
      {commissionStatusLabels[entry.status]}
    </span>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-2">
      <p className="text-xs text-black/50">{label}</p>
      <strong>{value}</strong>
    </div>
  );
}
