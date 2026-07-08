import { BookOpen, Clock, ExternalLink, ShieldCheck, UserRound } from "lucide-react";
import type {
  AccountingTraceabilityItem,
  AccountingTraceabilitySummary,
  AccountingTraceabilityTone,
} from "@/types/accounting-traceability";

type AccountingTraceabilityCardProps = {
  traceability?: AccountingTraceabilitySummary | null;
  title?: string;
  compact?: boolean;
  showOriginLink?: boolean;
};

const toneClasses: Record<AccountingTraceabilityTone, string> = {
  success: "border-[#2f6f3e]/20 bg-[#edf7ed] text-[#2f6f3e]",
  warning: "border-[#f59e0b]/25 bg-[#fff7ed] text-[#7c2d12]",
  danger: "border-[#e4252c]/20 bg-[#fff1f2] text-[#b91c25]",
  neutral: "border-black/10 bg-[#f4f4f5] text-black/65",
  info: "border-[#2563eb]/15 bg-[#eff6ff] text-[#1d4ed8]",
};

export function AccountingTraceabilityCard({
  traceability,
  title = "Contabilidad",
  compact = false,
  showOriginLink = false,
}: AccountingTraceabilityCardProps) {
  if (!traceability) return null;

  return (
    <section className="rounded-md border border-black/10 bg-white p-3 text-sm shadow-sm sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 font-semibold">
            <BookOpen size={17} className="shrink-0" />
            {title}
          </h3>
          <p className="mt-1 text-sm text-black/55">Trazabilidad entre operacion y libro diario.</p>
        </div>
        <StatusPill label={traceability.primaryStatusLabel} tone={traceability.primaryTone} />
      </div>

      <div className={compact ? "mt-3 space-y-2" : "mt-4 space-y-3"}>
        {traceability.items.map((item) => (
          <TraceabilityItem key={item.key} item={item} compact={compact} showOriginLink={showOriginLink} />
        ))}
      </div>
    </section>
  );
}

function TraceabilityItem({
  item,
  compact,
  showOriginLink,
}: {
  item: AccountingTraceabilityItem;
  compact: boolean;
  showOriginLink: boolean;
}) {
  return (
    <article className="rounded-md border border-black/10 bg-[#fafafa] p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="break-words font-semibold [overflow-wrap:anywhere]">{item.label}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            <StatusPill label={item.statusLabel} tone={item.tone} />
            {item.entryNumber ? (
              <span className="rounded-full border border-black/10 bg-white px-2.5 py-1 text-xs font-semibold text-black/65">
                {item.entryNumber}
              </span>
            ) : null}
            {item.accountingPeriod ? (
              <span className="rounded-full border border-black/10 bg-white px-2.5 py-1 text-xs font-semibold text-black/65">
                {item.accountingPeriod}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          {item.journalEntryHref ? (
            <a
              href={item.journalEntryHref}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold text-[#080808] transition-colors hover:border-[#e4252c]/30 hover:bg-[#fff1f2]"
            >
              <ExternalLink size={15} />
              Ver partida contable
            </a>
          ) : null}
          {showOriginLink && item.originHref ? (
            <a
              href={item.originHref}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold text-[#080808] transition-colors hover:border-[#e4252c]/30 hover:bg-[#fff1f2]"
            >
              <ExternalLink size={15} />
              Ver origen
            </a>
          ) : null}
        </div>
      </div>

      {item.message ? <p className="mt-3 rounded-md bg-white p-2 text-sm text-black/60">{item.message}</p> : null}

      {!compact ? (
        <dl className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Meta icon={Clock} label="Fecha de generacion" value={item.generatedDate ?? "No disponible"} />
          <Meta icon={Clock} label="Hora de generacion" value={item.generatedTime ?? "No disponible"} />
          <Meta icon={UserRound} label="Generada por" value={item.generatedBy} />
          {item.generatedByRole ? <Meta icon={ShieldCheck} label="Rol del generador" value={item.generatedByRole} /> : null}
          {item.publishedDate ? <Meta icon={Clock} label="Fecha de publicacion" value={item.publishedDate} /> : null}
          {item.publishedTime ? <Meta icon={Clock} label="Hora de publicacion" value={item.publishedTime} /> : null}
          {item.publishedBy ? <Meta icon={UserRound} label="Publicada por" value={item.publishedBy} /> : null}
          {item.publishedByRole ? <Meta icon={ShieldCheck} label="Rol del publicador" value={item.publishedByRole} /> : null}
        </dl>
      ) : null}
    </article>
  );
}

function StatusPill({ label, tone }: { label: string; tone: AccountingTraceabilityTone }) {
  return (
    <span className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClasses[tone]}`}>
      {label}
    </span>
  );
}

function Meta({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-white px-3 py-2">
      <dt className="flex items-center gap-1.5 text-xs uppercase text-black/45">
        <Icon size={13} className="shrink-0" />
        {label}
      </dt>
      <dd className="mt-1 break-words font-semibold text-black/75 [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}
