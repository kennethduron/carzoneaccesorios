"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, LoaderCircle, PlusCircle, RefreshCw, ShoppingCart } from "lucide-react";
import { PosActiveDrafts } from "@/components/admin/pos-active-drafts";
import { PosCart } from "@/components/admin/pos-cart";
import { PosConfirmationDialog } from "@/components/admin/pos-confirmation-dialog";
import { PosConfirmationPanel } from "@/components/admin/pos-confirmation-panel";
import { PosCustomerWorkspace } from "@/components/admin/pos-customer-workspace";
import { PosDeliveryFields, type PosDeliveryState } from "@/components/admin/pos-delivery-fields";
import { PosDraftStatus, type PosSaveState } from "@/components/admin/pos-draft-status";
import { PosDraftSummary } from "@/components/admin/pos-draft-summary";
import { POS_OPERATIONAL_COLUMN_CLASS, POS_PRODUCT_COLUMN_CLASS, POS_SUMMARY_COLUMN_CLASS, POS_WORKSPACE_GRID_CLASS } from "@/components/admin/pos-layout";
import { PosMobileTotalBar } from "@/components/admin/pos-mobile-total-bar";
import { PosProductSearch } from "@/components/admin/pos-product-search";
import { validatePosQuantity } from "@/lib/pos/cart-quantity";
import type { PosConfirmationResult, PosCustomerContext } from "@/types/point-of-sale";
import type { PosActiveDraftSummary, PosChargeCapabilities, PosDraftApiError, PosDraftItem, PosProductSearchResult, PosSaleDraft } from "@/types/pos-drafts";

const storedDraftKey = "car-zone-pos-stage4-draft-id";
const emptyDelivery: PosDeliveryState = { mode: 'store_immediate', address: '', notes: '', internalNotes: '', shippingFee: '0.00', codFee: '0.00', additionalCharge: '0.00', additionalChargeDescription: '', otherCharge: '0.00', otherChargeDescription: '' };
const noCharges: PosChargeCapabilities = { shippingFeeEnabled: false, codFeeEnabled: false, additionalChargeEnabled: false, externalChargeEnabled: false, otherChargeEnabled: false, disabledReason: 'Los cargos requieren configuración contable activa.' };

class PosApiError extends Error {
  constructor(message: string, readonly code: string, readonly currentVersion?: number) { super(message); this.name = "PosApiError"; }
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & Partial<PosDraftApiError>;
  if (!response.ok) throw new PosApiError(payload.message || "No se pudo completar la solicitud.", payload.code || "POS_REQUEST_FAILED", payload.currentVersion);
  return payload;
}

function draftDelivery(draft: PosSaleDraft): PosDeliveryState {
  return { mode: draft.deliveryMode, address: draft.deliveryAddress ?? '', notes: draft.deliveryNotes ?? '', internalNotes: draft.internalNotes ?? '', shippingFee: draft.shippingFee.toFixed(2), codFee: draft.codFee.toFixed(2), additionalCharge: draft.additionalCharge.toFixed(2), additionalChargeDescription: draft.additionalChargeDescription ?? '', otherCharge: draft.otherCharge.toFixed(2), otherChargeDescription: draft.otherChargeDescription ?? '' };
}

function validChargeInputs(value: PosDeliveryState) {
  const validAmounts = [value.shippingFee, value.codFee, value.additionalCharge, value.otherCharge].every((raw) => {
    if (!raw.trim()) return true;
    const amount = Number(raw);
    return Number.isFinite(amount) && amount >= 0 && amount <= 999_999_999_999.99 && /^\d+(?:\.\d{0,2})?$/.test(raw.trim());
  });
  const descriptionValid = (amount: string, description: string) => Number(amount || 0) <= 0
    || (description.trim().length >= 2 && description.trim().length <= 120 && !/[<>\r\n\t]/.test(description));
  return validAmounts
    && descriptionValid(value.additionalCharge, value.additionalChargeDescription)
    && descriptionValid(value.otherCharge, value.otherChargeDescription);
}

type WorkspaceDialog =
  | { kind: "open-draft"; draftId: string; recoveredMessage: string }
  | { kind: "abandon" }
  | { kind: "change-customer"; customer: PosCustomerContext | null };

export function PosWorkspace({ operatorName }: { operatorName: string }) {
  const [customer, setCustomer] = useState<PosCustomerContext | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PosSaleDraft | null>(null);
  const [confirmedResult, setConfirmedResult] = useState<PosConfirmationResult | null>(null);
  const [items, setItems] = useState<PosDraftItem[]>([]);
  const [delivery, setDelivery] = useState<PosDeliveryState>(emptyDelivery);
  const [status, setStatus] = useState<PosSaveState>("idle");
  const [isDirty, setIsDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [capabilities, setCapabilities] = useState<PosChargeCapabilities | null>(null);
  const [activeDrafts, setActiveDrafts] = useState<PosActiveDraftSummary[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(true);
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialog | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const pendingSaveKeyRef = useRef<string | null>(null);
  const pendingAbandonKeyRef = useRef<string | null>(null);
  const changeRevisionRef = useRef(0);
  const draftRequestRevisionRef = useRef(0);
  const operationLockRef = useRef(false);
  const cartPanelRef = useRef<HTMLDivElement | null>(null);

  const applyDraft = useCallback((next: PosSaleDraft, recoveredMessage = "") => {
    if (next.status !== "active") {
      window.sessionStorage.removeItem(storedDraftKey);
      setDraft(null); setItems([]); setDelivery(emptyDelivery); setStatus("error"); setMessage("El borrador ya no está activo.");
      return;
    }
    dirtyRef.current = false; setIsDirty(false); pendingSaveKeyRef.current = null;
    changeRevisionRef.current = 0;
    setDraft(next); setItems(next.items); setDelivery(draftDelivery(next));
    setCustomer((current) => next.customerId === current?.customerId && next.customerCommercialVersion === current.commercialVersion ? current : null);
    setConfirmedResult(null);
    setSelectedCustomerId(next.customerId); setStatus("saved"); setMessage(recoveredMessage);
    window.sessionStorage.setItem(storedDraftKey, next.draftId);
  }, []);

  const loadActiveDrafts = useCallback(async () => {
    setLoadingDrafts(true);
    try {
      const payload = await jsonResponse<{ drafts: PosActiveDraftSummary[] }>(await fetch("/api/admin/pos/drafts?limit=20&offset=0", { headers: { Accept: "application/json" }, cache: "no-store" }));
      setActiveDrafts(payload.drafts);
    } catch { setActiveDrafts([]); }
    finally { setLoadingDrafts(false); }
  }, []);

  const openDraft = useCallback(async (draftId: string, recoveredMessage = "Borrador recuperado.") => {
    const requestRevision = ++draftRequestRevisionRef.current;
    try {
      const recovered = await jsonResponse<PosSaleDraft>(await fetch(`/api/admin/pos/drafts/${draftId}`, { headers: { Accept: "application/json" }, cache: "no-store" }));
      if (requestRevision !== draftRequestRevisionRef.current) return;
      if (recovered.status === "confirmed") {
        const confirmation = await jsonResponse<PosConfirmationResult>(await fetch(`/api/admin/pos/drafts/${draftId}/confirm`, { headers: { Accept: "application/json" }, cache: "no-store" }));
        if (requestRevision !== draftRequestRevisionRef.current) return;
        dirtyRef.current = false; setIsDirty(false); setDraft(recovered); setItems(recovered.items);
        setDelivery(draftDelivery(recovered)); setSelectedCustomerId(recovered.customerId);
        setConfirmedResult(confirmation); setStatus("saved"); setMessage("Venta confirmada recuperada.");
        window.sessionStorage.removeItem(storedDraftKey);
        return;
      }
      applyDraft(recovered, recoveredMessage);
    } catch (error) {
      if (requestRevision !== draftRequestRevisionRef.current) return;
      window.sessionStorage.removeItem(storedDraftKey); setStatus("error");
      setMessage(error instanceof Error ? error.message : "No se pudo recuperar el borrador.");
    }
  }, [applyDraft]);

  const requestOpenDraft = useCallback((draftId: string, recoveredMessage = "Borrador recuperado.") => {
    if (dirtyRef.current) {
      setWorkspaceDialog({ kind: "open-draft", draftId, recoveredMessage });
      return;
    }
    void openDraft(draftId, recoveredMessage);
  }, [openDraft]);

  useEffect(() => {
    void fetch("/api/admin/pos/capabilities", { headers: { Accept: "application/json" }, cache: "no-store" }).then((response) => jsonResponse<PosChargeCapabilities>(response)).then(setCapabilities).catch(() => setCapabilities(noCharges));
    const timer = window.setTimeout(() => {
      void loadActiveDrafts();
      const draftId = window.sessionStorage.getItem(storedDraftKey);
      if (draftId) requestOpenDraft(draftId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadActiveDrafts, requestOpenDraft]);

  useEffect(() => {
    const offline = () => { if (dirtyRef.current) setStatus("offline"); };
    const online = () => { if (dirtyRef.current) setStatus("dirty"); };
    window.addEventListener("offline", offline); window.addEventListener("online", online);
    return () => { window.removeEventListener("offline", offline); window.removeEventListener("online", online); };
  }, []);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (dirtyRef.current) event.preventDefault(); };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setKeyboardOpen(window.innerHeight - viewport.height > 150);
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  const acceptCustomer = useCallback((next: PosCustomerContext | null) => {
    if (!next) {
      if (!draft) {
        draftRequestRevisionRef.current += 1;
        setCustomer(null);
        setSelectedCustomerId(null);
        setMessage("");
        return;
      }
      setWorkspaceDialog({ kind: "change-customer", customer: null });
      return;
    }
    if (draft && next.customerId !== draft.customerId) {
      setWorkspaceDialog({ kind: "change-customer", customer: next });
      return;
    } else if (draft && next.commercialVersion !== draft.customerCommercialVersion) {
      dirtyRef.current = true; setIsDirty(true); pendingSaveKeyRef.current = null; setStatus("dirty");
      changeRevisionRef.current += 1;
      setMessage("Las condiciones comerciales cambiaron. Revise los productos y precios antes de continuar.");
    }
    setCustomer(next); setSelectedCustomerId(next.customerId);
  }, [draft]);

  async function createDraft() {
    if (!customer || creating || draft) return;
    setCreating(true); setMessage("");
    try {
      const created = await jsonResponse<PosSaleDraft>(await fetch("/api/admin/pos/drafts", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ requestKey: crypto.randomUUID(), customerId: customer.customerId }) }));
      applyDraft(created, "Venta en preparación creada."); await loadActiveDrafts();
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "No se pudo crear el borrador."); }
    finally { setCreating(false); }
  }

  const markItems = useCallback((next: PosDraftItem[]) => { setItems(next); changeRevisionRef.current += 1; dirtyRef.current = true; setIsDirty(true); pendingSaveKeyRef.current = null; setStatus(navigator.onLine ? "dirty" : "offline"); setMessage(""); }, []);
  const markDelivery = useCallback((next: PosDeliveryState) => { setDelivery(next); changeRevisionRef.current += 1; dirtyRef.current = true; setIsDirty(true); pendingSaveKeyRef.current = null; setStatus(navigator.onLine ? "dirty" : "offline"); setMessage(""); }, []);

  const saveDraft = useCallback(async () => {
    if (!draft || !customer || !dirtyRef.current || savingRef.current || operationLockRef.current) return;
    if (!validChargeInputs(delivery)) { setStatus('error'); setMessage('Corrija los cargos: deben ser montos no negativos con máximo dos decimales.'); return; }
    if (!navigator.onLine) { setStatus("offline"); return; }
    savingRef.current = true; setStatus("saving");
    const savingRevision = changeRevisionRef.current;
    const requestKey = pendingSaveKeyRef.current ?? crypto.randomUUID();
    pendingSaveKeyRef.current = requestKey;
    try {
      const saved = await jsonResponse<PosSaleDraft>(await fetch(`/api/admin/pos/drafts/${draft.draftId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ requestKey, expectedVersion: draft.version, customerId: customer.customerId, expectedCustomerCommercialVersion: customer.commercialVersion,
          items: items.map((item) => ({ productId: item.productId, quantity: item.quantity, finalUnitPrice: item.priceOverridden ? item.finalUnitPrice : null, priceOverrideReason: item.priceOverridden ? item.priceOverrideReason : null, expectedProductSalesVersion: item.productSalesVersion })),
          deliveryMode: delivery.mode, deliveryAddress: delivery.address || null, deliveryNotes: delivery.notes || null, internalNotes: delivery.internalNotes || null,
          shippingFee: Number(delivery.shippingFee || 0), codFee: Number(delivery.codFee || 0), additionalCharge: Number(delivery.additionalCharge || 0), additionalChargeDescription: delivery.additionalChargeDescription.trim() || null, otherCharge: Number(delivery.otherCharge || 0), otherChargeDescription: delivery.otherChargeDescription.trim() || null }),
      }));
      pendingSaveKeyRef.current = null;
      if (changeRevisionRef.current === savingRevision) {
        dirtyRef.current = false;
        applyDraft(saved, saved.validationStatus === "warning" ? "Guardado con advertencias que deben revisarse antes del cierre." : "Borrador guardado.");
      } else {
        setDraft(saved);
        dirtyRef.current = true;
        setIsDirty(true);
        setStatus(navigator.onLine ? "dirty" : "offline");
        setMessage("Hay cambios adicionales pendientes de guardar.");
      }
      await loadActiveDrafts();
    } catch (error) {
      if (error instanceof PosApiError && error.code === "PT409") { setStatus("conflict"); setMessage(`Otra sesion guardo primero${error.currentVersion ? ` (version ${error.currentVersion})` : ""}. Recarga para comparar.`); }
      else if (!navigator.onLine || error instanceof TypeError) { setStatus("offline"); setMessage("Sin conexion. Los cambios siguen pendientes; reintenta al volver."); }
      else { setStatus("error"); setMessage(error instanceof Error ? error.message : "No se pudo guardar."); }
    } finally { savingRef.current = false; }
  }, [applyDraft, customer, delivery, draft, items, loadActiveDrafts]);

  useEffect(() => {
    if (!draft || !customer || !dirtyRef.current || status !== "dirty") return;
    const timer = window.setTimeout(() => void saveDraft(), 750);
    return () => window.clearTimeout(timer);
  }, [customer, delivery, draft, items, saveDraft, status]);

  function addProduct(product: PosProductSearchResult) {
    if (!draft) return;
    const existing = items.find((item) => item.productId === product.productId);
    if (existing) {
      const quantity = validatePosQuantity(existing, existing.quantity + 1);
      if (!quantity.ok) {
        setMessage(`No hay más existencias disponibles de ${existing.productName}.`);
        setStatus("error");
        return;
      }
      markItems(items.map((item) => item.productId === product.productId ? { ...item, quantity: quantity.quantity } : item));
      return;
    }
    if (!validatePosQuantity(product, 1).ok) {
      setMessage(`${product.productName} no tiene existencias disponibles.`);
      setStatus("error");
      return;
    }
    const now = new Date().toISOString();
    markItems([...items, { productId: product.productId, productSalesVersion: product.productSalesVersion, sku: product.sku, internalCode: product.internalCode, productName: product.productName, brand: product.brand, categoryName: product.categoryName, imageUrl: product.imageUrl, pricingSource: product.pricingSource, baseUnitPrice: product.baseUnitPrice, finalUnitPrice: product.baseUnitPrice, priceOverridden: false, priceOverrideReason: null, quantity: 1, taxCategory: product.taxCategory, includedTaxRate: product.includedTaxRate, lineMerchandiseGross: product.baseUnitPrice, lineTaxableBase: 0, lineTaxAmount: 0, lineExemptAmount: product.taxCategory === "exempt" ? product.baseUnitPrice : 0, availableStock: product.availableStock, tracksInventory: product.tracksInventory, stockObservedAt: now, stockStatus: product.tracksInventory === false ? "available" : product.availableStock <= 0 ? "insufficient" : product.availableStock <= product.lowStockThreshold ? "low" : "available", validationStatus: product.tracksInventory === false || product.availableStock > 0 ? "valid" : "warning", costFloorValidated: false, costValidationVersion: 1, costValidatedAt: now }]);
  }

  async function abandonDraft(nextCustomer?: PosCustomerContext | null) {
    if (!draft || operationPending) return;
    if (savingRef.current) {
      setMessage("Espere a que termine el guardado antes de abandonar esta venta.");
      return;
    }
    operationLockRef.current = true;
    setOperationPending(true);
    const requestKey = pendingAbandonKeyRef.current ?? crypto.randomUUID(); pendingAbandonKeyRef.current = requestKey;
    try {
      await jsonResponse<PosSaleDraft>(await fetch(`/api/admin/pos/drafts/${draft.draftId}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestKey, expectedVersion: draft.version }) }));
      draftRequestRevisionRef.current += 1;
      changeRevisionRef.current += 1;
      pendingAbandonKeyRef.current = null;
      window.sessionStorage.removeItem(storedDraftKey);
      dirtyRef.current = false;
      setIsDirty(false);
      setDraft(null);
      setItems([]);
      setDelivery(emptyDelivery);
      setStatus("idle");
      setMessage("La venta en preparación fue descartada.");
      if (workspaceDialog?.kind === "change-customer") {
        setCustomer(nextCustomer ?? null);
        setSelectedCustomerId(nextCustomer?.customerId ?? null);
      }
      setWorkspaceDialog(null);
      await loadActiveDrafts();
    } catch (error) { setStatus(error instanceof PosApiError && error.code === "PT409" ? "conflict" : "error"); setMessage(error instanceof Error ? error.message : "No se pudo abandonar."); }
    finally {
      operationLockRef.current = false;
      setOperationPending(false);
    }
  }

  function acceptConfirmation(result: PosConfirmationResult) {
    dirtyRef.current = false;
    setIsDirty(false);
    setConfirmedResult(result);
    setStatus("saved");
    setMessage(result.replayed ? "Venta confirmada recuperada." : "Venta confirmada sin efectos duplicados.");
    window.sessionStorage.removeItem(storedDraftKey);
    void loadActiveDrafts();
  }

  function startNewSale() {
    dirtyRef.current = false;
    setIsDirty(false);
    setDraft(null);
    setConfirmedResult(null);
    setCustomer(null);
    setSelectedCustomerId(null);
    setItems([]);
    setDelivery(emptyDelivery);
    setStatus("idle");
    setMessage("Lista para una nueva venta.");
    pendingSaveKeyRef.current = null;
    pendingAbandonKeyRef.current = null;
    window.sessionStorage.removeItem(storedDraftKey);
  }

  const provisional = useMemo(() => items.reduce((totals, item) => {
    const gross = Math.round(item.quantity * item.finalUnitPrice * 100) / 100;
    totals.merchandise += gross;
    if (item.taxCategory === "exempt") totals.exempt += gross;
    else {
      const base = Math.round((gross / (1 + item.includedTaxRate)) * 100) / 100;
      totals.taxable += gross; totals.taxableBase += base; totals.tax += gross - base;
    }
    return totals;
  }, { merchandise: 0, taxable: 0, taxableBase: 0, tax: 0, exempt: 0 }), [items]);
  const compatibleCustomer = Boolean(customer && draft?.customerId === customer.customerId && draft.customerCommercialVersion === customer.commercialVersion);
  const cartUnits = items.reduce((sum, item) => sum + item.quantity, 0);
  const provisionalCharges = Math.round(([delivery.shippingFee, delivery.codFee, delivery.additionalCharge, delivery.otherCharge]
    .reduce((sum, value) => sum + (Number.isFinite(Number(value)) ? Number(value) : 0), 0)) * 100) / 100;
  const provisionalTotal = Math.round((provisional.merchandise + provisionalCharges) * 100) / 100;

  return <div className="min-w-0 space-y-3 pb-[calc(6rem+env(safe-area-inset-bottom))] min-[800px]:pb-0">
    <section data-testid="pos-sale-toolbar" className="rounded-xl border border-black/10 bg-white p-3 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-red-50 text-[#e4252c]"><PlusCircle size={20} /></span><div className="min-w-0"><h2 className="font-semibold text-[#e4252c]">Nueva venta</h2><p className="truncate text-sm text-black/55">Agregue productos, revise los totales y seleccione el método de pago.</p></div></div><div className="flex min-w-0 flex-wrap items-center justify-end gap-2"><PosDraftStatus state={status} message={message} />{status === "conflict" && draft ? <button type="button" onClick={() => requestOpenDraft(draft.draftId, "Se cargó la información más reciente. Revísela antes de continuar.")} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-300 bg-white px-3 text-sm font-semibold text-red-800"><RefreshCw size={17} /> Recargar</button> : null}{draft?.status === "active" ? <button type="button" onClick={() => setWorkspaceDialog({ kind: "abandon" })} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-200 bg-white px-3 text-sm font-semibold text-red-700"><Archive size={17} /> Abandonar</button> : null}</div></div></section>

    <PosActiveDrafts drafts={activeDrafts} currentDraftId={draft?.draftId} loading={loadingDrafts} onOpen={(draftId) => requestOpenDraft(draftId)} />

    {!draft ? <div className="grid min-w-0 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.34fr)]">
      <PosCustomerWorkspace compact selectedCustomerId={selectedCustomerId} showFutureStages={false} onCustomerContextChange={acceptCustomer} />
      <section className="rounded-xl border border-black/10 bg-white p-4 shadow-sm xl:sticky xl:top-4"><div className="flex items-start gap-3"><ShoppingCart className="mt-0.5 shrink-0 text-[#e4252c]" size={22} /><div><h2 className="font-semibold">{customer ? "Cliente listo" : "Prepare una nueva venta"}</h2><p className="mt-1 text-sm leading-5 text-black/55">{customer ? "Inicie el borrador con las condiciones comerciales seleccionadas." : "Seleccione un cliente para habilitar productos y precios."}</p></div></div><button type="button" disabled={!customer || creating} onClick={() => void createDraft()} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#e4252c] px-4 text-sm font-semibold text-white disabled:opacity-50">{creating ? <LoaderCircle className="animate-spin motion-reduce:animate-none" size={18} /> : <PlusCircle size={18} />} Preparar venta</button></section>
    </div>
      : confirmedResult && customer ? <div className="grid items-start gap-4 xl:grid-cols-[minmax(340px,0.8fr)_minmax(0,1.2fr)]"><PosCustomerWorkspace compact selectedCustomerId={selectedCustomerId} showFutureStages={false} onCustomerContextChange={acceptCustomer} /><PosConfirmationPanel draft={draft} customer={customer} disabled initialResult={confirmedResult} onConfirmed={acceptConfirmation} onNewSale={startNewSale} operatorName={operatorName} /></div>
      : <>
        <div data-testid="pos-workspace-grid" className={POS_WORKSPACE_GRID_CLASS}>
          <div className={POS_OPERATIONAL_COLUMN_CLASS}>
          <div className="min-w-0"><PosCustomerWorkspace compact selectedCustomerId={selectedCustomerId} showFutureStages={false} onCustomerContextChange={acceptCustomer} /></div>
          <div className={POS_PRODUCT_COLUMN_CLASS}>
            <PosProductSearch disabled={!compatibleCustomer || status === "conflict"} customerId={draft.customerId} customerCommercialVersion={draft.customerCommercialVersion} onAdd={addProduct} />
            <PosCart items={items} onChange={markItems} onClear={() => markItems([])} />
            <PosDeliveryFields value={delivery} capabilities={capabilities} onChange={markDelivery} />
          </div>
          </div>
          <div id="pos-sale-summary" ref={cartPanelRef} className={POS_SUMMARY_COLUMN_CLASS}>
            <PosDraftSummary draft={draft} pending={isDirty} merchandiseGross={provisional.merchandise} taxableGross={provisional.taxable} taxableBase={provisional.taxableBase} taxAmount={provisional.tax} exemptGross={provisional.exempt} shippingFee={Number(delivery.shippingFee) || 0} codFee={Number(delivery.codFee) || 0} additionalCharge={Number(delivery.additionalCharge) || 0} additionalChargeDescription={delivery.additionalChargeDescription} otherCharge={Number(delivery.otherCharge) || 0} otherChargeDescription={delivery.otherChargeDescription} total={provisionalTotal} disabled={!isDirty || !validChargeInputs(delivery) || status === "saving" || status === "conflict" || !customer} onSave={() => void saveDraft()} />
            {customer ? <PosConfirmationPanel draft={draft} customer={customer} disabled={isDirty || status !== "saved" || items.length === 0 || !compatibleCustomer} onConfirmed={acceptConfirmation} onNewSale={startNewSale} operatorName={operatorName} /> : null}
          </div>
        </div>
        <PosMobileTotalBar unitCount={cartUnits} total={provisionalTotal} hidden={keyboardOpen} onReview={() => cartPanelRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })} />
      </>}
    {workspaceDialog ? <PosConfirmationDialog
      title={workspaceDialog.kind === "open-draft" ? "Descartar cambios" : workspaceDialog.kind === "abandon" ? "Abandonar borrador" : "Cambiar cliente"}
      description={workspaceDialog.kind === "open-draft"
        ? "Los cambios pendientes no se han guardado. Si continúa, se cargará el borrador seleccionado."
        : workspaceDialog.kind === "abandon"
          ? "El borrador dejará de estar disponible para continuar esta venta. No se generará pedido, factura, cobro ni movimiento de inventario."
          : items.length
            ? "El carrito actual pertenece a este cliente. Para evitar precios, crédito o historial incorrectos, debe conservarlo o abandonar el borrador antes de seleccionar otro cliente."
            : "Este borrador está asociado al cliente actual. ¿Desea abandonarlo y quitar el cliente?"}
      confirmLabel={workspaceDialog.kind === "open-draft" ? "Cargar borrador" : workspaceDialog.kind === "change-customer" ? "Abandonar borrador y quitar cliente" : "Abandonar borrador"}
      cancelLabel={workspaceDialog.kind === "open-draft" ? "Volver" : workspaceDialog.kind === "change-customer" ? "Continuar con este cliente" : "Volver"}
      pending={operationPending}
      onCancel={() => setWorkspaceDialog(null)}
      onConfirm={() => {
        if (workspaceDialog.kind === "open-draft") {
          dirtyRef.current = false;
          setIsDirty(false);
          setWorkspaceDialog(null);
          void openDraft(workspaceDialog.draftId, workspaceDialog.recoveredMessage);
        } else {
          void abandonDraft(workspaceDialog.kind === "change-customer" ? workspaceDialog.customer : undefined);
        }
      }}
    /> : null}
  </div>;
}
