"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { executeCustomerMergeAction, previewCustomerMergeAction } from "@/app/admin/crm/customer-merge-actions";
import { Button } from "@/components/ui";
import type { CrmDuplicateCandidate } from "@/types/crm";
import type { CustomerMergeDecision, CustomerMergePreview } from "@/types/customer-merge";
import { formatCurrency } from "@/utils/pricing";

type Props = {
  source: CrmDuplicateCandidate;
  target: CrmDuplicateCandidate;
  onCancel: () => void;
  onComplete: (message: string) => void;
};

const steps = ["Clientes", "Identidad", "Comercial", "Historial", "Confirmación"];
const fieldLabels: Record<string, string> = {
  business_name: "Nombre comercial",
  company_name: "Empresa",
  contact_name: "Contacto",
  email: "Correo",
  phone: "Teléfono",
  tax_id: "RTN",
  address: "Dirección",
  city: "Ciudad",
};
const blockerLabels: Record<string, string> = {
  CUSTOMER_MERGE_TWO_PORTAL_ACCOUNTS: "Los registros tienen dos cuentas de portal diferentes.",
  CUSTOMER_MERGE_CHECKOUT_IN_PROGRESS: "Existe una solicitud Checkout V4 en curso.",
  CUSTOMER_MERGE_POS_DRAFT_ACTIVE: "Existe un borrador POS activo.",
};
const warningLabels: Record<string, string> = {
  CUSTOMER_MERGE_TAX_ID_CONFLICT: "Los RTN son diferentes. Debes elegir el RTN válido para documentos futuros.",
  CUSTOMER_MERGE_CREDIT_CONFLICT: "Ambos registros tienen crédito. Los límites nunca se suman.",
  CUSTOMER_MERGE_WHOLESALE_CONFLICT: "Las configuraciones de mayoreo son diferentes.",
};

function display(value: string | null) {
  return value?.trim() || "Sin información";
}

export function CustomerMergeWizard({ source, target, onCancel, onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [preview, setPreview] = useState<CustomerMergePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [identityDecisions, setIdentityDecisions] = useState<Record<string, CustomerMergeDecision>>({});
  const [creditSource, setCreditSource] = useState<"primary" | "secondary" | "">("");
  const [commercialSource, setCommercialSource] = useState<"primary" | "secondary" | "">("");

  useEffect(() => {
    let active = true;
    previewCustomerMergeAction({ primaryCustomerId: target.id, secondaryCustomerId: source.id }).then((result) => {
      if (!active) return;
      setLoading(false);
      if (!result.ok || !result.preview) {
        setError(result.message);
        return;
      }
      setPreview(result.preview);
      const defaults: Record<string, CustomerMergeDecision> = {};
      for (const field of result.preview.identity) {
        if (field.state === "conflict") {
          defaults[field.field] = {
            primaryValueSource: "primary",
            preserveOtherAsAlternate: field.field !== "tax_id",
            preserveOtherAsHistorical: field.field === "tax_id",
          };
        }
      }
      setIdentityDecisions(defaults);
    });
    return () => {
      active = false;
    };
  }, [source.id, target.id]);

  const requiredIdentityComplete = useMemo(
    () => preview?.identity.filter((field) => field.state === "conflict").every((field) => Boolean(identityDecisions[field.field])) ?? false,
    [identityDecisions, preview],
  );
  const commercialComplete = !preview?.requiredDecisions.includes("credit") || Boolean(creditSource);
  const wholesaleComplete = !preview?.requiredDecisions.includes("commercial") || Boolean(commercialSource);
  const canSubmit = Boolean(
    preview?.allowed && requiredIdentityComplete && commercialComplete && wholesaleComplete && reason.trim().length >= 10 && confirmation.trim() === target.display_name,
  );

  function choose(field: string, sourceChoice: "primary" | "secondary") {
    setIdentityDecisions((current) => ({
      ...current,
      [field]: {
        primaryValueSource: sourceChoice,
        preserveOtherAsAlternate: field !== "tax_id",
        preserveOtherAsHistorical: field === "tax_id",
      },
    }));
  }

  async function submit() {
    if (!preview || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    const result = await executeCustomerMergeAction({
      requestKey: `customer-merge-${crypto.randomUUID()}`,
      primaryCustomerId: preview.primaryCustomerId,
      secondaryCustomerId: preview.secondaryCustomerId,
      expectedPrimaryCommercialVersion: preview.primaryCommercialVersion,
      expectedSecondaryCommercialVersion: preview.secondaryCommercialVersion,
      previewHash: preview.previewHash,
      identityDecisions,
      creditDecision: creditSource ? { selectedSource: creditSource } : {},
      commercialDecision: commercialSource ? { selectedSource: commercialSource } : {},
      reason: reason.trim(),
      source: "crm" as const,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onComplete(result.message);
  }

  return (
    <div className="cz-layer-modal fixed inset-0 z-50 overflow-y-auto bg-black/55 px-3 py-4 sm:px-6 sm:py-8">
      <section className="mx-auto min-h-[calc(100vh-2rem)] w-full max-w-5xl rounded-xl bg-white text-[#080808] shadow-2xl sm:min-h-0">
        <header className="flex items-start justify-between gap-4 border-b border-black/10 p-4 sm:p-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#b91c25]">Unificación canónica</p>
            <h2 className="mt-1 text-xl font-semibold sm:text-2xl">Consolidar clientes sin perder historial</h2>
            <p className="mt-1 text-sm text-black/55">La vista previa, los riesgos y los totales se calculan en el servidor.</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="Cerrar" className="rounded-md p-2 hover:bg-black/5"><X size={20} /></button>
        </header>

        <nav className="grid grid-cols-5 border-b border-black/10" aria-label="Pasos de unificación">
          {steps.map((label, index) => (
            <button key={label} type="button" onClick={() => index <= step && setStep(index)} className={`px-1 py-3 text-[10px] font-semibold sm:px-3 sm:text-xs ${index === step ? "border-b-2 border-[#e4252c] text-[#b91c25]" : "text-black/45"}`}>
              <span className="hidden sm:inline">{index + 1}. </span>{label}
            </button>
          ))}
        </nav>

        <div className="p-4 sm:p-6">
          {loading ? <div className="grid min-h-72 place-items-center text-sm text-black/55"><LoaderCircle className="animate-spin" /> Calculando vista previa segura…</div> : null}
          {error ? <div role="alert" className="mb-4 rounded-lg border border-[#ef4444]/30 bg-[#fff1f2] p-4 text-sm text-[#991b1b]">{error}</div> : null}
          {!loading && preview ? (
            <>
              {preview.blockers.length > 0 ? (
                <div className="mb-4 rounded-lg border border-[#ef4444]/30 bg-[#fff1f2] p-4">
                  <p className="flex items-center gap-2 font-semibold text-[#991b1b]"><AlertTriangle size={18} /> Unión bloqueada</p>
                  {preview.blockers.map((item) => <p key={item} className="mt-2 text-sm text-[#7f1d1d]">{blockerLabels[item] ?? item}</p>)}
                </div>
              ) : null}

              {step === 0 ? (
                <div className="space-y-5">
                  <div className="grid gap-4 md:grid-cols-2">
                    <CustomerCard title="Cliente principal" tone="primary" customer={target} />
                    <CustomerCard title="Registro secundario" customer={source} />
                  </div>
                  <div className="rounded-lg border border-black/10 p-4">
                    <p className="font-semibold">Confianza: {preview.confidence === "strong" ? "fuerte" : preview.confidence === "probable" ? "probable" : "débil"}</p>
                    <div className="mt-2 flex flex-wrap gap-2">{preview.signals.map((signal) => <span key={signal.code} className="rounded-full bg-[#ecfdf3] px-2.5 py-1 text-xs text-[#166534]">{signal.code}</span>)}</div>
                    <p className="mt-3 text-sm text-black/55">El principal permanecerá visible. El secundario quedará archivado como alias y nunca será eliminado.</p>
                  </div>
                </div>
              ) : null}

              {step === 1 ? (
                <div className="space-y-3">
                  {preview.identity.map((field) => (
                    <div key={field.field} className={`rounded-lg border p-4 ${field.state === "conflict" ? "border-[#f59e0b]/50 bg-[#fff7ed]" : "border-black/10"}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{fieldLabels[field.field] ?? field.field}</p><IdentityBadge state={field.state} /></div>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <DecisionValue label="Principal" value={field.primaryValue} checked={identityDecisions[field.field]?.primaryValueSource === "primary"} selectable={field.state === "conflict"} onSelect={() => choose(field.field, "primary")} />
                        <DecisionValue label="Secundario" value={field.secondaryValue} checked={identityDecisions[field.field]?.primaryValueSource === "secondary"} selectable={field.state === "conflict"} onSelect={() => choose(field.field, "secondary")} />
                      </div>
                      <p className="mt-2 text-xs text-black/50">Acción: {field.proposedAction.replaceAll("_", " ")}. Los valores diferentes se conservan estructuralmente.</p>
                    </div>
                  ))}
                </div>
              ) : null}

              {step === 2 ? (
                <div className="space-y-4">
                  {preview.warnings.map((warning) => <div key={warning} className="rounded-lg border border-[#f59e0b]/40 bg-[#fff7ed] p-4 text-sm text-[#7c2d12]"><AlertTriangle className="mr-2 inline" size={17} />{warningLabels[warning] ?? warning}</div>)}
                  <CommercialChoice title="Cuenta portal" primary={preview.portal.primaryUserId ? "Vinculada" : "Sin cuenta"} secondary={preview.portal.secondaryUserId ? "Vinculada" : "Sin cuenta"} />
                  <CommercialChoice title="Mayoreo" primary={`${preview.wholesale.primary.enabled ? "Sí" : "No"} · ${preview.wholesale.primary.status}`} secondary={`${preview.wholesale.secondary.enabled ? "Sí" : "No"} · ${preview.wholesale.secondary.status}`} value={commercialSource} onChange={preview.requiredDecisions.includes("commercial") ? setCommercialSource : undefined} />
                  <CommercialChoice title="Crédito" primary={creditLabel(preview.credit.primary)} secondary={creditLabel(preview.credit.secondary)} value={creditSource} onChange={preview.requiredDecisions.includes("credit") ? setCreditSource : undefined} />
                  <p className="rounded-lg bg-[#f4f4f5] p-4 text-sm text-black/60">Saldo abierto consolidado: <strong>{formatCurrency(Number(preview.financialTotals.receivableOpenBalance ?? 0))}</strong>. Los límites de crédito nunca se suman.</p>
                </div>
              ) : null}

              {step === 3 ? (
                <div className="space-y-5">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {Object.entries(preview.counts).map(([key, value]) => <div key={key} className="rounded-lg border border-black/10 p-3"><p className="text-xs text-black/50">{key}</p><p className="mt-1 text-xl font-semibold">{Number(value).toLocaleString("es-HN")}</p></div>)}
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <PlanCard title="Se reasignará" items={preview.relationPlan.reassign} />
                    <PlanCard title="Permanecerá histórico e inmutable" items={preview.relationPlan.preserveHistorical} protected />
                  </div>
                  <div className="rounded-lg border border-black/10 p-4 text-xs text-black/55">
                    <p className="font-semibold text-black/75">Huellas protegidas</p>
                    <p className="mt-2 break-all">Fiscal: {preview.fiscalHashes.invoices}</p>
                    <p className="mt-1 break-all">Contable: {preview.accountingHashes.publishedEntries}</p>
                  </div>
                </div>
              ) : null}

              {step === 4 ? (
                <div className="space-y-5">
                  <div className="rounded-lg border border-[#22c55e]/30 bg-[#f0fdf4] p-4"><p className="flex items-center gap-2 font-semibold text-[#166534]"><ShieldCheck size={19} /> Confirmación transaccional</p><p className="mt-2 text-sm text-[#166534]">Facturas emitidas, partidas publicadas, eventos financieros e inventario no se reescriben. Cualquier invariante distinta produce rollback total.</p></div>
                  <label className="block"><span className="mb-1 block text-sm font-semibold">Razón de la unión</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} className="w-full rounded-lg border border-black/15 p-3 outline-none focus:border-[#e4252c]" placeholder="Describe la evidencia y autorización empresarial (mínimo 10 caracteres)." /></label>
                  <label className="block"><span className="mb-1 block text-sm font-semibold">Escribe el nombre del cliente principal</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="w-full rounded-lg border border-black/15 p-3 outline-none focus:border-[#e4252c]" placeholder={target.display_name} /><span className="mt-1 block text-xs text-black/50">Confirmación requerida: {target.display_name}</span></label>
                </div>
              ) : null}

              <footer className="mt-6 flex flex-col-reverse gap-2 border-t border-black/10 pt-5 sm:flex-row sm:justify-between">
                <Button type="button" variant="ghost" onClick={() => (step === 0 ? onCancel() : setStep((current) => current - 1))}><ArrowLeft size={16} />{step === 0 ? "Cancelar" : "Anterior"}</Button>
                {step < steps.length - 1 ? <Button type="button" variant="dark" disabled={!preview.allowed || (step === 1 && !requiredIdentityComplete) || (step === 2 && (!commercialComplete || !wholesaleComplete))} onClick={() => setStep((current) => current + 1)}>Continuar<ArrowRight size={16} /></Button> : <Button type="button" variant="dark" disabled={!canSubmit || submitting} onClick={submit}>{submitting ? <LoaderCircle className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}{submitting ? "Unificando…" : "Confirmar unión canónica"}</Button>}
              </footer>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function CustomerCard({ title, customer, tone }: { title: string; customer: CrmDuplicateCandidate; tone?: "primary" }) {
  return <div className={`rounded-lg border p-4 ${tone === "primary" ? "border-[#e4252c]/30 bg-[#fff1f2]" : "border-black/10 bg-[#f4f4f5]"}`}><p className="text-xs font-semibold uppercase text-black/50">{title}</p><p className="mt-2 text-lg font-semibold">{customer.display_name}</p><p className="mt-1 text-sm text-black/55">{display(customer.email)}</p><p className="text-sm text-black/55">{display(customer.phone)}</p><p className="mt-3 text-xs text-black/50">Pedidos {customer.order_count} · Facturas {customer.invoice_count}</p></div>;
}

function IdentityBadge({ state }: { state: string }) {
  const labels: Record<string, string> = { equal: "Coinciden", missing_primary: "Completar principal", missing_secondary: "Solo principal", empty: "Sin información", conflict: "Conflicto" };
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${state === "conflict" ? "bg-[#ffedd5] text-[#9a3412]" : "bg-[#ecfdf3] text-[#166534]"}`}>{labels[state] ?? state}</span>;
}

function DecisionValue({ label, value, checked, selectable, onSelect }: { label: string; value: string | null; checked: boolean; selectable: boolean; onSelect: () => void }) {
  return <label className={`rounded-md border p-3 ${checked ? "border-[#e4252c] bg-white" : "border-black/10 bg-white/70"}`}><span className="text-xs font-semibold uppercase text-black/45">{label}</span><span className="mt-1 block text-sm break-words">{display(value)}</span>{selectable ? <span className="mt-2 flex items-center gap-2 text-xs"><input type="radio" checked={checked} onChange={onSelect} /> Usar como principal</span> : null}</label>;
}

function CommercialChoice({ title, primary, secondary, value, onChange }: { title: string; primary: string; secondary: string; value?: string; onChange?: (value: "primary" | "secondary") => void }) {
  return <div className="rounded-lg border border-black/10 p-4"><p className="font-semibold">{title}</p><div className="mt-3 grid gap-3 md:grid-cols-2">{(["primary", "secondary"] as const).map((source) => <label key={source} className={`rounded-md border p-3 ${value === source ? "border-[#e4252c]" : "border-black/10"}`}><span className="text-xs uppercase text-black/45">{source === "primary" ? "Principal" : "Secundario"}</span><span className="mt-1 block text-sm">{source === "primary" ? primary : secondary}</span>{onChange ? <span className="mt-2 flex items-center gap-2 text-xs"><input type="radio" checked={value === source} onChange={() => onChange(source)} /> Conservar esta configuración</span> : null}</label>)}</div></div>;
}

function creditLabel(value: Record<string, unknown> | null) {
  if (!value) return "Sin crédito";
  return `${value.is_credit_enabled ? "Activo" : "Inactivo"} · ${formatCurrency(Number(value.credit_limit ?? 0))} · ${value.terms_days ?? 0} días`;
}

function PlanCard({ title, items, protected: isProtected }: { title: string; items: string[]; protected?: boolean }) {
  return <div className={`rounded-lg border p-4 ${isProtected ? "border-[#22c55e]/30 bg-[#f0fdf4]" : "border-black/10"}`}><p className="font-semibold">{title}</p><ul className="mt-2 space-y-1 text-sm text-black/60">{items.map((item) => <li key={item}>• {item}</li>)}</ul></div>;
}
