"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BadgeDollarSign,
  Building2,
  ChevronDown,
  CircleUserRound,
  CreditCard,
  Link2,
  LoaderCircle,
  PackageSearch,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  ShoppingCart,
  UserRoundCheck,
  X,
} from "lucide-react";
import type {
  PosCustomerContext,
  PosCustomerSearchPage,
  PosCustomerSearchResult,
  PosCustomerWriteResult,
  PosWholesaleEligibility,
} from "@/types/point-of-sale";
import { formatCurrency } from "@/utils/pricing";

type CustomerForm = {
  contactName: string;
  phone: string;
  email: string;
  businessName: string;
  taxId: string;
  address: string;
  city: string;
  commercialNotes: string;
};

const emptyForm: CustomerForm = {
  contactName: "",
  phone: "",
  email: "",
  businessName: "",
  taxId: "",
  address: "",
  city: "",
  commercialNotes: "",
};

function contextToForm(context: PosCustomerContext): CustomerForm {
  return {
    contactName: context.displayName,
    phone: context.phone,
    email: context.email ?? "",
    businessName: context.businessName ?? "",
    taxId: context.taxId ?? "",
    address: context.address ?? "",
    city: context.city ?? "",
    commercialNotes: context.commercialNotes ?? "",
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? "No se pudo completar la solicitud.");
  return payload;
}

function statusLabel(status: PosCustomerContext["wholesaleStatus"]) {
  if (status === "approved") return "Mayorista aprobado";
  if (status === "suspended") return "Mayorista suspendido";
  if (status === "pending") return "Solicitud mayorista pendiente";
  if (status === "rejected") return "Solicitud mayorista rechazada";
  return "Cliente minorista";
}

function statusTone(status: PosCustomerContext["wholesaleStatus"]) {
  if (status === "approved") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (status === "suspended" || status === "rejected") return "bg-red-50 text-red-800 ring-red-200";
  if (status === "pending") return "bg-amber-50 text-amber-800 ring-amber-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

export function PosCustomerWorkspace({ selectedCustomerId, showFutureStages = true, onCustomerContextChange }: { selectedCustomerId?: string | null; showFutureStages?: boolean; onCustomerContextChange?: (context: PosCustomerContext | null) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PosCustomerSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "error">("idle");
  const [searchMessage, setSearchMessage] = useState("");
  const [context, setContext] = useState<PosCustomerContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [panelMode, setPanelMode] = useState<"closed" | "create" | "edit">("closed");
  const [form, setForm] = useState<CustomerForm>(emptyForm);
  const [initialForm, setInitialForm] = useState<CustomerForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formMessage, setFormMessage] = useState("");
  const [eligibilityAmount, setEligibilityAmount] = useState("");
  const [eligibility, setEligibility] = useState<PosWholesaleEligibility | null>(null);
  const [eligibilityLoading, setEligibilityLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const requestSignatureRef = useRef("");
  const listboxId = "pos-customer-results";

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initialForm), [form, initialForm]);

  useEffect(() => {
    onCustomerContextChange?.(context);
  }, [context, onCustomerContextChange]);

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);

  const confirmDiscard = useCallback(() => !dirty || window.confirm("Hay cambios sin guardar. ¿Quieres descartarlos?"), [dirty]);

  const runSearch = useCallback(async (searchQuery: string, offset = 0, append = false) => {
    const normalized = searchQuery.trim().replace(/\s+/g, " ");
    if (normalized.length < 2) {
      abortRef.current?.abort();
      requestSignatureRef.current = "";
      setResults([]);
      setTotal(0);
      setNextOffset(null);
      setSearchState("idle");
      return;
    }

    const signature = `${normalized}|${offset}`;
    if (requestSignatureRef.current === signature) return;
    requestSignatureRef.current = signature;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearchState("loading");
    setSearchMessage("");

    try {
      const params = new URLSearchParams({ q: normalized, limit: "20", offset: String(offset) });
      const response = await fetch(`/api/admin/pos/customers/search?${params}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      const page = await readJson<PosCustomerSearchPage>(response);
      setResults((current) => (append ? [...current, ...page.results] : page.results));
      setTotal(page.total);
      setNextOffset(page.nextOffset);
      setActiveIndex(page.results.length ? 0 : -1);
      setSearchState("idle");
    } catch (error) {
      if (controller.signal.aborted) return;
      setSearchState("error");
      setSearchMessage(error instanceof Error ? error.message : "No se pudo buscar clientes.");
    } finally {
      if (requestSignatureRef.current === signature) requestSignatureRef.current = "";
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void runSearch(query), 300);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const loadContext = useCallback(async (customerId: string) => {
    setContextLoading(true);
    setSearchMessage("");
    try {
      const response = await fetch(`/api/admin/pos/customers/${customerId}`, {
        headers: { Accept: "application/json" },
      });
      const selected = await readJson<PosCustomerContext>(response);
      setContext(selected);
      setEligibility(null);
      setEligibilityAmount("");
      setPanelMode("closed");
      setForm(contextToForm(selected));
      setInitialForm(contextToForm(selected));
      setResults([]);
      setQuery("");
    } catch (error) {
      setSearchMessage(error instanceof Error ? error.message : "No se pudo cargar el cliente.");
    } finally {
      setContextLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedCustomerId || selectedCustomerId === context?.customerId) return;
    const timer = window.setTimeout(() => void loadContext(selectedCustomerId), 0);
    return () => window.clearTimeout(timer);
  }, [context?.customerId, loadContext, selectedCustomerId]);

  const selectCustomer = useCallback((customer: PosCustomerSearchResult) => {
    if (!confirmDiscard()) return;
    void loadContext(customer.customerId);
  }, [confirmDiscard, loadContext]);

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0 && results[activeIndex]) selectCustomer(results[activeIndex]);
      else void runSearch(query);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setResults([]);
      setQuery("");
      setActiveIndex(-1);
    }
  }

  function openCreate() {
    if (!confirmDiscard()) return;
    setPanelMode("create");
    setContext(null);
    setForm(emptyForm);
    setInitialForm(emptyForm);
    setFormMessage("");
  }

  function openEdit() {
    if (!context) return;
    const next = contextToForm(context);
    setForm(next);
    setInitialForm(next);
    setPanelMode("edit");
    setFormMessage("");
  }

  async function saveCustomer(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !form.contactName.trim() || !form.phone.trim()) return;
    setSaving(true);
    setFormMessage("");
    const requestKey = crypto.randomUUID();
    const body = {
      requestKey,
      ...form,
      email: form.email || null,
      businessName: form.businessName || null,
      taxId: form.taxId || null,
      address: form.address || null,
      city: form.city || null,
      commercialNotes: form.commercialNotes || null,
      ...(panelMode === "edit" && context
        ? { expectedCommercialVersion: context.commercialVersion }
        : {}),
    };

    try {
      const endpoint = panelMode === "edit" && context
        ? `/api/admin/pos/customers/${context.customerId}`
        : "/api/admin/pos/customers";
      const response = await fetch(endpoint, {
        method: panelMode === "edit" ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as PosCustomerWriteResult & { message?: string };
      if (!response.ok) {
        if (result.customerId && (result.status === "duplicate" || result.status === "version_conflict")) {
          setFormMessage(result.message);
          await loadContext(result.customerId);
          return;
        }
        throw new Error(result.message ?? "No se pudo guardar el cliente.");
      }
      await loadContext(result.customerId);
      setFormMessage(result.idempotentReplay ? "Operacion recuperada correctamente." : result.message);
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : "No se pudo guardar el cliente.");
    } finally {
      setSaving(false);
    }
  }

  async function evaluateEligibility() {
    if (!context || eligibilityLoading) return;
    const amount = Number(eligibilityAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      setFormMessage("Ingresa un monto de mercaderia valido.");
      return;
    }
    setEligibilityLoading(true);
    setFormMessage("");
    try {
      const params = new URLSearchParams({ merchandiseFinal: String(amount) });
      const response = await fetch(`/api/admin/pos/customers/${context.customerId}/eligibility?${params}`);
      setEligibility(await readJson<PosWholesaleEligibility>(response));
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : "No se pudo evaluar la elegibilidad.");
    } finally {
      setEligibilityLoading(false);
    }
  }

  function clearSelection() {
    if (!confirmDiscard()) return;
    setContext(null);
    setPanelMode("closed");
    setForm(emptyForm);
    setInitialForm(emptyForm);
    setEligibility(null);
    setFormMessage("");
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-black/10 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="hidden">
            <p className="text-sm font-semibold text-[#e4252c]">Clientes y reglas comerciales</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Punto de Venta</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-black/60">
              Busca, selecciona o crea un cliente. El modo de precio, mayoreo y crédito se resuelven en el servidor
              y se revalidan de forma atómica al confirmar la venta.
            </p>
          </div>
          <button type="button" onClick={openCreate} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#e4252c] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#c91f26] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e4252c]">
            <Plus size={18} /> Cliente rápido
          </button>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.5fr)]">
        <section className="min-w-0 rounded-xl border border-black/10 bg-white p-4 shadow-sm" aria-labelledby="customer-search-title">
          <h2 id="customer-search-title" className="text-lg font-semibold">Buscar cliente</h2>
          <p className="mt-1 text-sm text-black/55">Nombre, empresa, teléfono, correo, RTN o identificador.</p>
          <div className="relative mt-4">
            <Search aria-hidden="true" size={18} className="pointer-events-none absolute left-3 top-3.5 text-black/40" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              role="combobox"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-expanded={results.length > 0}
              aria-activedescendant={activeIndex >= 0 ? `pos-customer-option-${activeIndex}` : undefined}
              aria-label="Buscar cliente del Punto de Venta"
              placeholder="Escribe al menos 2 caracteres"
              className="min-h-11 w-full rounded-lg border border-black/15 bg-white pl-10 pr-11 text-sm outline-none transition focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
            />
            {searchState === "loading" ? <LoaderCircle aria-label="Buscando" size={19} className="absolute right-3 top-3 animate-spin text-[#e4252c]" /> : null}
          </div>
          <div className="mt-2 min-h-6 text-xs text-black/50" aria-live="polite">
            {searchState === "loading" ? "Buscando…" : searchMessage || (results.length ? `${results.length} de ${total} resultados` : query.trim().length >= 2 ? "Sin resultados." : "La búsqueda es bajo demanda.")}
          </div>

          <div id={listboxId} role="listbox" className="mt-2 max-h-[470px] space-y-2 overflow-y-auto overscroll-contain pr-1">
            {results.map((customer, index) => (
              <button
                key={customer.customerId}
                id={`pos-customer-option-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectCustomer(customer)}
                className={`min-h-11 w-full rounded-lg border p-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e4252c] ${index === activeIndex ? "border-[#e4252c] bg-red-50/60" : "border-black/10 hover:border-black/25"}`}
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{customer.displayName}</span>
                    <span className="mt-1 block truncate text-xs text-black/55">{[customer.businessName, customer.phoneMasked, customer.emailMasked].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-xs font-semibold">{customer.customerType === "wholesale" ? "Mayorista" : "Minorista"}</span>
                    <span className={`mt-1 block text-[11px] ${customer.isBlocked ? "text-red-700" : "text-emerald-700"}`}>{customer.isBlocked ? "Revisar" : "Disponible"}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
          {nextOffset !== null ? (
            <button type="button" disabled={searchState === "loading"} onClick={() => void runSearch(query, nextOffset, true)} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-black/15 px-3 py-2 text-sm font-semibold hover:border-[#e4252c] hover:text-[#e4252c] disabled:opacity-50">
              <ChevronDown size={17} /> Cargar más
            </button>
          ) : null}
        </section>

        <section className="min-w-0 rounded-xl border border-black/10 bg-white p-4 shadow-sm sm:p-5" aria-live="polite">
          {contextLoading ? <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-black/55"><LoaderCircle className="animate-spin text-[#e4252c]" size={20} /> Cargando contexto…</div> : null}
          {!contextLoading && panelMode !== "closed" ? (
            <CustomerFormPanel
              mode={panelMode}
              form={form}
              dirty={dirty}
              saving={saving}
              message={formMessage}
              onChange={setForm}
              onSubmit={saveCustomer}
              onCancel={() => {
                if (!confirmDiscard()) return;
                setPanelMode("closed");
                if (context) {
                  const next = contextToForm(context);
                  setForm(next);
                  setInitialForm(next);
                }
              }}
            />
          ) : null}
          {!contextLoading && panelMode === "closed" && context ? (
            <CustomerContextPanel
              context={context}
              eligibilityAmount={eligibilityAmount}
              eligibility={eligibility}
              eligibilityLoading={eligibilityLoading}
              message={formMessage}
              onEligibilityAmount={setEligibilityAmount}
              onEvaluate={() => void evaluateEligibility()}
              onEdit={openEdit}
              onClear={clearSelection}
            />
          ) : null}
          {!contextLoading && panelMode === "closed" && !context ? (
            <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-black/15 bg-[#fafafa] p-6 text-center">
              <CircleUserRound size={38} className="text-black/25" />
              <h2 className="mt-3 text-lg font-semibold">Selecciona un cliente</h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-black/55">El detalle comercial, precio resuelto, portal y crédito se cargan solamente después de seleccionar un resultado.</p>
            </div>
          ) : null}
        </section>
      </div>

      {showFutureStages ? <section className="rounded-xl border border-dashed border-black/15 bg-[#fafafa] p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <FutureStageCard icon={PackageSearch} title="Productos" />
          <FutureStageCard icon={ShoppingCart} title="Carrito" />
          <FutureStageCard icon={CreditCard} title="Pago y cierre" />
        </div>
        <p className="mt-3 text-center text-xs font-medium text-black/50">Disponibles en la siguiente etapa. No hay acciones de venta habilitadas aquí.</p>
      </section> : null}
    </div>
  );
}

function CustomerFormPanel({
  mode,
  form,
  dirty,
  saving,
  message,
  onChange,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  form: CustomerForm;
  dirty: boolean;
  saving: boolean;
  message: string;
  onChange: (value: CustomerForm) => void;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
}) {
  const field = (key: keyof CustomerForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...form, [key]: event.target.value });
  return (
    <form onSubmit={onSubmit}>
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-sm font-semibold text-[#e4252c]">{mode === "create" ? "Alta rápida" : "Edición controlada"}</p><h2 className="text-xl font-semibold">{mode === "create" ? "Nuevo cliente minorista" : "Editar cliente"}</h2></div>
        <button type="button" onClick={onCancel} aria-label="Cerrar formulario" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-black/10 hover:border-[#e4252c] hover:text-[#e4252c]"><X size={18} /></button>
      </div>
      <p className="mt-2 text-sm leading-6 text-black/55">No crea cuenta del portal, crédito, solicitud mayorista, pedido ni venta.</p>
      {dirty ? <p className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900"><AlertTriangle size={16} /> Hay cambios sin guardar.</p> : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <FormField label="Nombre *"><input required maxLength={160} value={form.contactName} onChange={field("contactName")} className="pos-input" /></FormField>
        <FormField label="Teléfono *"><input required maxLength={40} inputMode="tel" value={form.phone} onChange={field("phone")} className="pos-input" /></FormField>
        <FormField label="Correo"><input maxLength={254} inputMode="email" type="email" value={form.email} onChange={field("email")} className="pos-input" /></FormField>
        <FormField label="Empresa"><input maxLength={160} value={form.businessName} onChange={field("businessName")} className="pos-input" /></FormField>
        <FormField label="RTN"><input maxLength={40} value={form.taxId} onChange={field("taxId")} className="pos-input" /></FormField>
        <FormField label="Ciudad"><input maxLength={120} value={form.city} onChange={field("city")} className="pos-input" /></FormField>
        <FormField label="Dirección" wide><textarea maxLength={500} rows={3} value={form.address} onChange={field("address")} className="pos-input resize-y py-3" /></FormField>
        <FormField label="Notas comerciales no sensibles" wide><textarea maxLength={1000} rows={3} value={form.commercialNotes} onChange={field("commercialNotes")} className="pos-input resize-y py-3" /></FormField>
      </div>
      {message ? <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-sm" role="status">{message}</p> : null}
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={onCancel} className="min-h-11 rounded-lg border border-black/15 px-4 py-2 text-sm font-semibold">Cancelar</button>
        <button type="submit" disabled={saving || !form.contactName.trim() || !form.phone.trim()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#e4252c] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? <LoaderCircle size={18} className="animate-spin" /> : <UserRoundCheck size={18} />}{mode === "create" ? "Crear cliente" : "Guardar cambios"}</button>
      </div>
    </form>
  );
}

function CustomerContextPanel({
  context,
  eligibilityAmount,
  eligibility,
  eligibilityLoading,
  message,
  onEligibilityAmount,
  onEvaluate,
  onEdit,
  onClear,
}: {
  context: PosCustomerContext;
  eligibilityAmount: string;
  eligibility: PosWholesaleEligibility | null;
  eligibilityLoading: boolean;
  message: string;
  onEligibilityAmount: (value: string) => void;
  onEvaluate: () => void;
  onEdit: () => void;
  onClear: () => void;
}) {
  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#e4252c]">Cliente seleccionado</p>
          <h2 className="mt-1 break-words text-2xl font-semibold">{context.displayName}</h2>
          <p className="mt-1 break-words text-sm text-black/55">{[context.businessName, context.phone, context.email].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={onEdit} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-black/15 px-3 py-2 text-sm font-semibold hover:border-[#e4252c] hover:text-[#e4252c]"><Pencil size={16} /> Editar</button>
          <button type="button" onClick={onClear} aria-label="Quitar selección" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-black/15 hover:border-[#e4252c] hover:text-[#e4252c]"><X size={17} /></button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${statusTone(context.wholesaleStatus)}`}>{statusLabel(context.wholesaleStatus)}</span>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${context.pricingMode === "wholesale" ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-slate-100 text-slate-700 ring-slate-200"}`}>Precio {context.pricingMode === "wholesale" ? "mayorista" : "minorista"}</span>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">Versión {context.commercialVersion}</span>
      </div>
      <p className="mt-3 rounded-lg bg-[#fafafa] px-3 py-2 text-sm leading-6 text-black/65">{context.pricingReason}</p>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <InfoCard icon={Link2} title="Portal" value={context.hasPortalAccount ? "Cuenta vinculada" : "Sin cuenta vinculada"} detail="La creación rápida no genera usuarios Auth ni invitaciones.">
          {!context.hasPortalAccount ? <Link href="/admin/vincular-cuenta-cliente" className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-[#e4252c] hover:underline">Abrir vinculación administrativa</Link> : null}
        </InfoCard>
        <InfoCard icon={CreditCard} title="Crédito (solo lectura)" value={context.credit.status === "active" ? "Activo" : context.credit.status === "on_hold" ? "En espera" : context.credit.status === "suspended" ? "Suspendido" : "No habilitado"} detail={context.credit.reason}>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs"><Metric label="Límite" value={formatCurrency(context.credit.creditLimit)} /><Metric label="Disponible" value={formatCurrency(context.credit.availableCredit)} /><Metric label="Saldo abierto" value={formatCurrency(context.credit.openBalance)} /><Metric label="Vencido" value={formatCurrency(context.credit.overdueBalance)} /></div>
        </InfoCard>
        <InfoCard icon={Building2} title="Resumen comercial" value={`${context.summary.orderCount.toLocaleString("es-HN")} pedidos`} detail={`${context.summary.invoiceCount.toLocaleString("es-HN")} facturas · ${formatCurrency(context.summary.totalBilled)} facturado`} />
        <InfoCard icon={ShieldCheck} title="Estado operativo" value={context.customerStatus === "active" ? "Activo" : "Inactivo"} detail="La confirmación releerá el estado vigente desde la base de datos." />
      </div>

      <div className="mt-4 rounded-xl border border-black/10 bg-[#fafafa] p-4">
        <div className="flex items-start gap-3"><BadgeDollarSign className="mt-0.5 shrink-0 text-[#e4252c]" size={20} /><div><h3 className="font-semibold">Evaluar elegibilidad mayorista</h3><p className="mt-1 text-sm leading-6 text-black/55">Usa solo mercadería final con ISV incluido; excluye entrega, COD y cargos externos. No aprueba ni modifica al cliente.</p></div></div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input aria-label="Monto final de mercadería" inputMode="decimal" min="0" step="0.01" type="number" value={eligibilityAmount} onChange={(event) => onEligibilityAmount(event.target.value)} placeholder="L 0.00" className="pos-input sm:max-w-56" />
          <button type="button" disabled={eligibilityLoading} onClick={onEvaluate} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{eligibilityLoading ? <LoaderCircle size={17} className="animate-spin" /> : null} Evaluar</button>
        </div>
        {eligibility ? <div className={`mt-3 rounded-lg p-3 text-sm ${eligibility.eligible ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-950"}`}><p className="font-semibold">{eligibility.pricingMode === "wholesale" ? "Precio mayorista vigente" : eligibility.eligible ? "Elegible para revisión mayorista" : `Faltan ${formatCurrency(eligibility.missingAmount)}`}</p><p className="mt-1 leading-6">{eligibility.recommendedAction}</p><p className="mt-1 text-xs">Umbral: {formatCurrency(eligibility.thresholdAmount)} · Evaluado: {formatCurrency(eligibility.evaluatedAmount)}</p></div> : null}
      </div>
      {message ? <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-sm" role="status">{message}</p> : null}
    </div>
  );
}

function FormField({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={`grid gap-1.5 text-sm font-semibold ${wide ? "sm:col-span-2" : ""}`}><span>{label}</span>{children}</label>;
}

function InfoCard({ icon: Icon, title, value, detail, children }: { icon: React.ComponentType<{ size?: number; className?: string }>; title: string; value: string; detail: string; children?: React.ReactNode }) {
  return <div className="min-w-0 rounded-xl border border-black/10 p-4"><div className="flex items-start gap-3"><span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-red-50 text-[#e4252c]"><Icon size={19} /></span><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-black/45">{title}</p><p className="mt-1 break-words font-semibold">{value}</p><p className="mt-1 text-sm leading-5 text-black/55">{detail}</p></div></div>{children}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-[#fafafa] p-2"><p className="text-black/45">{label}</p><p className="mt-1 break-words font-semibold text-black/75">{value}</p></div>;
}

function FutureStageCard({ icon: Icon, title }: { icon: React.ComponentType<{ size?: number }>; title: string }) {
  return <div className="flex min-h-20 items-center gap-3 rounded-lg border border-black/10 bg-white p-3 text-black/45"><span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-slate-100"><Icon size={19} /></span><div><p className="font-semibold text-black/60">{title}</p><p className="text-xs">Siguiente etapa</p></div></div>;
}
