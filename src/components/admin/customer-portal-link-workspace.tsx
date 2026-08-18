"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, LoaderCircle, Search, ShieldCheck, UserRound, X } from "lucide-react";
import {
  linkCustomerPortalAccountAction,
  searchCustomersForPortalLinkAction,
  searchPortalAccountCandidatesAction,
  type PortalAccountCandidate,
  type PortalLinkCustomerCandidate,
} from "@/app/admin/crm/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { roleLabels } from "@/lib/auth/roles";
import { formatHnDateTime } from "@/utils/format";

type CustomerPortalLinkWorkspaceProps = {
  initialCustomer?: PortalLinkCustomerCandidate | null;
  compact?: boolean;
};

export function CustomerPortalLinkWorkspace({ initialCustomer = null, compact = false }: CustomerPortalLinkWorkspaceProps) {
  const router = useRouter();
  const toast = useToast();
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<PortalLinkCustomerCandidate[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<PortalLinkCustomerCandidate | null>(initialCustomer);
  const [accountQuery, setAccountQuery] = useState("");
  const [accountResults, setAccountResults] = useState<PortalAccountCandidate[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<PortalAccountCandidate | null>(null);
  const [selectedEvidenceIndex, setSelectedEvidenceIndex] = useState(0);
  const [reason, setReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [searchingCustomers, setSearchingCustomers] = useState(false);
  const [searchingAccounts, startAccountSearch] = useTransition();
  const [linking, setLinking] = useState(false);
  const requestSequence = useRef(0);
  const linkingRef = useRef(false);
  const linkRequestKeyRef = useRef<string | null>(null);
  const debouncedAccountQuery = useDebouncedValue(accountQuery, 350);
  useEffect(() => {
    linkRequestKeyRef.current = null;
  }, [reason, selectedAccount?.id, selectedCustomer?.id, selectedEvidenceIndex]);


  useEffect(() => {
    if (!selectedCustomer || selectedCustomer.linked || debouncedAccountQuery.trim().length < 3) return;
    const sequence = ++requestSequence.current;
    startAccountSearch(async () => {
      try {
        const result = await searchPortalAccountCandidatesAction(selectedCustomer.id, debouncedAccountQuery);
        if (sequence !== requestSequence.current) return;
        setAccountResults(result.candidates);
        setMessage(result.message);
      } catch {
        if (sequence !== requestSequence.current) return;
        setMessage("No fue posible buscar cuentas del portal.");
      }
    });
  }, [debouncedAccountQuery, selectedCustomer]);

  useEffect(() => {
    if (!confirmOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !linkingRef.current) setConfirmOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmOpen]);

  async function searchCustomers(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searchingCustomers || customerQuery.trim().length < 2) return;
    setSearchingCustomers(true);
    setMessage(null);
    try {
      const result = await searchCustomersForPortalLinkAction(customerQuery);
      setCustomerResults(result.customers);
      setMessage(result.message);
    } finally {
      setSearchingCustomers(false);
    }
  }

  async function confirmLink() {
    const evidence = selectedAccount?.evidence[selectedEvidenceIndex];
    const minimumReasonLength = evidence?.source === "manual_verified_identity" ? 20 : 10;
    if (!selectedCustomer || !selectedAccount || !evidence || linkingRef.current || reason.trim().length < minimumReasonLength) return;
    linkRequestKeyRef.current ??= crypto.randomUUID();
    linkingRef.current = true;
    setLinking(true);
    setMessage(null);
    try {
      const result = await linkCustomerPortalAccountAction({
        customerId: selectedCustomer.id,
        userId: selectedAccount.id,
        requestKey: linkRequestKeyRef.current,
        expectedCommercialVersion: selectedCustomer.commercialVersion,
        evidenceSource: evidence.source,
        evidenceReference: evidence.reference,
        reason,
        confirmed: true,
      });
      setMessage(result.message);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message);
      setSelectedCustomer({ ...selectedCustomer, linked: true, linkedAccountEmail: selectedAccount.email, commercialVersion: result.commercialVersion ?? selectedCustomer.commercialVersion });
      setSelectedAccount(null);
      setAccountResults([]);
      linkRequestKeyRef.current = null;
      setReason("");
      setConfirmOpen(false);
      router.refresh();
    } finally {
      linkingRef.current = false;
      setLinking(false);
    }
  }

  const selectedEvidence = selectedAccount?.evidence[selectedEvidenceIndex] ?? null;
  const reasonMinimumLength = selectedEvidence?.source === "manual_verified_identity" ? 20 : 10;

  return (
    <section className={compact ? "space-y-4" : "rounded-lg border border-black/10 bg-white p-5 shadow-sm"}>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-black/45">Identidad del portal</p>
        <h2 className="mt-1 text-lg font-semibold">Vinculación manual de cuenta web</h2>
        <p className="mt-2 text-sm text-black/60">Un visitante puede existir como cliente comercial sin tener cuenta web. La búsqueda solo consulta cuentas activas ya registradas con rol Cliente: no crea usuarios, no envía correos y no vincula por coincidencia automática.</p>
      </div>

      {!initialCustomer ? (
        <form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={searchCustomers}>
          <Input value={customerQuery} onChange={(event) => setCustomerQuery(event.target.value)} placeholder="Buscar cliente por nombre, correo o teléfono" disabled={searchingCustomers || linking} aria-label="Buscar cliente operativo" />
          <Button type="submit" disabled={searchingCustomers || linking || customerQuery.trim().length < 2}>
            {searchingCustomers ? <LoaderCircle className="animate-spin" size={16} /> : <Search size={16} />}
            {searchingCustomers ? "Buscando..." : "Buscar cliente"}
          </Button>
        </form>
      ) : null}

      {!initialCustomer && customerResults.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {customerResults.map((customer) => (
            <button key={customer.id} type="button" onClick={() => { setSelectedCustomer(customer); setCustomerResults([]); setAccountResults([]); setSelectedAccount(null); setMessage(null); }} className="rounded-md border border-black/10 p-3 text-left hover:bg-[#f4f4f5]">
              <span className="font-semibold">{customer.displayName}</span>
              <span className="mt-1 block text-xs text-black/55">{customer.email || "Sin correo"} · {customer.phone || "Sin teléfono"} · {customer.linked ? "Ya vinculado" : "Sin cuenta web"}</span>
            </button>
          ))}
        </div>
      ) : null}

      {selectedCustomer ? (
        <div className="mt-4 space-y-4">
          <ReviewCard title="Cliente comercial" icon={<ShieldCheck size={17} />}>
            <ReviewGrid items={[
              ["Nombre comercial", selectedCustomer.displayName],
              ["Nombre de contacto", selectedCustomer.contactName],
              ["Correo comercial", selectedCustomer.email || "Sin correo"],
              ["Teléfono comercial", selectedCustomer.phone || "Sin teléfono"],
              ["RTN", selectedCustomer.taxId || "Sin RTN"],
              ["Ciudad", selectedCustomer.city || "Sin ciudad"],
              ["Pedidos", String(selectedCustomer.orderCount)],
              ["Facturas", String(selectedCustomer.invoiceCount)],
              ["Cuentas por cobrar", String(selectedCustomer.receivableCount)],
              ["Crédito", selectedCustomer.hasCreditAccount ? "Configurado" : "No configurado"],
            ]} />
          </ReviewCard>

          {selectedCustomer.linked ? (
            <p className="rounded-md bg-[#f0fdf4] p-3 text-sm text-[#166534]">Este cliente ya está vinculado{selectedCustomer.linkedAccountEmail ? ` a ${selectedCustomer.linkedAccountEmail}` : ""}. Esta fase no permite desvincular.</p>
          ) : !selectedCustomer.active || ["inactive", "disabled"].includes(selectedCustomer.status) ? (
            <p className="rounded-md bg-[#fef2f2] p-3 text-sm text-[#991b1b]">El cliente no está activo y no puede vincularse.</p>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase text-black/50">Buscar cuenta del portal</span>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-black/35" size={16} />
                  <Input value={accountQuery} onChange={(event) => { const value = event.target.value; setAccountQuery(value); setSelectedAccount(null); if (value.trim().length < 3) { requestSequence.current += 1; setAccountResults([]); } }} placeholder="Nombre, correo, usuario o teléfono" disabled={linking} aria-label="Buscar cuenta del portal" className="pl-9" />
                </div>
                <span className="mt-1 block text-xs text-black/45">Escribe al menos 3 caracteres. La búsqueda espera 350 ms.</span>
              </label>
              {searchingAccounts ? <p className="flex items-center gap-2 text-sm text-black/55"><LoaderCircle className="animate-spin" size={15} /> Buscando cuentas elegibles...</p> : null}
              {!searchingAccounts && debouncedAccountQuery.trim().length >= 3 && accountResults.length === 0 && message?.startsWith("No se encontraron") ? <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">No existe una cuenta web registrada que coincida con la búsqueda. El cliente puede seguir operando como visitante; desde esta pantalla no se creará una cuenta ni se enviará un correo.</p> : null}
              {accountResults.length > 0 ? (
                <div className="grid gap-2 md:grid-cols-2">
                  {accountResults.map((account) => (
                    <button key={account.id} type="button" disabled={linking || account.linkedToAnotherCustomer} onClick={() => { setSelectedAccount(account); setSelectedEvidenceIndex(0); }} aria-pressed={selectedAccount?.id === account.id} className={`rounded-md border p-3 text-left transition-colors disabled:cursor-not-allowed ${account.linkedToAnotherCustomer ? "border-[#ef4444]/30 bg-[#fef2f2] opacity-80" : selectedAccount?.id === account.id ? "border-[#e4252c] bg-[#fff1f2]" : "border-black/10 hover:bg-[#f4f4f5]"}`}>
                      <span className="font-semibold">{account.fullName || account.username || "Cuenta del portal"}</span>
                      <span className="mt-1 block text-sm text-black/55">{account.email || "Sin correo visible"}</span>
                      <span className="mt-1 block text-xs text-black/45">{account.phone || "Sin teléfono"} · {account.role ? roleLabels[account.role] : "Sin rol"}</span>
                      <span className={`mt-1 block text-xs font-medium ${account.linkedToAnotherCustomer ? "text-[#991b1b]" : "text-[#166534]"}`}>{account.linkedToAnotherCustomer ? "Conflicto: esta cuenta ya pertenece a otro cliente y no puede seleccionarse" : account.linkedToThisCustomer ? "Esta cuenta ya está vinculada a este cliente" : account.evidence.some((item) => item.exact) ? "Cuenta disponible con evidencia autenticada" : "Cuenta disponible; requiere verificación manual"}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              {selectedAccount ? (
                <ReviewCard title="Cuenta del portal seleccionada" icon={<UserRound size={17} />}>
                  <ReviewGrid items={[
                    ["Nombre", selectedAccount.fullName || selectedAccount.username || "Sin nombre"],
                    ["Correo de acceso", selectedAccount.email || "Sin correo"],
                    ["Teléfono", selectedAccount.phone || "Sin teléfono"],
                    ["Rol", selectedAccount.role ? roleLabels[selectedAccount.role] : "Sin rol"],
                    ["Estado", selectedAccount.active && selectedAccount.authExists ? "Activa" : "No disponible"],
                    ["Creada", selectedAccount.createdAt ? formatHnDateTime(selectedAccount.createdAt) : "No disponible"],
                    ["Correo confirmado", selectedAccount.emailConfirmedAt ? "Sí" : "No"],
                    ["Vinculación", selectedAccount.linkedToThisCustomer ? "Ya vinculada a este cliente" : "Disponible"],
                  ]} />
                  <p className="mt-3 text-sm text-black/60">El historial existente se conservará y el correo de acceso seguirá separado del correo comercial.</p>
                  <label className="mt-3 block text-sm font-medium">
                    Evidencia de identidad
                    <select
                      value={selectedEvidenceIndex}
                      onChange={(event) => setSelectedEvidenceIndex(Number(event.target.value))}
                      className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2"
                    >
                      {selectedAccount.evidence.map((item, index) => (
                        <option key={`${item.source}:${index}`} value={index}>{item.label}</option>
                      ))}
                    </select>
                  </label>
                  <Button type="button" className="mt-4" disabled={selectedAccount.linkedToThisCustomer || linking} onClick={() => setConfirmOpen(true)}>
                    <CheckCircle2 size={16} /> Revisar y confirmar vinculación
                  </Button>
                </ReviewCard>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {message ? <p className="mt-3 text-sm text-black/60" role="status">{message}</p> : null}

      {confirmOpen && selectedCustomer && selectedAccount ? (
        <div className="cz-layer-modal fixed inset-0 grid place-items-center bg-black/55 p-4" onMouseDown={() => !linking && setConfirmOpen(false)}>
          <section role="alertdialog" aria-modal="true" aria-labelledby="portal-link-title" aria-describedby="portal-link-description" className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-xl bg-white shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
            <header className="flex items-start justify-between gap-4 border-b border-black/10 p-5">
              <div><p className="text-xs font-semibold uppercase text-[#e4252c]">Acción auditada</p><h2 id="portal-link-title" className="mt-1 text-lg font-semibold">Confirmar vinculación de cuenta</h2></div>
              <button type="button" aria-label="Cerrar confirmación" disabled={linking} onClick={() => setConfirmOpen(false)} className="grid size-9 place-items-center rounded-md border border-black/10 disabled:opacity-50"><X size={17} /></button>
            </header>
            <div className="space-y-4 p-5">
              <p id="portal-link-description" className="text-sm leading-6 text-black/65">Está a punto de vincular el cliente comercial <strong>{selectedCustomer.displayName}</strong> con la cuenta <strong>{selectedAccount.email || selectedAccount.fullName || "seleccionada"}</strong>. El historial comercial existente se conservará y no se reemplazarán automáticamente los datos del cliente. ¿Desea continuar?</p>
              <div className="grid gap-2 sm:grid-cols-2"><Summary label="Cliente" value={selectedCustomer.displayName} /><Summary label="Cuenta" value={selectedAccount.email || selectedAccount.fullName || "Sin correo"} /></div>
              <label className="block text-sm font-medium">Motivo de la vinculación
                <textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={reasonMinimumLength} maxLength={500} rows={3} disabled={linking} className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 outline-none focus:border-[#e4252c]" placeholder="Describe cómo se verificó la identidad del cliente." />
                <span className="mt-1 block text-xs text-black/45">Entre {reasonMinimumLength} y 500 caracteres.</span>
              </label>
              <div className="grid gap-2 sm:grid-cols-2"><Summary label="Evidencia" value={selectedEvidence?.label ?? "No seleccionada"} /><Summary label="Versión comercial" value={String(selectedCustomer.commercialVersion)} /></div>
            </div>
            <footer className="flex flex-col-reverse gap-2 p-5 pt-0 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" disabled={linking} onClick={() => setConfirmOpen(false)}>Cancelar</Button>
              <Button type="button" variant="dark" disabled={linking || !selectedEvidence || reason.trim().length < reasonMinimumLength} onClick={confirmLink}>{linking ? <LoaderCircle className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}{linking ? "Vinculando..." : "Sí, vincular cuenta"}</Button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function ReviewCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <section className="rounded-md border border-black/10 bg-white p-4"><div className="flex items-center gap-2"><span className="text-[#e4252c]">{icon}</span><h3 className="font-semibold">{title}</h3></div><div className="mt-3">{children}</div></section>;
}

function ReviewGrid({ items }: { items: Array<[string, string]> }) {
  return <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{items.map(([label, value]) => <Summary key={label} label={label} value={value} />)}</div>;
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-[#f4f4f5] px-3 py-2"><p className="text-xs uppercase text-black/45">{label}</p><p className="mt-1 break-words font-medium">{value}</p></div>;
}
