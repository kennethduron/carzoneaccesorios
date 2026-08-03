"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, LoaderCircle, PlusCircle, RefreshCw, ShoppingCart } from "lucide-react";
import { PosActiveDrafts } from "@/components/admin/pos-active-drafts";
import { PosCart } from "@/components/admin/pos-cart";
import { PosConfirmationPanel } from "@/components/admin/pos-confirmation-panel";
import { PosCustomerWorkspace } from "@/components/admin/pos-customer-workspace";
import { PosDeliveryFields, type PosDeliveryState } from "@/components/admin/pos-delivery-fields";
import { PosDraftStatus, type PosSaveState } from "@/components/admin/pos-draft-status";
import { PosDraftSummary } from "@/components/admin/pos-draft-summary";
import { PosProductSearch } from "@/components/admin/pos-product-search";
import { validatePosQuantity } from "@/lib/pos/cart-quantity";
import type { PosConfirmationResult, PosCustomerContext } from "@/types/point-of-sale";
import type { PosActiveDraftSummary, PosChargeCapabilities, PosDraftApiError, PosDraftItem, PosProductSearchResult, PosSaleDraft } from "@/types/pos-drafts";
import { formatCurrency } from "@/utils/pricing";

const storedDraftKey = "car-zone-pos-stage4-draft-id";
const emptyDelivery: PosDeliveryState = { mode: "store_immediate", address: "", notes: "", internalNotes: "" };
const noCharges: PosChargeCapabilities = { shippingFeeEnabled: false, codFeeEnabled: false, externalChargeEnabled: false, otherChargeEnabled: false, disabledReason: "Los cargos requieren configuracion contable activa." };

class PosApiError extends Error {
  constructor(message: string, readonly code: string, readonly currentVersion?: number) { super(message); this.name = "PosApiError"; }
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & Partial<PosDraftApiError>;
  if (!response.ok) throw new PosApiError(payload.message || "No se pudo completar la solicitud.", payload.code || "POS_REQUEST_FAILED", payload.currentVersion);
  return payload;
}

function draftDelivery(draft: PosSaleDraft): PosDeliveryState {
  return { mode: draft.deliveryMode, address: draft.deliveryAddress ?? "", notes: draft.deliveryNotes ?? "", internalNotes: draft.internalNotes ?? "" };
}

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
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const pendingSaveKeyRef = useRef<string | null>(null);
  const pendingAbandonKeyRef = useRef<string | null>(null);
  const changeRevisionRef = useRef(0);
  const cartPanelRef = useRef<HTMLDivElement | null>(null);

  const applyDraft = useCallback((next: PosSaleDraft, recoveredMessage = "") => {
    if (next.status !== "active") {
      window.sessionStorage.removeItem(storedDraftKey);
      setDraft(null); setItems([]); setDelivery(emptyDelivery); setStatus("error"); setMessage("El borrador ya no esta activo.");
      return;
    }
    dirtyRef.current = false; setIsDirty(false); pendingSaveKeyRef.current = null;
    changeRevisionRef.current = 0;
    setDraft(next); setItems(next.items); setDelivery(draftDelivery(next));
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
    if (dirtyRef.current && !window.confirm("Hay cambios pendientes. Recargar otro borrador los descartara. Continuar?")) return;
    try {
      const recovered = await jsonResponse<PosSaleDraft>(await fetch(`/api/admin/pos/drafts/${draftId}`, { headers: { Accept: "application/json" }, cache: "no-store" }));
      if (recovered.status === "confirmed") {
        const confirmation = await jsonResponse<PosConfirmationResult>(await fetch(`/api/admin/pos/drafts/${draftId}/confirm`, { headers: { Accept: "application/json" }, cache: "no-store" }));
        dirtyRef.current = false; setIsDirty(false); setDraft(recovered); setItems(recovered.items);
        setDelivery(draftDelivery(recovered)); setSelectedCustomerId(recovered.customerId);
        setConfirmedResult(confirmation); setStatus("saved"); setMessage("Venta confirmada recuperada.");
        window.sessionStorage.removeItem(storedDraftKey);
        return;
      }
      applyDraft(recovered, recoveredMessage);
    } catch (error) {
      window.sessionStorage.removeItem(storedDraftKey); setStatus("error");
      setMessage(error instanceof Error ? error.message : "No se pudo recuperar el borrador.");
    }
  }, [applyDraft]);

  useEffect(() => {
    void fetch("/api/admin/pos/capabilities", { headers: { Accept: "application/json" }, cache: "no-store" }).then((response) => jsonResponse<PosChargeCapabilities>(response)).then(setCapabilities).catch(() => setCapabilities(noCharges));
    const timer = window.setTimeout(() => {
      void loadActiveDrafts();
      const draftId = window.sessionStorage.getItem(storedDraftKey);
      if (draftId) void openDraft(draftId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadActiveDrafts, openDraft]);

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

  const acceptCustomer = useCallback((next: PosCustomerContext | null) => {
    if (!next) { if (!draft) { setCustomer(null); setSelectedCustomerId(null); } return; }
    if (draft && next.customerId !== draft.customerId) {
      if (!window.confirm("Cambiar el cliente recalculara precios y condiciones comerciales al guardar. Continuar?")) { setSelectedCustomerId(draft.customerId); return; }
      dirtyRef.current = true; setIsDirty(true); pendingSaveKeyRef.current = null; setStatus("dirty");
      changeRevisionRef.current += 1;
      setMessage("Cliente cambiado. Los precios base se resolveran nuevamente en el servidor.");
    } else if (draft && next.commercialVersion !== draft.customerCommercialVersion) {
      dirtyRef.current = true; setIsDirty(true); pendingSaveKeyRef.current = null; setStatus("dirty");
      changeRevisionRef.current += 1;
      setMessage("Las condiciones comerciales cambiaron. El servidor revalidara todo el carrito.");
    }
    setCustomer(next); setSelectedCustomerId(next.customerId);
  }, [draft]);

  async function createDraft() {
    if (!customer || creating || draft) return;
    setCreating(true); setMessage("");
    try {
      const created = await jsonResponse<PosSaleDraft>(await fetch("/api/admin/pos/drafts", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ requestKey: crypto.randomUUID(), customerId: customer.customerId }) }));
      applyDraft(created, "Borrador no economico creado."); await loadActiveDrafts();
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "No se pudo crear el borrador."); }
    finally { setCreating(false); }
  }

  const markItems = useCallback((next: PosDraftItem[]) => { setItems(next); changeRevisionRef.current += 1; dirtyRef.current = true; setIsDirty(true); pendingSaveKeyRef.current = null; setStatus(navigator.onLine ? "dirty" : "offline"); setMessage(""); }, []);
  const markDelivery = useCallback((next: PosDeliveryState) => { setDelivery(next); changeRevisionRef.current += 1; dirtyRef.current = true; setIsDirty(true); pendingSaveKeyRef.current = null; setStatus(navigator.onLine ? "dirty" : "offline"); setMessage(""); }, []);

  const saveDraft = useCallback(async () => {
    if (!draft || !customer || !dirtyRef.current || savingRef.current) return;
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
          deliveryMode: delivery.mode, deliveryAddress: delivery.address || null, deliveryNotes: delivery.notes || null, internalNotes: delivery.internalNotes || null }),
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

  async function abandonDraft() {
    if (!draft || !window.confirm("Abandonar este borrador? No se creara ninguna venta.")) return;
    const requestKey = pendingAbandonKeyRef.current ?? crypto.randomUUID(); pendingAbandonKeyRef.current = requestKey;
    try {
      await jsonResponse<PosSaleDraft>(await fetch(`/api/admin/pos/drafts/${draft.draftId}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestKey, expectedVersion: draft.version }) }));
      pendingAbandonKeyRef.current = null; window.sessionStorage.removeItem(storedDraftKey); dirtyRef.current = false; setIsDirty(false); setDraft(null); setItems([]); setDelivery(emptyDelivery); setStatus("idle"); setMessage("Borrador abandonado logicamente."); await loadActiveDrafts();
    } catch (error) { setStatus(error instanceof PosApiError && error.code === "PT409" ? "conflict" : "error"); setMessage(error instanceof Error ? error.message : "No se pudo abandonar."); }
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
  const provisionalTotal = provisional.merchandise + (draft?.shippingFee ?? 0) + (draft?.codFee ?? 0) + (draft?.otherCharge ?? 0);

  return <div className="min-w-0 space-y-4 pb-20 lg:pb-0">
    <section className="rounded-xl border border-black/10 bg-gradient-to-r from-white to-red-50 p-4 shadow-sm sm:p-5"><div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"><div><p className="text-sm font-semibold text-[#e4252c]">POS · Etapa 5</p><h1 className="text-2xl font-semibold">Venta atomica en tienda</h1><p className="mt-1 text-sm text-black/60">Pedido, factura, cobro, inventario y borradores contables se confirman en una sola operacion.</p></div><div className="flex flex-wrap items-center gap-2"><PosDraftStatus state={status} message={message} />{status === "conflict" && draft ? <button type="button" onClick={() => void openDraft(draft.draftId, "Version mas reciente cargada. Revisa antes de continuar.")} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-300 bg-white px-3 text-sm font-semibold text-red-800"><RefreshCw size={17} /> Recargar</button> : null}{draft?.status === "active" ? <button type="button" onClick={() => void abandonDraft()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-black/15 bg-white px-3 text-sm font-semibold"><Archive size={17} /> Abandonar</button> : null}</div></div></section>

    <PosCustomerWorkspace selectedCustomerId={selectedCustomerId} showFutureStages={false} onCustomerContextChange={acceptCustomer} />
    <PosActiveDrafts drafts={activeDrafts} currentDraftId={draft?.draftId} loading={loadingDrafts} onOpen={(draftId) => void openDraft(draftId)} />

    {!draft ? <section className="rounded-xl border border-dashed border-black/15 bg-white p-6 text-center"><h2 className="font-semibold">Inicia el borrador después de seleccionar el cliente</h2><p className="mt-1 text-sm text-black/55">El servidor fijará el modo de precio y la versión comercial.</p><button type="button" disabled={!customer || creating} onClick={() => void createDraft()} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#e4252c] px-4 text-sm font-semibold text-white disabled:opacity-50">{creating ? <LoaderCircle className="animate-spin motion-reduce:animate-none" size={18} /> : <PlusCircle size={18} />} Crear borrador</button></section>
      : confirmedResult && customer ? <PosConfirmationPanel draft={draft} customer={customer} disabled initialResult={confirmedResult} onConfirmed={acceptConfirmation} onNewSale={startNewSale} operatorName={operatorName} />
      : <>
        <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)]">
          <div className="min-w-0 space-y-4">
            <PosProductSearch disabled={!compatibleCustomer || status === "conflict"} customerId={draft.customerId} customerCommercialVersion={draft.customerCommercialVersion} onAdd={addProduct} />
            <PosDeliveryFields value={delivery} capabilities={capabilities} onChange={markDelivery} />
          </div>
          <div ref={cartPanelRef} className="min-w-0 scroll-mt-4 space-y-4 lg:sticky lg:top-4 lg:flex lg:max-h-[calc(100vh-2rem)] lg:flex-col lg:gap-4 lg:space-y-0">
            <div className="lg:min-h-0 lg:overflow-y-auto lg:rounded-xl"><PosCart items={items} onChange={markItems} onClear={() => markItems([])} /></div>
            <PosDraftSummary draft={draft} pending={isDirty} merchandiseGross={provisional.merchandise} taxableGross={provisional.taxable} taxableBase={provisional.taxableBase} taxAmount={provisional.tax} exemptGross={provisional.exempt} disabled={!isDirty || status === "saving" || status === "conflict" || !customer} onSave={() => void saveDraft()} />
            {customer ? <PosConfirmationPanel draft={draft} customer={customer} disabled={isDirty || status !== "saved" || items.length === 0 || !compatibleCustomer} onConfirmed={acceptConfirmation} onNewSale={startNewSale} operatorName={operatorName} /> : null}
          </div>
        </div>
        <button type="button" onClick={() => cartPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} className="fixed inset-x-4 bottom-4 z-40 flex min-h-12 items-center justify-between rounded-xl bg-black px-4 text-sm font-semibold text-white shadow-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e4252c] lg:hidden" aria-label={`Ver carrito, ${cartUnits} unidades, total ${formatCurrency(provisionalTotal)}`}>
          <span className="inline-flex items-center gap-2"><ShoppingCart size={19} /> Ver carrito ({cartUnits})</span>
          <span>{formatCurrency(provisionalTotal)}</span>
        </button>
      </>}
  </div>;
}
