import { Archive, CheckCircle2, CircleSlash2, History, UserRoundCheck } from "lucide-react";
import type { CrmDuplicateCandidate } from "@/types/crm";
import type { CustomerMergeDecision, CustomerMergeHistoryDetails, CustomerMergePreview } from "@/types/customer-merge";
import { formatCurrency } from "@/utils/pricing";

type Props = {
  source: CrmDuplicateCandidate;
  target: CrmDuplicateCandidate;
  preview: CustomerMergePreview;
  details: CustomerMergeHistoryDetails;
  identityDecisions: Record<string, CustomerMergeDecision>;
  creditSource: "primary" | "secondary" | "";
  commercialSource: "primary" | "secondary" | "";
};

const fieldLabels: Record<string, string> = {
  business_name: "Negocio",
  company_name: "Razón social",
  contact_name: "Contacto",
  email: "Correo",
  phone: "Teléfono",
  tax_id: "RTN",
  address: "Dirección",
  city: "Ciudad",
};

function display(value: string | null) {
  return value?.trim() || "Sin información";
}

function chosenValue(field: CustomerMergePreview["identity"][number], decision: CustomerMergeDecision | undefined) {
  if (field.state === "missing_primary") return { value: field.secondaryValue, origin: "Registro secundario", alternate: null };
  if (field.state === "conflict" && decision?.primaryValueSource === "secondary") {
    return { value: field.secondaryValue, origin: "Registro secundario", alternate: field.primaryValue };
  }
  return {
    value: field.primaryValue,
    origin: "Cliente principal",
    alternate: field.state === "conflict" ? field.secondaryValue : null,
  };
}

function creditLabel(value: Record<string, unknown> | null) {
  if (!value) return "Sin crédito";
  return `${value.is_credit_enabled ? "Activo" : "Inactivo"} · ${formatCurrency(Number(value.credit_limit ?? 0))} · ${Number(value.terms_days ?? 0)} días`;
}

function CommercialSummary({ preview, creditSource, commercialSource }: Pick<Props, "preview" | "creditSource" | "commercialSource">) {
  const creditChoice = creditSource || "primary";
  const wholesaleChoice = commercialSource || (preview.wholesale.primary.enabled ? "primary" : preview.wholesale.secondary.enabled ? "secondary" : "primary");
  const credit = creditChoice === "secondary" ? preview.credit.secondary : preview.credit.primary;
  const wholesale = wholesaleChoice === "secondary" ? preview.wholesale.secondary : preview.wholesale.primary;
  return (
    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
      <div className="rounded-md bg-white p-3"><dt className="text-xs text-black/45">Portal</dt><dd className="mt-1 font-medium">{preview.portal.primaryUserId || preview.portal.secondaryUserId ? "Una cuenta vinculada" : "Sin cuenta portal"}</dd></div>
      <div className="rounded-md bg-white p-3"><dt className="text-xs text-black/45">Mayoreo</dt><dd className="mt-1 font-medium">{wholesale.enabled ? `Aprobado · ${wholesale.type}` : "Sin acceso mayorista"}</dd></div>
      <div className="rounded-md bg-white p-3 sm:col-span-2"><dt className="text-xs text-black/45">Crédito y plazo</dt><dd className="mt-1 font-medium">{creditLabel(credit)}</dd></div>
    </dl>
  );
}

function ReferenceList({ title, items, icon: Icon }: { title: string; items: CustomerMergeHistoryDetails["items"]; icon: typeof History }) {
  return (
    <section className="rounded-xl border border-black/10 p-4">
      <h3 className="flex items-center gap-2 font-semibold"><Icon size={19} /> {title}</h3>
      {items.length > 0 ? <ul className="mt-3 space-y-2 text-sm">{items.map((item) => <li key={`${item.category}-${item.id}`} className="rounded-md bg-[#f4f4f5] px-3 py-2"><span className="font-medium">{item.title}: {item.reference}</span><span className="mt-1 block text-xs text-black/55">{item.actionLabel}</span></li>)}</ul> : <p className="mt-3 text-sm text-black/55">No hay registros en esta sección.</p>}
    </section>
  );
}

export function CustomerMergeConfirmationSummary({ source, target, preview, details, identityDecisions, creditSource, commercialSource }: Props) {
  const moving = details.items.filter((item) => item.action === "move_to_primary");
  const historical = details.items.filter((item) => item.action === "remain_historical" || item.action === "resolve_through_alias" || item.action === "preserve_immutable");

  return (
    <div className="space-y-5" data-testid="customer-merge-confirmation-summary">
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-[#e4252c]/30 bg-[#fff1f2] p-4">
          <h3 className="flex items-center gap-2 font-semibold text-[#991b1b]"><UserRoundCheck size={20} /> Cliente que permanecerá</h3>
          <p className="mt-2 text-lg font-semibold">{target.display_name}</p>
          <CommercialSummary preview={preview} creditSource={creditSource} commercialSource={commercialSource} />
        </section>
        <section className="rounded-xl border border-black/10 bg-[#f4f4f5] p-4">
          <h3 className="flex items-center gap-2 font-semibold"><Archive size={20} /> Registro que será archivado</h3>
          <p className="mt-2 text-lg font-semibold">{source.display_name}</p>
          <p className="mt-3 text-sm text-black/60">{details.archiveConsequence.label}</p>
        </section>
      </div>

      <section className="rounded-xl border border-black/10 p-4 sm:p-5">
        <h3 className="font-semibold">Identidad final y valores preservados</h3>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {preview.identity.map((field) => {
            const chosen = chosenValue(field, identityDecisions[field.field]);
            return (
              <div key={field.field} className="rounded-lg bg-[#fafaf9] p-3 ring-1 ring-black/10">
                <p className="text-xs font-semibold uppercase text-black/45">{fieldLabels[field.field] ?? field.field}</p>
                <dl className="mt-2 grid gap-2 text-sm">
                  <div><dt className="text-xs text-black/45">Valor final</dt><dd className="break-words font-medium">{display(chosen.value)}</dd></div>
                  <div><dt className="text-xs text-black/45">Origen</dt><dd>{chosen.origin}</dd></div>
                  {chosen.alternate ? <div><dt className="text-xs text-black/45">Valor alternativo preservado</dt><dd className="break-words">{chosen.alternate}</dd></div> : null}
                </dl>
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ReferenceList title="Información que se trasladará" items={moving} icon={CheckCircle2} />
        <ReferenceList title="Información que permanecerá histórica" items={historical} icon={History} />
      </div>

      <section className="rounded-xl border border-[#22c55e]/30 bg-[#f0fdf4] p-4 sm:p-5">
        <h3 className="flex items-center gap-2 font-semibold text-[#166534]"><CircleSlash2 size={20} /> Información que no cambiará</h3>
        <ul className="mt-3 grid gap-2 text-sm text-[#166534] sm:grid-cols-2">{details.assurances.map((item) => <li key={item.code} className="rounded-md bg-white/75 px-3 py-2">{item.label}</li>)}</ul>
      </section>

      <details className="rounded-lg border border-black/10 p-3 text-xs text-black/55">
        <summary className="cursor-pointer font-semibold text-black/70">Información técnica</summary>
        <p className="mt-2 break-all">Cliente principal: {details.primaryCustomerId}</p>
        <p className="mt-1 break-all">Registro archivado: {details.secondaryCustomerId}</p>
        <p className="mt-1 break-all">Preview: {details.previewHash}</p>
      </details>
    </div>
  );
}
