"use client";

import { useEffect, useState } from "react";
import { ArrowRight, LoaderCircle, Search, X } from "lucide-react";
import { searchCustomerMergeCandidatesAction } from "@/app/admin/crm/customer-merge-actions";
import { Button, Input } from "@/components/ui";
import type { CrmDuplicateCandidate, CrmManualMergeCandidate } from "@/types/crm";

type Props = {
  current: CrmDuplicateCandidate;
  onCancel: () => void;
  onSelect: (source: CrmDuplicateCandidate, target: CrmDuplicateCandidate) => void;
};

function value(value: string | null) {
  return value?.trim() || "Sin información";
}

function CandidateFacts({ candidate }: { candidate: CrmDuplicateCandidate }) {
  return (
    <dl className="mt-3 grid gap-2 text-xs text-black/60 sm:grid-cols-2">
      <div><dt className="font-semibold text-black/45">Empresa</dt><dd>{value(candidate.business_name)}</dd></div>
      <div><dt className="font-semibold text-black/45">Contacto</dt><dd>{value(candidate.contact_name)}</dd></div>
      <div><dt className="font-semibold text-black/45">Correo</dt><dd className="break-all">{value(candidate.email)}</dd></div>
      <div><dt className="font-semibold text-black/45">Teléfono</dt><dd>{value(candidate.phone)}</dd></div>
      <div><dt className="font-semibold text-black/45">RTN</dt><dd>{value(candidate.tax_id)}</dd></div>
      <div><dt className="font-semibold text-black/45">Tipo de cuenta</dt><dd>{candidate.account_type === "wholesale" ? "Mayorista" : "Cliente"}</dd></div>
      <div><dt className="font-semibold text-black/45">Portal</dt><dd>{candidate.has_portal_account ? "Sí" : "No"}</dd></div>
      <div><dt className="font-semibold text-black/45">Actividad</dt><dd>{candidate.order_count} pedidos · {candidate.invoice_count} facturas</dd></div>
      <div><dt className="font-semibold text-black/45">CxC / crédito</dt><dd>{candidate.open_receivable_count} abiertas · {candidate.has_credit_account ? "Con cuenta" : "Sin cuenta"}</dd></div>
      <div><dt className="font-semibold text-black/45">Notas</dt><dd>{candidate.note_count}</dd></div>
    </dl>
  );
}

export function CustomerManualMergePicker({ current, onCancel, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<CrmManualMergeCandidate[]>([]);
  const [selected, setSelected] = useState<CrmManualMergeCandidate | null>(null);
  const [principalChoice, setPrincipalChoice] = useState<"current" | "candidate" | "">("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("Busca por nombre, empresa, correo, teléfono o RTN.");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onCancel]);

  useEffect(() => {
    let active = true;
    const timeoutId = window.setTimeout(() => {
      const normalizedQuery = query.trim();
      if (normalizedQuery.length < 2) {
        setCandidates([]);
        setLoading(false);
        setMessage("Busca por nombre, empresa, correo, teléfono o RTN.");
        return;
      }
      setLoading(true);
      setMessage("Buscando clientes…");
      searchCustomerMergeCandidatesAction({ currentCustomerId: current.id, query: normalizedQuery, limit: 12 }).then((result) => {
        if (!active) return;
        setLoading(false);
        setCandidates(result.candidates);
        setMessage(result.message);
        setSelected((existing) => result.candidates.find((candidate) => candidate.id === existing?.id) ?? null);
      });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [current.id, query]);

  function choose(candidate: CrmManualMergeCandidate) {
    if (!candidate.can_merge) return;
    setSelected(candidate);
    setPrincipalChoice("");
  }

  function continueToPreview() {
    if (!selected || !principalChoice) return;
    if (principalChoice === "current") onSelect(selected, current);
    else onSelect(current, selected);
  }

  return (
    <div className="cz-layer-modal fixed inset-0 z-[60] overflow-y-auto bg-black/55 px-3 py-4 sm:px-6 sm:py-8">
      <section role="dialog" aria-modal="true" aria-labelledby="manual-merge-title" className="mx-auto w-full max-w-5xl rounded-xl bg-white text-[#080808] shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-black/10 p-4 sm:p-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#b91c25]">Selección manual segura</p>
            <h2 id="manual-merge-title" className="mt-1 text-xl font-semibold sm:text-2xl">Unificar con otro cliente</h2>
            <p className="mt-1 text-sm text-black/55">Primero selecciona ambos registros y cuál permanecerá como principal. Después se ejecutará el preview canónico.</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="Cerrar búsqueda de clientes" className="rounded-md p-2 hover:bg-black/5"><X size={20} /></button>
        </header>

        <div className="space-y-5 p-4 sm:p-6">
          <section className="rounded-lg border border-[#e4252c]/25 bg-[#fff1f2] p-4">
            <p className="text-xs font-semibold uppercase text-[#b91c25]">Cliente actual</p>
            <p className="mt-1 text-lg font-semibold">{current.display_name}</p>
            <CandidateFacts candidate={current} />
          </section>

          <div>
            <label htmlFor="manual-merge-search" className="mb-1 block text-sm font-semibold">Buscar otro cliente</label>
            <div className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3 text-black/40" size={18} />
              <Input id="manual-merge-search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} className="pl-10" placeholder="Carrocería Rapalo, correo, teléfono o RTN" />
            </div>
            <p aria-live="polite" className="mt-2 flex items-center gap-2 text-sm text-black/55">{loading ? <LoaderCircle className="animate-spin" size={15} /> : null}{message}</p>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                disabled={!candidate.can_merge}
                onClick={() => choose(candidate)}
                className={`rounded-lg border p-4 text-left transition-colors ${selected?.id === candidate.id ? "border-[#e4252c] bg-[#fff1f2]" : "border-black/10 bg-white hover:bg-[#f4f4f5]"} disabled:cursor-not-allowed disabled:bg-[#f4f4f5] disabled:opacity-70`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div><p className="font-semibold">{candidate.display_name}</p><p className="mt-1 text-xs text-black/45">{candidate.id}</p></div>
                  <span className="rounded-md bg-[#f4f4f5] px-2 py-1 text-xs">{candidate.status}</span>
                </div>
                <CandidateFacts candidate={candidate} />
                {candidate.same_family ? <p className="mt-3 rounded-md bg-[#fff7ed] p-2 text-xs font-semibold text-[#7c2d12]">Ya pertenece al mismo cliente canónico.</p> : null}
              </button>
            ))}
          </div>

          {selected ? (
            <fieldset className="rounded-lg border border-black/10 p-4">
              <legend className="px-1 font-semibold">¿Cuál registro debe permanecer como principal?</legend>
              <p className="mt-1 text-sm text-black/55">Esta decisión no se infiere automáticamente.</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {(["current", "candidate"] as const).map((choice) => {
                  const candidate = choice === "current" ? current : selected;
                  return (
                    <label key={choice} className={`rounded-lg border p-4 ${principalChoice === choice ? "border-[#e4252c] bg-[#fff1f2]" : "border-black/10"}`}>
                      <span className="flex items-start gap-3"><input className="mt-1" type="radio" name="principal" checked={principalChoice === choice} onChange={() => setPrincipalChoice(choice)} /><span><strong className="block">{candidate.display_name}</strong><span className="text-xs text-black/55">{candidate.has_portal_account ? "Con portal" : "Sin portal"} · {candidate.order_count} pedidos · {candidate.invoice_count} facturas</span></span></span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          <footer className="flex flex-col-reverse gap-2 border-t border-black/10 pt-5 sm:flex-row sm:justify-between">
            <Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button>
            <Button type="button" variant="dark" disabled={!selected || !principalChoice} onClick={continueToPreview}>Analizar ambos registros <ArrowRight size={16} /></Button>
          </footer>
        </div>
      </section>
    </div>
  );
}
