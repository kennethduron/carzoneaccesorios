"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
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
import { PosConfirmationDialog } from "@/components/admin/pos-confirmation-dialog";
import type {
  PosCustomerContext,
  PosCustomerDuplicateSuggestion,
  PosCustomerDuplicateSuggestionPage,
  PosCustomerSearchPage,
  PosCustomerSearchResult,
  PosCustomerWriteResult,
} from "@/types/point-of-sale";
import { formatCurrency } from "@/utils/pricing";
import { posCustomerMatchLabel, posSourceLabel } from "@/utils/pos-presentation-labels";

type CustomerForm = {
  contactName: string;
  phone: string;
  email: string;
  businessName: string;
  taxId: string;
  address: string;
  city: string;
  commercialNotes: string;
  customerType: "retail" | "wholesale";
  creditEnabled: boolean;
  creditStatus: "active" | "suspended";
  creditLimit: string;
  creditTermsDays: string;
  creditNotes: string;
  duplicateOverrideReason: string;
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
  customerType: "retail",
  creditEnabled: false,
  creditStatus: "active",
  creditLimit: "",
  creditTermsDays: "30",
  creditNotes: "",
  duplicateOverrideReason: "",
};

function contextToForm(context: PosCustomerContext): CustomerForm {
  return {
    contactName: context.displayName,
    phone: context.phone ?? "",
    email: context.email ?? "",
    businessName: context.businessName ?? "",
    taxId: context.taxId ?? "",
    address: context.address ?? "",
    city: context.city ?? "",
    commercialNotes: context.commercialNotes ?? "",
    customerType: context.customerType,
    creditEnabled: context.credit.enabled,
    creditStatus: context.credit.status === "suspended" ? "suspended" : "active",
    creditLimit: context.credit.creditLimit > 0 ? String(context.credit.creditLimit) : "",
    creditTermsDays: String(context.credit.termsDays),
    creditNotes: context.credit.notes ?? "",
    duplicateOverrideReason: "",
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { code?: string; message?: string };
  if (!response.ok) throw new PosCustomerApiError(payload.message ?? "No se pudo completar la solicitud.", payload.code);
  return payload;
}

class PosCustomerApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "PosCustomerApiError";
  }
}

type PendingFormAction =
  | { kind: "select"; customerId: string }
  | { kind: "create" }
  | { kind: "close" }
  | { kind: "clear" };

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

export function PosCustomerWorkspace({ selectedCustomerId, showFutureStages = true, compact = false, onCustomerContextChange }: { selectedCustomerId?: string | null; showFutureStages?: boolean; compact?: boolean; onCustomerContextChange?: (context: PosCustomerContext | null) => void }) {
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
  const [duplicateSuggestions, setDuplicateSuggestions] = useState<PosCustomerDuplicateSuggestion[]>([]);
  const [duplicateState, setDuplicateState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [duplicateMessage, setDuplicateMessage] = useState('');
  const [duplicateResultSignature, setDuplicateResultSignature] = useState('');
  const [pendingFormAction, setPendingFormAction] = useState<PendingFormAction | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const duplicateAbortRef = useRef<AbortController | null>(null);
  const contextRevisionRef = useRef(0);
  const requestSignatureRef = useRef("");
  const listboxId = "pos-customer-results";

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initialForm), [form, initialForm]);
  const visibleContext = selectedCustomerId && context?.customerId === selectedCustomerId ? context : null;
  const duplicateInputReady = form.contactName.trim().length >= 3
    || form.businessName.trim().length >= 3
    || Boolean(form.email.trim())
    || form.phone.replace(/\D/g, '').length >= 8
    || form.taxId.replace(/\D/g, '').length >= 14;
  const duplicateQuerySignature = duplicateInputReady ? JSON.stringify([
    form.contactName.trim(), form.businessName.trim(), form.email.trim().toLowerCase(),
    form.phone.replace(/\D/g, ''), form.taxId.replace(/\D/g, ''),
  ]) : '';
  const visibleDuplicateSuggestions = duplicateResultSignature === duplicateQuerySignature
    ? duplicateSuggestions : [];
  const duplicateReviewState = !duplicateInputReady ? 'idle'
    : duplicateResultSignature !== duplicateQuerySignature ? 'loading'
      : duplicateState;
  const strongSuggestions = visibleDuplicateSuggestions.filter((suggestion) => suggestion.matchLevel === 'strong');
  const hasNonOverridableMatch = strongSuggestions.some((suggestion) => !suggestion.overrideAllowed);
  const requiresOverrideReason = strongSuggestions.some((suggestion) => suggestion.overrideAllowed)
    && !hasNonOverridableMatch;
  const duplicateBlocksCreate = panelMode === 'create' && (
    hasNonOverridableMatch || (requiresOverrideReason && form.duplicateOverrideReason.trim().length < 5)
  );

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);

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

  useEffect(() => {
    if (panelMode !== 'create' || !duplicateQuerySignature) {
      duplicateAbortRef.current?.abort();
      return;
    }
    const timer = window.setTimeout(async () => {
      duplicateAbortRef.current?.abort();
      const controller = new AbortController();
      duplicateAbortRef.current = controller;
      setDuplicateState('loading');
      setDuplicateMessage('');
      try {
        const response = await fetch('/api/admin/pos/customers/suggestions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            contactName: form.contactName,
            businessName: form.businessName || null,
            email: form.email || null,
            phone: form.phone || null,
            taxId: form.taxId || null,
          }),
          signal: controller.signal,
        });
        const payload = await readJson<PosCustomerDuplicateSuggestionPage>(response);
        if (controller.signal.aborted) return;
        setDuplicateSuggestions(payload.results);
        setDuplicateResultSignature(duplicateQuerySignature);
        setDuplicateState('idle');
      } catch (error) {
        if (controller.signal.aborted) return;
        setDuplicateSuggestions([]);
        setDuplicateResultSignature(duplicateQuerySignature);
        setDuplicateState('error');
        setDuplicateMessage(error instanceof Error ? error.message : 'No se pudieron revisar coincidencias.');
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [duplicateQuerySignature, form.businessName, form.contactName, form.email, form.phone, form.taxId, panelMode]);

  useEffect(() => () => duplicateAbortRef.current?.abort(), []);

  const loadContext = useCallback(async (customerId: string, requestSelection = false) => {
    const revision = ++contextRevisionRef.current;
    setContextLoading(true);
    setSearchMessage("");
    try {
      const response = await fetch(`/api/admin/pos/customers/${customerId}`, {
        headers: { Accept: "application/json" },
      });
      const selected = await readJson<PosCustomerContext>(response);
      if (revision !== contextRevisionRef.current) return;
      if (requestSelection) {
        onCustomerContextChange?.(selected);
        return;
      }
      setContext(selected);
      setPanelMode("closed");
      setForm(contextToForm(selected));
      setInitialForm(contextToForm(selected));
      setResults([]);
      setQuery("");
      onCustomerContextChange?.(selected);
    } catch (error) {
      if (revision !== contextRevisionRef.current) return;
      setSearchMessage(error instanceof Error ? error.message : "No se pudo cargar el cliente.");
    } finally {
      if (revision === contextRevisionRef.current) setContextLoading(false);
    }
  }, [onCustomerContextChange]);

  useEffect(() => {
    if (!selectedCustomerId) {
      contextRevisionRef.current += 1;
      return;
    }
    if (selectedCustomerId === context?.customerId) return;
    const timer = window.setTimeout(() => void loadContext(selectedCustomerId, false), 0);
    return () => window.clearTimeout(timer);
  }, [context?.customerId, loadContext, selectedCustomerId]);

  function executeFormAction(action: PendingFormAction) {
    setPendingFormAction(null);
    setForm(initialForm);
    setFormMessage("");
    if (action.kind === "select") {
      void loadContext(action.customerId, true);
      return;
    }
    if (action.kind === "create") {
      setPanelMode("create");
      setForm(emptyForm);
      setInitialForm(emptyForm);
      setFormMessage("");
      setDuplicateSuggestions([]);
      setDuplicateResultSignature("");
      setDuplicateState("idle");
      setDuplicateMessage("");
      return;
    }
    if (action.kind === "clear") {
      contextRevisionRef.current += 1;
      onCustomerContextChange?.(null);
      if (!onCustomerContextChange) setContext(null);
      return;
    }
    setPanelMode("closed");
    if (context) {
      const next = contextToForm(context);
      setForm(next);
      setInitialForm(next);
    }
  }

  function requestFormAction(action: PendingFormAction) {
    if (dirty) {
      setPendingFormAction(action);
      return;
    }
    executeFormAction(action);
  }

  const selectCustomer = useCallback((customer: PosCustomerSearchResult) => {
    requestFormAction({ kind: "select", customerId: customer.customerId });
  // requestFormAction intentionally uses the current form state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, loadContext]);

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
    requestFormAction({ kind: "create" });
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
    if (saving || !form.contactName.trim()) return;
    if (panelMode === 'create' && (duplicateBlocksCreate || duplicateReviewState !== 'idle')) {
      setFormMessage(duplicateReviewState === 'loading'
        ? 'Espera a que termine la revision de posibles clientes existentes.'
        : duplicateReviewState === 'error'
          ? 'No se puede crear el cliente hasta completar la revision de coincidencias.'
          : hasNonOverridableMatch
            ? 'Use o corrija el perfil existente: la coincidencia exacta no admite excepcion.'
            : 'Confirme la excepcion e ingrese un motivo de al menos 5 caracteres.');
      return;
    }
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
      customerType: form.customerType,
      creditMode: form.creditEnabled
        ? form.creditStatus
        : panelMode === "edit" && context?.credit.accountExists ? "disabled" : "none",
      creditLimit: Number(form.creditLimit || 0),
      creditTermsDays: Number(form.creditTermsDays || 30),
      creditNotes: form.creditNotes || null,
      changeReason: "Configurado desde Punto de Venta.",
      duplicateOverrideReason: form.duplicateOverrideReason.trim() || null,
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
        if (result.customerId && result.status === 'version_conflict') {
          setFormMessage(result.message);
          await loadContext(result.customerId);
          return;
        }
        if (result.customerId && (["duplicate", "possible_duplicate"] as string[]).includes(result.status)) {
          setFormMessage(result.message);
          return;
        }
        throw new Error(result.message ?? "No se pudo guardar el cliente.");
      }
      await loadContext(result.customerId, panelMode === "create");
      setFormMessage(result.idempotentReplay ? "Operacion recuperada correctamente." : result.message);
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : "No se pudo guardar el cliente.");
    } finally {
      setSaving(false);
    }
  }

  function clearSelection() {
    requestFormAction({ kind: "clear" });
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-black/10 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div><p className="text-sm font-semibold text-[#e4252c]">Cliente</p><h2 className="mt-0.5 text-lg font-semibold">Buscar o seleccionar cliente</h2></div>
          <button type="button" onClick={openCreate} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#e4252c] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#c91f26] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e4252c]">
            <Plus size={18} /> Nuevo cliente
          </button>
        </div>
      </section>

      <div className={compact ? "grid gap-4" : "grid gap-4 xl:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.5fr)]"}>
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
              duplicateSuggestions={visibleDuplicateSuggestions}
              duplicateState={duplicateReviewState}
              duplicateMessage={duplicateMessage}
              duplicateBlocksCreate={duplicateBlocksCreate}
              onChange={setForm}
              onSubmit={saveCustomer}
              onCancel={() => requestFormAction({ kind: "close" })}
              onSelectSuggestion={(customerId) => void loadContext(customerId)}
            />
          ) : null}
          {!contextLoading && panelMode === "closed" && visibleContext ? (
            <CustomerContextPanel
              context={visibleContext}
              compact={compact}
              message={formMessage}
              onEdit={openEdit}
              onClear={clearSelection}
            />
          ) : null}
          {!contextLoading && panelMode === "closed" && !visibleContext ? (
            <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-black/15 bg-[#fafafa] p-6 text-center">
              <CircleUserRound size={38} className="text-black/25" />
              <h2 className="mt-3 text-lg font-semibold">Selecciona un cliente</h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-black/55">El detalle comercial, precio resuelto, portal y crédito se cargan solamente después de seleccionar un resultado.</p>
              {searchMessage ? <p role="alert" className="mt-3 max-w-md rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800">{searchMessage}</p> : null}
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
        <p className="mt-3 text-center text-xs font-medium text-black/50">Estas funciones no están disponibles para este perfil.</p>
      </section> : null}
      {pendingFormAction ? <PosConfirmationDialog
        title="Descartar cambios"
        description="Los datos ingresados no se han guardado. Si continúa, se perderán estos cambios."
        confirmLabel="Descartar cambios"
        cancelLabel="Continuar editando"
        onCancel={() => setPendingFormAction(null)}
        onConfirm={() => executeFormAction(pendingFormAction)}
      /> : null}
    </div>
  );
}

function CustomerFormPanel({
  mode,
  form,
  dirty,
  saving,
  message,
  duplicateSuggestions,
  duplicateState,
  duplicateMessage,
  duplicateBlocksCreate,
  onChange,
  onSubmit,
  onCancel,
  onSelectSuggestion,
}: {
  mode: "create" | "edit";
  form: CustomerForm;
  dirty: boolean;
  saving: boolean;
  message: string;
  duplicateSuggestions: PosCustomerDuplicateSuggestion[];
  duplicateState: 'idle' | 'loading' | 'error';
  duplicateMessage: string;
  duplicateBlocksCreate: boolean;
  onChange: (value: CustomerForm) => void;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
  onSelectSuggestion: (customerId: string) => void;
}) {
  const field = (key: keyof CustomerForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...form, [key]: event.target.value });
  const exactBlocked = duplicateSuggestions.some((suggestion) => suggestion.matchLevel === 'strong' && !suggestion.overrideAllowed);
  const phoneOverrideAvailable = duplicateSuggestions.some((suggestion) => suggestion.matchLevel === 'strong' && suggestion.overrideAllowed)
    && !exactBlocked;
  return (
    <form onSubmit={onSubmit}>
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-sm font-semibold text-[#e4252c]">{mode === "create" ? "Alta rápida integral" : "Configuración comercial"}</p><h2 className="text-xl font-semibold">{mode === "create" ? "Nuevo cliente" : "Editar configuración comercial"}</h2></div>
        <button type="button" onClick={onCancel} aria-label="Cerrar formulario" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-black/10 hover:border-[#e4252c] hover:text-[#e4252c]"><X size={18} /></button>
      </div>
      <p className="mt-2 text-sm leading-6 text-black/55">Guarde los datos comerciales del cliente. Esta acción no crea pedidos ni ventas.</p>
      {dirty ? <p className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900"><AlertTriangle size={16} /> Hay cambios sin guardar.</p> : null}
      <fieldset className="mt-4">
        <legend className="text-sm font-semibold uppercase tracking-wide text-black/50">Información básica</legend>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <FormField label="Nombre o razón social *"><input required maxLength={160} value={form.contactName} onChange={field("contactName")} className="pos-input" /></FormField>
        <FormField label="Teléfono"><input maxLength={40} inputMode="tel" value={form.phone} onChange={field("phone")} className="pos-input" /></FormField>
        <FormField label="Correo"><input maxLength={254} inputMode="email" type="email" value={form.email} onChange={field("email")} className="pos-input" /></FormField>
        <FormField label="Empresa"><input maxLength={160} value={form.businessName} onChange={field("businessName")} className="pos-input" /></FormField>
        <FormField label="RTN"><input maxLength={40} value={form.taxId} onChange={field("taxId")} className="pos-input" /></FormField>
        <FormField label="Ciudad"><input maxLength={120} value={form.city} onChange={field("city")} className="pos-input" /></FormField>
        <FormField label="Dirección" wide><textarea maxLength={500} rows={3} value={form.address} onChange={field("address")} className="pos-input resize-y py-3" /></FormField>
        <FormField label="Notas comerciales no sensibles" wide><textarea maxLength={1000} rows={3} value={form.commercialNotes} onChange={field("commercialNotes")} className="pos-input resize-y py-3" /></FormField>
        </div>
      </fieldset>
      {!form.phone.trim() && !form.email.trim() && !form.taxId.trim() ? <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">Puedes crear el perfil solo con el nombre. Completa teléfono, correo o RTN después para facilitar la identificación.</p> : null}

      {mode === 'create' && (duplicateState !== 'idle' || duplicateSuggestions.length > 0) ? (
        <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4" aria-labelledby="pos-duplicate-suggestions-title">
          <div className="flex items-center gap-2">
            {duplicateState === 'loading' ? <LoaderCircle className="animate-spin text-amber-700 motion-reduce:animate-none" size={18} /> : <AlertTriangle className="text-amber-700" size={18} />}
            <h3 id="pos-duplicate-suggestions-title" className="font-semibold">Posibles clientes existentes</h3>
          </div>
          {duplicateState === 'loading' ? <p className="mt-2 text-sm text-amber-900">Revisando nombre, empresa, correo, telefono y RTN...</p> : null}
          {duplicateState === 'error' ? <p role="alert" className="mt-2 text-sm text-red-800">{duplicateMessage}</p> : null}
          <div className="mt-3 space-y-3">
            {duplicateSuggestions.map((suggestion) => (
              <article key={suggestion.customerId} className="rounded-lg border border-amber-200 bg-white p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold">{suggestion.displayName}</p>
                    <p className="mt-1 text-xs text-black/60">{[suggestion.businessName, suggestion.phoneMasked, suggestion.emailMasked, suggestion.taxIdMasked].filter(Boolean).join(' · ')}</p>
                    <p className="mt-2 text-xs font-semibold text-amber-900">{posCustomerMatchLabel(suggestion.matchLevel, suggestion.matchedFields)}</p>
                    <p className="mt-1 text-xs text-black/55">{suggestion.hasPortalAccount ? 'Cuenta de portal vinculada' : 'Sin cuenta de portal'} · Origen: {posSourceLabel(suggestion.source)}</p>
                    {!suggestion.selectable ? <p className="mt-1 text-xs font-semibold text-red-800">Perfil suspendido - no disponible para ventas</p> : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button type="button" disabled={!suggestion.selectable} onClick={() => onSelectSuggestion(suggestion.customerId)} className="min-h-11 rounded-lg bg-[#e4252c] px-3 text-xs font-semibold text-white disabled:opacity-45">Usar cliente existente</button>
                    <Link href={`/admin/clientes?customerId=${encodeURIComponent(suggestion.customerId)}`} target="_blank" className="inline-flex min-h-11 items-center rounded-lg border border-black/15 bg-white px-3 text-xs font-semibold">Ver información</Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
          {exactBlocked ? <p className="mt-3 text-sm font-semibold text-red-800">La coincidencia exacta de correo o RTN no admite excepcion. Use o corrija el perfil existente.</p> : null}
          {phoneOverrideAvailable ? <div className="mt-3"><FormField label="Motivo para continuar con telefono compartido"><input minLength={5} maxLength={500} value={form.duplicateOverrideReason} onChange={field('duplicateOverrideReason')} className="pos-input" placeholder="Ejemplo: telefono familiar compartido" /></FormField></div> : null}
          {!exactBlocked && duplicateSuggestions.length > 0 && duplicateSuggestions.every((suggestion) => suggestion.matchLevel === 'probable') ? <p className="mt-3 text-sm text-amber-900">Encontramos perfiles parecidos. Puede continuar después de revisarlos.</p> : null}
        </section>
      ) : null}

      <fieldset className="mt-5 rounded-xl border border-black/10 p-4">
        <legend className="px-1 text-sm font-semibold">Tipo de cliente</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {(["retail", "wholesale"] as const).map((customerType) => <label key={customerType} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm font-semibold ${form.customerType === customerType ? "border-[#e4252c] bg-red-50" : "border-black/10"}`}><input type="radio" name="customerType" value={customerType} checked={form.customerType === customerType} onChange={() => onChange({ ...form, customerType })} className="size-4 accent-[#e4252c]" />{customerType === "retail" ? "Minorista" : "Mayorista"}</label>)}
        </div>
        <p className="mt-2 text-xs leading-5 text-black/50">{form.customerType === "wholesale" ? "Quedará aprobado y activo por el rol autorizado, con historial comercial." : "Usará precio detalle salvo un precio manual autorizado."}</p>
      </fieldset>

      <fieldset className="mt-4 rounded-xl border border-black/10 p-4">
        <legend className="px-1 text-sm font-semibold">Crédito comercial</legend>
        <label className="flex min-h-11 items-center gap-3 text-sm font-semibold"><input type="checkbox" checked={form.creditEnabled} onChange={(event) => onChange({ ...form, creditEnabled: event.target.checked })} className="size-5 accent-[#e4252c]" /> Habilitar crédito comercial</label>
        {form.creditEnabled ? <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <FormField label="Límite de crédito *"><input required type="number" inputMode="decimal" min="0.01" max="9999999999.99" step="0.01" value={form.creditLimit} onChange={field("creditLimit")} className="pos-input" /></FormField>
          <FormField label="Plazo en días *"><input required type="number" inputMode="numeric" min="1" max="365" step="1" value={form.creditTermsDays} onChange={field("creditTermsDays")} className="pos-input" /></FormField>
          {mode === "edit" ? <FormField label="Estado"><select value={form.creditStatus} onChange={(event) => onChange({ ...form, creditStatus: event.target.value as "active" | "suspended" })} className="pos-input"><option value="active">Activo</option><option value="suspended">Suspendido</option></select></FormField> : null}
          <FormField label="Notas o condiciones" wide><textarea maxLength={1000} rows={2} value={form.creditNotes} onChange={field("creditNotes")} className="pos-input resize-y py-3" /></FormField>
        </div> : <p className="mt-1 text-xs text-black/50">{mode === "create" ? "No se creará una cuenta de crédito." : "Al guardar, el crédito existente quedará deshabilitado; el historial y las CxC no cambian."}</p>}
      </fieldset>
      {message ? <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-sm" role="status">{message}</p> : null}
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={onCancel} className="min-h-11 rounded-lg border border-black/15 px-4 py-2 text-sm font-semibold">Cancelar</button>
        <button type="submit" disabled={saving || !form.contactName.trim() || (mode === 'create' && (duplicateBlocksCreate || duplicateState !== 'idle'))} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#e4252c] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? <LoaderCircle size={18} className="animate-spin" /> : <UserRoundCheck size={18} />}{mode === "create" ? "Crear y seleccionar" : "Guardar configuración"}</button>
      </div>
    </form>
  );
}

function CustomerContextPanel({
  context,
  compact,
  message,
  onEdit,
  onClear,
}: {
  context: PosCustomerContext;
  compact: boolean;
  message: string;
  onEdit: () => void;
  onClear: () => void;
}) {
  return (
    <div>
      <div className={`flex flex-col gap-3 ${compact ? "" : "sm:flex-row sm:items-start sm:justify-between"}`}>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#e4252c]">Cliente seleccionado</p>
          <h2 className="mt-1 break-words text-2xl font-semibold">{context.displayName}</h2>
          <p className="mt-1 break-words text-sm text-black/55">{[context.businessName, context.phone, context.email].filter(Boolean).join(" · ")}</p>
        </div>
        <div className={`flex gap-2 ${compact ? "flex-wrap" : "shrink-0"}`}>
          <button type="button" onClick={onEdit} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-black/15 px-3 py-2 text-sm font-semibold hover:border-[#e4252c] hover:text-[#e4252c] ${compact ? "min-w-0 flex-1" : ""}`}><Pencil size={16} /> Editar configuración comercial</button>
          <button type="button" onClick={onClear} aria-label="Quitar cliente seleccionado" title="Quitar cliente" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-black/15 hover:border-[#e4252c] hover:text-[#e4252c]"><X size={17} /></button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${statusTone(context.wholesaleStatus)}`}>{statusLabel(context.wholesaleStatus)}</span>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${context.pricingMode === "wholesale" ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-slate-100 text-slate-700 ring-slate-200"}`}>Precio {context.pricingMode === "wholesale" ? "mayorista" : "minorista"}</span>
      </div>
      <p className="mt-3 rounded-lg bg-[#fafafa] px-3 py-2 text-sm leading-6 text-black/65">{context.pricingReason}</p>

      <div className={compact ? "mt-4 grid gap-3" : "mt-4 grid gap-3 md:grid-cols-2"}>
        <InfoCard icon={Link2} title="Portal" value={context.hasPortalAccount ? "Cuenta de portal vinculada" : "Sin cuenta de portal"} detail="Crear el perfil no habilita acceso al portal ni envía invitaciones.">
          {!context.hasPortalAccount ? <Link href="/admin/vincular-cuenta-cliente" className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-[#e4252c] hover:underline">Abrir vinculación administrativa</Link> : null}
        </InfoCard>
        <InfoCard icon={CreditCard} title="Crédito comercial" value={context.credit.status === "active" ? "Activo" : context.credit.status === "on_hold" ? "En espera" : context.credit.status === "suspended" ? "Suspendido" : "No habilitado"} detail={context.credit.reason}>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs"><Metric label="Límite" value={formatCurrency(context.credit.creditLimit)} /><Metric label="Disponible" value={formatCurrency(context.credit.availableCredit)} /><Metric label="Saldo abierto" value={formatCurrency(context.credit.openBalance)} /><Metric label="Vencido" value={formatCurrency(context.credit.overdueBalance)} /></div>
          <p className="mt-2 text-xs text-black/50">Plazo: {context.credit.termsDays} días{context.credit.notes ? ` · ${context.credit.notes}` : ""}</p>
        </InfoCard>
        <InfoCard icon={Building2} title="Resumen comercial" value={`${context.summary.orderCount.toLocaleString("es-HN")} pedidos`} detail={`${context.summary.invoiceCount.toLocaleString("es-HN")} facturas · ${formatCurrency(context.summary.totalBilled)} facturado`} />
        <InfoCard icon={ShieldCheck} title="Estado operativo" value={context.customerStatus === "active" ? "Activo" : "Inactivo"} detail="El estado se verificará nuevamente al confirmar." />
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
  return <div className="flex min-h-20 items-center gap-3 rounded-lg border border-black/10 bg-white p-3 text-black/45"><span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-slate-100"><Icon size={19} /></span><div><p className="font-semibold text-black/60">{title}</p><p className="text-xs">No disponible</p></div></div>;
}
