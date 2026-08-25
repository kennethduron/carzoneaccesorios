"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import {
  cancelPurchaseAction,
  confirmPurchaseAction,
  registerPurchaseReturnAction,
  savePurchaseAction,
  type PurchaseConfirmationInput,
} from "@/app/admin/compras/actions";
import { PurchaseConfirmationDialog } from "@/components/admin/purchase-confirmation-dialog";
import {
  PurchaseCreateEditWorkspace,
  PurchaseDetail,
  PurchasesBrowser,
  SupplierReturnWorkspace,
  type PurchaseDraft,
  type PurchaseLineDraft,
  type PurchaseReturnDraft,
} from "@/components/admin/purchases-responsive-ui";
import {
  filterAdminPurchases,
  isPurchaseReturnEligible,
  resolveInitialPurchaseSelection,
  type PurchaseSelectionNotice,
  type PurchaseStatusFilter,
} from "@/components/admin/purchases-responsive-state";
import { useToast } from "@/contexts/toast-context";
import type { PurchaseProductSearchResult } from "@/types/admin-search";
import type { AdminPurchase, PurchasesSummary, SupplierOption } from "@/types/purchases";
import { formatCurrency } from "@/utils/pricing";

type WorkspaceMode = "browse" | "create" | "edit" | "return";

function todayValue() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(new Date());
}

function newLine(): PurchaseLineDraft {
  return { key: crypto.randomUUID(), product_id: "", description: "", quantity: 1, unit_cost: 0, tax_amount: 0, discount_amount: 0 };
}

function emptyDraft(): PurchaseDraft {
  return { supplier_id: "", purchase_number: "", purchase_date: todayValue(), shipping_amount: 0, currency: "HNL", notes: "", items: [newLine()] };
}

function emptyReturnDraft(purchaseId = ""): PurchaseReturnDraft {
  return { purchase_id: purchaseId, return_number: "", return_date: todayValue(), amount: "", reason: "" };
}

function purchaseToDraft(purchase: AdminPurchase): PurchaseDraft {
  return {
    id: purchase.id,
    supplier_id: purchase.supplier_id,
    purchase_number: purchase.purchase_number,
    purchase_date: purchase.purchase_date,
    shipping_amount: purchase.shipping_amount,
    currency: purchase.currency,
    notes: purchase.notes ?? "",
    items: purchase.items.length > 0
      ? purchase.items.map((item) => ({
          ...item,
          key: item.id,
          product_id: item.product_id ?? "",
          selectedProduct: item.product_id
            ? {
                id: item.product_id,
                sku: item.product_sku ?? "Producto",
                internalCode: null,
                name: item.product_name ?? item.description,
                brand: "",
                unit: null,
                status: "active",
                isActive: true,
                availableStock: 0,
                costPrice: item.unit_cost,
              }
            : null,
        }))
      : [newLine()],
  };
}

function draftSignature(draft: PurchaseDraft) {
  return JSON.stringify({
    id: draft.id ?? null,
    supplier_id: draft.supplier_id,
    purchase_number: draft.purchase_number,
    purchase_date: draft.purchase_date,
    shipping_amount: String(draft.shipping_amount ?? ""),
    currency: draft.currency,
    notes: draft.notes ?? "",
    items: draft.items.map((line) => ({
      id: line.id ?? null,
      product_id: line.product_id ?? "",
      description: line.description,
      quantity: String(line.quantity ?? ""),
      unit_cost: String(line.unit_cost ?? ""),
      tax_amount: String(line.tax_amount ?? ""),
      discount_amount: String(line.discount_amount ?? ""),
    })),
  });
}

function returnSignature(draft: PurchaseReturnDraft) {
  return JSON.stringify({ purchase_id: draft.purchase_id, return_number: draft.return_number, return_date: draft.return_date, amount: String(draft.amount ?? ""), reason: draft.reason ?? "" });
}

function replacePurchaseUrl(purchaseId: string | null) {
  const url = new URL(window.location.href);
  if (purchaseId) url.searchParams.set("purchaseId", purchaseId);
  else url.searchParams.delete("purchaseId");
  window.history.replaceState(window.history.state, "", url);
}

export function PurchasesManager({ purchases, suppliers, summary, canManage, purchaseApAutomationEnabled, initialPurchaseId = null }: {
  purchases: AdminPurchase[];
  suppliers: SupplierOption[];
  summary: PurchasesSummary;
  canManage: boolean;
  purchaseApAutomationEnabled: boolean;
  initialPurchaseId?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const initialSelection = useMemo(() => resolveInitialPurchaseSelection(purchases, initialPurchaseId), [initialPurchaseId, purchases]);
  const [query, setQuery] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<PurchaseStatusFilter>("active");
  const [selectedId, setSelectedId] = useState<string | null>(initialSelection.selectedId);
  const [selectionNotice, setSelectionNotice] = useState<PurchaseSelectionNotice>(initialSelection.notice);
  const [compactDetailOpen, setCompactDetailOpen] = useState(Boolean(initialPurchaseId));
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("browse");
  const [draft, setDraft] = useState<PurchaseDraft>(() => emptyDraft());
  const [returnDraft, setReturnDraft] = useState<PurchaseReturnDraft>(() => emptyReturnDraft());
  const [confirmationPurchase, setConfirmationPurchase] = useState<AdminPurchase | null>(null);
  const [isPending, startTransition] = useTransition();

  const desktopListRef = useRef<HTMLDivElement | null>(null);
  const compactListRef = useRef<HTMLDivElement | null>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const workspaceHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const originTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspaceReturnFocusRef = useRef<HTMLElement | null>(null);
  const savedListScrollRef = useRef(0);
  const workspaceBaselineRef = useRef(draftSignature(draft));
  const workspaceUrlRef = useRef("");
  const workspaceHistoryPushedRef = useRef(false);
  const compactHistoryPushedRef = useRef(false);
  const cancellationKeysRef = useRef(new Map<string, string>());
  const allowNextPopRef = useRef(false);
  const dirtyRef = useRef(false);
  const workspaceModeRef = useRef<WorkspaceMode>(workspaceMode);
  const compactDetailOpenRef = useRef(compactDetailOpen);

  const visiblePurchases = useMemo(
    () => filterAdminPurchases(purchases, { query, supplierId: supplierFilter, status: statusFilter }),
    [purchases, query, statusFilter, supplierFilter],
  );
  const selectedPurchase = visiblePurchases.find((purchase) => purchase.id === selectedId) ?? null;
  const workspacePurchase = purchases.find((purchase) => purchase.id === returnDraft.purchase_id) ?? null;
  const workspaceDirty = useMemo(() => {
    if (workspaceMode === "create" || workspaceMode === "edit") return draftSignature(draft) !== workspaceBaselineRef.current;
    if (workspaceMode === "return") return returnSignature(returnDraft) !== workspaceBaselineRef.current;
    return false;
  }, [draft, returnDraft, workspaceMode]);
  const draftTotals = useMemo(() => {
    const subtotal = draft.items.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unit_cost || 0), 0);
    const tax = draft.items.reduce((sum, line) => sum + Number(line.tax_amount || 0), 0);
    const discount = draft.items.reduce((sum, line) => sum + Number(line.discount_amount || 0), 0);
    const shipping = Number(draft.shipping_amount || 0);
    return { subtotal, tax, discount, shipping, total: Math.max(subtotal + tax + shipping - discount, 0) };
  }, [draft]);

  useEffect(() => {
    dirtyRef.current = workspaceDirty;
    workspaceModeRef.current = workspaceMode;
    compactDetailOpenRef.current = compactDetailOpen;
  }, [compactDetailOpen, workspaceDirty, workspaceMode]);

  useEffect(() => {
    if (initialSelection.notice === "hidden") replacePurchaseUrl(null);
  }, [initialSelection.notice]);

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }

    function handleDocumentNavigation(event: MouseEvent) {
      if (!dirtyRef.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!target || target.target === "_blank" || target.hasAttribute("download")) return;
      const destination = new URL(target.href, window.location.href);
      if (destination.href === window.location.href) return;

      event.preventDefault();
      event.stopPropagation();
      void toast.confirm({
        title: "Cambios sin guardar",
        message: "Hay cambios sin guardar. Si navegas a otra sección, se perderán.",
        confirmLabel: "Descartar cambios",
        cancelLabel: "Seguir editando",
        tone: "danger",
      }).then((discard) => {
        if (!discard) return;
        dirtyRef.current = false;
        if (destination.origin === window.location.origin) {
          router.push(`${destination.pathname}${destination.search}${destination.hash}`);
        } else {
          window.location.assign(destination.href);
        }
      });
    }

    function handlePopState(event: PopStateEvent) {
      if (allowNextPopRef.current) {
        allowNextPopRef.current = false;
        return;
      }

      if (workspaceModeRef.current !== "browse") {
        if (!dirtyRef.current) {
          workspaceHistoryPushedRef.current = false;
          setWorkspaceMode("browse");
          restoreWorkspaceFocus();
          return;
        }

        window.history.pushState({ carZonePurchasesWorkspace: true }, "", workspaceUrlRef.current || window.location.href);
        void toast.confirm({
          title: "Cambios sin guardar",
          message: "Hay cambios sin guardar. Si continúas, se perderán.",
          confirmLabel: "Descartar cambios",
          cancelLabel: "Seguir editando",
          tone: "danger",
        }).then((discard) => {
          if (!discard) return;
          dirtyRef.current = false;
          workspaceHistoryPushedRef.current = false;
          setWorkspaceMode("browse");
          allowNextPopRef.current = true;
          window.history.back();
          restoreWorkspaceFocus();
        });
        return;
      }

      const requestedId = new URL(window.location.href).searchParams.get("purchaseId");
      if (event.state?.carZonePurchasesDetail && requestedId) {
        const requestedPurchase = purchases.find((purchase) => purchase.id === requestedId);
        if (requestedPurchase) {
          setSelectedId(requestedPurchase.id);
          setSelectionNotice(null);
          setCompactDetailOpen(true);
          compactHistoryPushedRef.current = true;
          window.requestAnimationFrame(() => detailHeadingRef.current?.focus());
          return;
        }
      }

      if (compactDetailOpenRef.current) {
        compactHistoryPushedRef.current = false;
        setCompactDetailOpen(false);
        restoreCompactListContext();
      }
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("popstate", handlePopState);
    document.addEventListener("click", handleDocumentNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("click", handleDocumentNavigation, true);
    };
  }, [purchases, router, toast]);

  function restoreCompactListContext() {
    window.requestAnimationFrame(() => {
      originTriggerRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: savedListScrollRef.current, behavior: "auto" });
    });
  }

  function restoreWorkspaceFocus() {
    window.requestAnimationFrame(() => workspaceReturnFocusRef.current?.focus({ preventScroll: true }));
  }

  function reconcileSelectionWithFilters(next: { query: string; supplierId: string; status: PurchaseStatusFilter }) {
    if (!selectedId) return;
    const remainsVisible = filterAdminPurchases(purchases, next).some((purchase) => purchase.id === selectedId);
    if (remainsVisible) return;

    setSelectedId(null);
    setSelectionNotice("hidden");
    replacePurchaseUrl(null);
    if (compactDetailOpenRef.current) {
      compactHistoryPushedRef.current = false;
      setCompactDetailOpen(false);
      restoreCompactListContext();
    }
  }

  function changeQuery(value: string) {
    setQuery(value);
    reconcileSelectionWithFilters({ query: value, supplierId: supplierFilter, status: statusFilter });
  }

  function changeSupplierFilter(value: string) {
    setSupplierFilter(value);
    reconcileSelectionWithFilters({ query, supplierId: value, status: statusFilter });
  }

  function changeStatusFilter(value: PurchaseStatusFilter) {
    setStatusFilter(value);
    reconcileSelectionWithFilters({ query, supplierId: supplierFilter, status: value });
  }

  function updateLine(key: string, patch: Partial<PurchaseLineDraft>) {
    setDraft((current) => ({ ...current, items: current.items.map((line) => line.key === key ? { ...line, ...patch } : line) }));
  }

  function chooseProduct(line: PurchaseLineDraft, product: PurchaseProductSearchResult | null) {
    updateLine(line.key, {
      product_id: product?.id ?? "",
      selectedProduct: product,
      description: product ? `${product.sku ? `${product.sku} - ` : ""}${product.name}` : line.description,
      unit_cost: product ? product.costPrice : line.unit_cost,
    });
  }

  function startWorkspace(mode: Exclude<WorkspaceMode, "browse">, nextDraft?: PurchaseDraft, nextReturn?: PurchaseReturnDraft) {
    workspaceReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (nextDraft) {
      setDraft(nextDraft);
      workspaceBaselineRef.current = draftSignature(nextDraft);
    }
    if (nextReturn) {
      setReturnDraft(nextReturn);
      workspaceBaselineRef.current = returnSignature(nextReturn);
    }
    setWorkspaceMode(mode);
    workspaceUrlRef.current = window.location.href;
    window.history.pushState({ carZonePurchasesWorkspace: true }, "", window.location.href);
    workspaceHistoryPushedRef.current = true;
    window.requestAnimationFrame(() => workspaceHeadingRef.current?.focus());
  }

  function openCreateWorkspace() {
    if (!canManage) return;
    startWorkspace("create", emptyDraft());
  }

  function openEditWorkspace(purchase: AdminPurchase) {
    if (!canManage || purchase.status !== "draft") return;
    setSelectedId(purchase.id);
    startWorkspace("edit", purchaseToDraft(purchase));
  }

  function openReturnWorkspace(purchase: AdminPurchase) {
    if (!canManage || !isPurchaseReturnEligible(purchase)) return;
    setSelectedId(purchase.id);
    startWorkspace("return", undefined, emptyReturnDraft(purchase.id));
  }

  async function confirmDiscardWorkspace() {
    if (!dirtyRef.current) return true;
    return toast.confirm({
      title: "Cambios sin guardar",
      message: "Hay cambios sin guardar. Si sales de este espacio de trabajo, se perderán.",
      confirmLabel: "Descartar cambios",
      cancelLabel: "Seguir editando",
      tone: "danger",
    });
  }

  async function closeWorkspace() {
    if (!(await confirmDiscardWorkspace())) return;
    dirtyRef.current = false;
    setWorkspaceMode("browse");
    if (workspaceHistoryPushedRef.current) {
      workspaceHistoryPushedRef.current = false;
      allowNextPopRef.current = true;
      window.history.back();
    }
    restoreWorkspaceFocus();
  }

  function finishWorkspaceAfterSuccess() {
    dirtyRef.current = false;
    setWorkspaceMode("browse");
    if (workspaceHistoryPushedRef.current) {
      workspaceHistoryPushedRef.current = false;
      allowNextPopRef.current = true;
      window.history.back();
    }
    restoreWorkspaceFocus();
  }

  function selectPurchase(purchase: AdminPurchase, trigger: HTMLButtonElement) {
    setSelectedId(purchase.id);
    setSelectionNotice(null);
    originTriggerRef.current = trigger;
    const url = new URL(window.location.href);
    url.searchParams.set("purchaseId", purchase.id);

    if (window.matchMedia("(max-width: 1279px)").matches) {
      savedListScrollRef.current = window.scrollY;
      window.history.pushState({ carZonePurchasesDetail: true }, "", url);
      compactHistoryPushedRef.current = true;
      setCompactDetailOpen(true);
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: "auto" });
        detailHeadingRef.current?.focus();
      });
      return;
    }

    window.history.replaceState(window.history.state, "", url);
    compactHistoryPushedRef.current = false;
  }

  function returnToPurchases() {
    if (compactHistoryPushedRef.current) {
      window.history.back();
      return;
    }
    replacePurchaseUrl(null);
    setCompactDetailOpen(false);
    restoreCompactListContext();
  }

  function savePurchase() {
    if (!canManage) return;
    if (draft.items.some((line) => line.product_id && !Number.isInteger(Number(line.quantity)))) {
      toast.error("La cantidad de un producto de inventario debe ser un número entero.");
      return;
    }
    startTransition(async () => {
      const result = await savePurchaseAction({
        ...draft,
        items: draft.items.map((line) => ({ id: line.id, product_id: line.product_id, description: line.description, quantity: line.quantity, unit_cost: line.unit_cost, tax_amount: line.tax_amount, discount_amount: line.discount_amount })),
      }).catch(() => ({ ok: false as const, message: "No se pudo guardar la compra." }));
      if (result.ok) {
        toast.success(result.message);
        finishWorkspaceAfterSuccess();
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  function confirmPurchase(purchase: AdminPurchase) {
    if (!canManage || purchase.status !== "draft") return;
    if (purchaseApAutomationEnabled) {
      setConfirmationPurchase(purchase);
      return;
    }
    startTransition(async () => {
      const result = await confirmPurchaseAction(purchase.id).catch(() => ({ ok: false as const, message: "No se pudo confirmar la compra." }));
      if (result.ok) {
        toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  function confirmPurchaseWithPayable(input: PurchaseConfirmationInput) {
    startTransition(async () => {
      const result = await confirmPurchaseAction(input).catch(() => ({ ok: false as const, message: "No se pudo confirmar la compra." }));
      if (result.ok) {
        toast.success(result.message);
        setConfirmationPurchase(null);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  async function requestPurchaseCancellation(purchase: AdminPurchase) {
    if (!canManage || !["draft", "confirmed"].includes(purchase.status)) return;
    const confirmed = await toast.confirm({
      title: "Cancelar compra",
      message: `La compra ${purchase.purchase_number} de ${purchase.supplier_name} será cancelada mediante el flujo operativo protegido. Esta acción puede revertir inventario y obligaciones vinculadas.`,
      confirmLabel: "Cancelar compra",
      cancelLabel: "No cancelar",
      tone: "danger",
    });
    if (!confirmed) return;

    const requestKey = cancellationKeysRef.current.get(purchase.id) ?? globalThis.crypto.randomUUID();
    cancellationKeysRef.current.set(purchase.id, requestKey);
    startTransition(async () => {
      const result = await cancelPurchaseAction(purchase.id, requestKey).catch(() => ({ ok: false as const, message: "No se pudo cancelar la compra." }));
      if (result.ok) {
        cancellationKeysRef.current.delete(purchase.id);
        toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  function saveReturn() {
    if (!canManage) return;
    startTransition(async () => {
      const result = await registerPurchaseReturnAction(returnDraft).catch(() => ({ ok: false as const, message: "No se pudo registrar la devolución." }));
      if (result.ok) {
        toast.success(result.message);
        finishWorkspaceAfterSuccess();
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <div className="min-w-0 space-y-5">
      {confirmationPurchase ? <PurchaseConfirmationDialog purchase={confirmationPurchase} pending={isPending} onCancel={() => !isPending && setConfirmationPurchase(null)} onConfirm={confirmPurchaseWithPayable} /> : null}

      {workspaceMode === "browse" && purchaseApAutomationEnabled ? (
        <div className={`${compactDetailOpen ? "hidden xl:flex" : "flex"} items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900`}>
          <CheckCircle2 aria-hidden size={19} className="mt-0.5 shrink-0" />
          <p><strong>Automatización Compra → CxP activa.</strong> Toda compra nueva debe confirmar su condición de pago.</p>
        </div>
      ) : null}

      {workspaceMode === "browse" ? (
        <section className={`${compactDetailOpen ? "hidden xl:grid" : "grid"} gap-3 sm:grid-cols-2 xl:grid-cols-4`} aria-label="Resumen de compras">
          <Metric label="Borradores" value={summary.totalDraft.toLocaleString("es-HN")} />
          <Metric label="Confirmadas" value={summary.totalConfirmed.toLocaleString("es-HN")} />
          <Metric label="Canceladas" value={summary.totalCancelled.toLocaleString("es-HN")} />
          <Metric label="Total operativo" value={formatCurrency(summary.totalAmount)} />
        </section>
      ) : null}

      {workspaceMode === "create" || workspaceMode === "edit" ? (
        <PurchaseCreateEditWorkspace
          mode={workspaceMode}
          draft={draft}
          suppliers={suppliers}
          pending={isPending}
          dirty={workspaceDirty}
          totals={draftTotals}
          headingRef={workspaceHeadingRef}
          onDraftChange={setDraft}
          onUpdateLine={updateLine}
          onChooseProduct={chooseProduct}
          onAddLine={() => setDraft((current) => ({ ...current, items: [...current.items, newLine()] }))}
          onRemoveLine={(key) => setDraft((current) => ({ ...current, items: current.items.length > 1 ? current.items.filter((line) => line.key !== key) : current.items }))}
          onBack={() => void closeWorkspace()}
          onSave={savePurchase}
        />
      ) : workspaceMode === "return" && workspacePurchase ? (
        <SupplierReturnWorkspace purchase={workspacePurchase} draft={returnDraft} pending={isPending} dirty={workspaceDirty} headingRef={workspaceHeadingRef} onDraftChange={setReturnDraft} onBack={() => void closeWorkspace()} onSave={saveReturn} />
      ) : (
        <>
          <div className="hidden min-w-0 gap-4 xl:grid xl:grid-cols-[minmax(0,1.35fr)_minmax(420px,1fr)] xl:items-start">
            <PurchasesBrowser variant="desktop" idPrefix="purchases-desktop" purchases={visiblePurchases} totalPurchases={purchases.length} suppliers={suppliers} query={query} supplierFilter={supplierFilter} statusFilter={statusFilter} selectedId={selectedId} selectionNotice={selectionNotice} canManage={canManage} listRef={desktopListRef} onQueryChange={changeQuery} onSupplierFilterChange={changeSupplierFilter} onStatusFilterChange={changeStatusFilter} onSelect={selectPurchase} onCreate={openCreateWorkspace} />
            <PurchaseDetail purchase={selectedPurchase} notice={selectionNotice} canManage={canManage} pending={isPending} onEdit={openEditWorkspace} onConfirm={confirmPurchase} onCancel={(purchase) => void requestPurchaseCancellation(purchase)} onReturn={openReturnWorkspace} />
          </div>

          <div className={compactDetailOpen ? "hidden" : "block xl:hidden"}>
            <PurchasesBrowser variant="cards" idPrefix="purchases-compact" purchases={visiblePurchases} totalPurchases={purchases.length} suppliers={suppliers} query={query} supplierFilter={supplierFilter} statusFilter={statusFilter} selectedId={selectedId} selectionNotice={selectionNotice} canManage={canManage} listRef={compactListRef} onQueryChange={changeQuery} onSupplierFilterChange={changeSupplierFilter} onStatusFilterChange={changeStatusFilter} onSelect={selectPurchase} onCreate={openCreateWorkspace} />
          </div>

          <div className={compactDetailOpen ? "block xl:hidden" : "hidden"}>
            <PurchaseDetail purchase={selectedPurchase} notice={selectionNotice} canManage={canManage} pending={isPending} compact headingRef={detailHeadingRef} onBack={returnToPurchases} onEdit={openEditWorkspace} onConfirm={confirmPurchase} onCancel={(purchase) => void requestPurchaseCancellation(purchase)} onReturn={openReturnWorkspace} />
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-lg border border-black/10 bg-white p-4 shadow-sm"><p className="text-sm text-black/50">{label}</p><p className="mt-1 break-words text-2xl font-semibold [overflow-wrap:anywhere]">{value}</p></div>;
}
