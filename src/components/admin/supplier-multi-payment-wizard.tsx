"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileCheck2,
  Loader2,
  Plus,
  Search,
  X,
} from "lucide-react";
import {
  getSupplierOpenPayablesAction,
  registerSupplierMultiPaymentAction,
  voidSupplierMultiPaymentAction,
} from "@/app/admin/cuentas-por-pagar/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { SupplierMultiPaymentRpcResult } from "@/schemas/supplier-multi-payment";
import type {
  SupplierMultiPaymentConfig,
  SupplierMultiPaymentHistoryItem,
  SupplierOpenPayable,
} from "@/services/supabase/supplier-multi-payment.service";
import type { SupplierOption } from "@/types/purchases";
import { formatCurrency } from "@/utils/pricing";
import { formatCivilDate, isCivilDate, todayCivilDate } from "@/lib/civil-date";
import {
  isEligibleSupplierPaymentPayable,
  type SupplierPaymentWizardSelectionRequest,
} from "@/components/admin/supplier-payment-wizard-selection";

type Step = 1 | 2 | 3 | 4 | 5;
type PaymentMethod = "cash" | "bank_transfer" | "card_credit" | "card_debit";

type PersistedDraft = {
  version: 2;
  requestKey: string;
  step: Step;
  supplierId: string;
  selectedIds: string[];
  selectedPayables: Record<string, SupplierOpenPayable>;
  amounts: Record<string, string>;
  paidDate: string;
  reviewedPaidDate: string | null;
  paymentMethod: PaymentMethod | "";
  reference: string;
  notes: string;
  initialPayableId: string | null;
};

const storageKey = "supplier_multi_invoice_payment_v2:draft";
const legacyStorageKey = "supplier_multi_invoice_payment_v1:draft";
const methodLabels: Record<PaymentMethod, string> = {
  cash: "Efectivo",
  bank_transfer: "Transferencia bancaria",
  card_credit: "Tarjeta de crédito",
  card_debit: "Tarjeta de débito",
};

function todayValue() {
  return todayCivilDate();
}

function newDraft(): PersistedDraft {
  return {
    version: 2,
    requestKey: globalThis.crypto.randomUUID(),
    step: 1,
    supplierId: "",
    selectedIds: [],
    selectedPayables: {},
    amounts: {},
    paidDate: todayValue(),
    reviewedPaidDate: null,
    paymentMethod: "",
    reference: "",
    notes: "",
    initialPayableId: null,
  };
}

function readDraft(): PersistedDraft {
  try {
    const value = localStorage.getItem(storageKey);
    if (!value) return newDraft();
    const parsed = JSON.parse(value) as Partial<PersistedDraft>;
    if (
      parsed.version !== 2 ||
      typeof parsed.requestKey !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(parsed.requestKey) ||
      !isCivilDate(parsed.paidDate)
    ) {
      return newDraft();
    }
    return {
      version: 2,
      requestKey: parsed.requestKey,
      step: [1, 2, 3, 4, 5].includes(Number(parsed.step))
        ? (Number(parsed.step) as Step)
        : 1,
      supplierId: typeof parsed.supplierId === "string" ? parsed.supplierId : "",
      selectedIds: Array.isArray(parsed.selectedIds)
        ? parsed.selectedIds.filter((id): id is string => typeof id === "string")
        : [],
      selectedPayables:
        typeof parsed.selectedPayables === "object" && parsed.selectedPayables
          ? (parsed.selectedPayables as Record<string, SupplierOpenPayable>)
          : {},
      amounts:
        typeof parsed.amounts === "object" && parsed.amounts
          ? (parsed.amounts as Record<string, string>)
          : {},
      paidDate: parsed.paidDate,
      reviewedPaidDate:
        isCivilDate(parsed.reviewedPaidDate) &&
        parsed.reviewedPaidDate === parsed.paidDate
          ? parsed.reviewedPaidDate
          : null,
      paymentMethod: Object.keys(methodLabels).includes(parsed.paymentMethod ?? "")
        ? (parsed.paymentMethod as PaymentMethod)
        : "",
      reference: typeof parsed.reference === "string" ? parsed.reference : "",
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
      initialPayableId:
        typeof parsed.initialPayableId === "string" ? parsed.initialPayableId : null,
    };
  } catch {
    return newDraft();
  }
}

function cents(value: string | number) {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function moneyFromCents(value: number) {
  return value / 100;
}

function maskReference(reference: string) {
  const clean = reference.trim();
  if (clean.length <= 4) return clean ? "••••" : "Sin referencia";
  return `${clean.slice(0, 2)}••••${clean.slice(-2)}`;
}

function dateLabel(value: string | null) {
  return formatCivilDate(value);
}

export function SupplierMultiPaymentWizard({
  suppliers,
  config,
  history,
  canManage,
  open,
  onOpenChange,
  selectionRequest,
  onSelectionRequestClear,
}: {
  suppliers: SupplierOption[];
  config: SupplierMultiPaymentConfig;
  history: SupplierMultiPaymentHistoryItem[];
  canManage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectionRequest: SupplierPaymentWizardSelectionRequest | null;
  onSelectionRequestClear: () => void;
}) {
  const toast = useToast();
  const receiptRef = useRef<HTMLInputElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const handledSelectionRequestRef = useRef<number | null>(null);
  const activeSelectionRequestRef = useRef<number | null>(null);
  const initialValidatedPayableRef = useRef<SupplierOpenPayable | null>(null);
  const voidKeysRef = useRef(new Map<string, string>());
  const [draft, setDraft] = useState<PersistedDraft | null>(null);
  const [payables, setPayables] = useState<SupplierOpenPayable[]>([]);
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<{ dueDate: string | null; id: string } | null>(null);
  const [loadingPayables, setLoadingPayables] = useState(false);
  const [receipt, setReceipt] = useState<File | null>(null);
  const [result, setResult] = useState<SupplierMultiPaymentRpcResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const [validatingInitialSelection, setValidatingInitialSelection] = useState(false);
  const [checkingEligibility, setCheckingEligibility] = useState(false);


  useEffect(() => {
    if (!open || !draft) return;
    localStorage.setItem(storageKey, JSON.stringify(draft));
  }, [draft, open]);

  useEffect(() => {
    if (!open || focusRequest === 0) return;
    const frame = window.requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      stepHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest, open]);

  useEffect(() => {
    if (
      !open ||
      !selectionRequest ||
      handledSelectionRequestRef.current === selectionRequest.requestId
    ) {
      return;
    }

    handledSelectionRequestRef.current = selectionRequest.requestId;
    activeSelectionRequestRef.current = selectionRequest.requestId;
    initialValidatedPayableRef.current = null;
    localStorage.removeItem(storageKey);
    void Promise.resolve().then(() => {
    const supplier = suppliers.find(
      (item) => item.id === selectionRequest.supplierId && item.is_active,
    );
    setDraft({
      ...newDraft(),
      step: supplier ? 2 : 1,
      supplierId: supplier ? selectionRequest.supplierId : "",
      initialPayableId: supplier ? selectionRequest.accountsPayableId : null,
    });
    setPayables([]);
    setCursor(null);
    setSearch("");
    setReceipt(null);
    setResult(null);

    if (!supplier) {
      toast.warning(
        "El proveedor ya no está disponible. Seleccione un proveedor vigente.",
      );
      window.requestAnimationFrame(() => {
        sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        stepHeadingRef.current?.focus({ preventScroll: true });
      });
      return;
    }

    setValidatingInitialSelection(true);
    return getSupplierOpenPayablesAction({
      supplier_id: selectionRequest.supplierId,
      effective_payment_date: todayValue(),
      accounts_payable_id: selectionRequest.accountsPayableId,
      page_size: 1,
    })
      .then((response) => {
        if (activeSelectionRequestRef.current !== selectionRequest.requestId) return;
        const payable = response.ok ? response.items[0] : null;
        if (!isEligibleSupplierPaymentPayable(payable, selectionRequest) || !payable?.payment_eligible) {
          setDraft((current) =>
            current && current.supplierId === selectionRequest.supplierId
              ? {
                  ...current,
                  selectedIds: [],
                  selectedPayables: {},
                  amounts: {},
                  initialPayableId: null,
                }
              : current,
          );
          toast.warning(
            "El saldo seleccionado ya no está abierto. Seleccione un saldo vigente del proveedor.",
          );
          return;
        }
        setPayables((current) => [
          payable,
          ...current.filter((item) => item.id !== payable.id),
        ]);
        initialValidatedPayableRef.current = payable;
        setDraft((current) =>
          current && current.supplierId === selectionRequest.supplierId
            ? {
                ...current,
                selectedIds: [payable.id],
                selectedPayables: { [payable.id]: payable },
                amounts: { [payable.id]: payable.balance.toFixed(2) },
                initialPayableId: payable.id,
              }
            : current,
        );
        toast.success(
          "Saldo preseleccionado. Puede añadir otros saldos abiertos del mismo proveedor.",
        );
      })
      .catch(() => {
        if (activeSelectionRequestRef.current !== selectionRequest.requestId) return;
        setDraft((current) =>
          current && current.supplierId === selectionRequest.supplierId
            ? {
                ...current,
                selectedIds: [],
                selectedPayables: {},
                amounts: {},
                initialPayableId: null,
              }
            : current,
        );
        toast.warning(
          "No se pudo validar el saldo seleccionado. Seleccione un saldo vigente del proveedor.",
        );
      })
      .finally(() => {
        if (activeSelectionRequestRef.current !== selectionRequest.requestId) return;
        setValidatingInitialSelection(false);
        setFocusRequest((current) => current + 1);
      });
    });
  }, [open, selectionRequest, suppliers, toast]);

  const activeSupplierId = draft?.supplierId ?? "";
  const loadPayables = useCallback(
    async (options?: { append?: boolean; searchValue?: string }) => {
      if (!activeSupplierId) return;
      setLoadingPayables(true);
      const append = Boolean(options?.append);
      const nextCursor = append ? cursor : null;
      const response = await getSupplierOpenPayablesAction({
        supplier_id: activeSupplierId,
        effective_payment_date: draft?.paidDate ?? todayValue(),
        query: options?.searchValue ?? search,
        cursor_due_date: nextCursor?.dueDate ?? null,
        cursor_id: nextCursor?.id ?? null,
        page_size: 30,
      }).catch(() => ({
        ok: false as const,
        message: "No se pudieron cargar las cuentas por pagar.",
        items: [],
        nextCursor: null,
      }));
      setLoadingPayables(false);
      if (!response.ok) {
        toast.error(response.message);
        return;
      }
      setPayables((current) => {
        if (append) return [...current, ...response.items];
        const initialPayable = initialValidatedPayableRef.current;
        if (
          initialPayable &&
          initialPayable.supplier_id === activeSupplierId &&
          !response.items.some((item) => item.id === initialPayable.id)
        ) {
          return [initialPayable, ...response.items];
        }
        return response.items;
      });
      setDraft((current) => {
        if (!current) return current;
        const refreshed = response.items.filter((payable) =>
          current.selectedIds.includes(payable.id),
        );
        if (refreshed.length === 0) return current;
        return {
          ...current,
          selectedPayables: {
            ...current.selectedPayables,
            ...Object.fromEntries(
              refreshed.map((payable) => [payable.id, payable]),
            ),
          },
        };
      });
      setCursor(response.nextCursor);
    },
    [activeSupplierId, cursor, draft?.paidDate, search, toast],
  );

  useEffect(() => {
    if (!open || !draft?.supplierId || draft.step < 2) return;
    const timer = window.setTimeout(() => {
      void loadPayables({ searchValue: search });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft?.step, draft?.supplierId, loadPayables, open, search]);

  const selectedIdsKey = draft?.selectedIds.join(",") ?? "";
  useEffect(() => {
    if (!open || !draft?.supplierId || !isCivilDate(draft.paidDate) || !selectedIdsKey) return;
    let active = true;
    const selectedIds = selectedIdsKey.split(",").filter(Boolean);
    const timer = window.setTimeout(() => {
      if (!active) return;
      setCheckingEligibility(true);
      void getSupplierOpenPayablesAction({
        supplier_id: draft.supplierId,
        effective_payment_date: draft.paidDate,
        accounts_payable_ids: selectedIds,
        page_size: selectedIds.length,
      })
        .then((response) => {
          if (!active || !response.ok) return;
          const refreshedById = Object.fromEntries(response.items.map((payable) => [payable.id, payable]));
          setPayables((current) => current.map((payable) => refreshedById[payable.id] ?? payable));
          setDraft((current) => current
            ? {
                ...current,
                selectedPayables: {
                  ...current.selectedPayables,
                  ...refreshedById,
                },
              }
            : current);
          if (response.items.some((payable) => !payable.payment_eligible)) {
            toast.warning("La fecha efectiva seleccionada deja al menos una obligación fuera del pago.");
          }
        })
        .catch(() => {
          if (active) toast.error("No se pudo reevaluar el reconocimiento para la fecha efectiva.");
        })
        .finally(() => {
          if (active) setCheckingEligibility(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draft?.paidDate, draft?.supplierId, open, selectedIdsKey, toast]);

  const selected = useMemo(
    () =>
      (draft?.selectedIds ?? [])
        .map((id) => draft?.selectedPayables[id])
        .filter((payable): payable is SupplierOpenPayable => Boolean(payable)),
    [draft?.selectedIds, draft?.selectedPayables],
  );
  const totalCents = useMemo(
    () =>
      selected.reduce(
        (total, payable) => total + cents(draft?.amounts[payable.id] ?? 0),
        0,
      ),
    [draft?.amounts, selected],
  );
  const applicationsValid =
    !checkingEligibility &&
    selected.length > 0 &&
    selected.length <= 200 &&
    selected.every((payable) => {
      const applied = cents(draft?.amounts[payable.id] ?? 0);
      return payable.payment_eligible && applied > 0 && applied <= cents(payable.balance);
    });
  const selectedSupplier = suppliers.find(
    (supplier) => supplier.id === draft?.supplierId,
  );
  const selectedAccount = config.methodAccounts.find(
    (item) => item.method === draft?.paymentMethod,
  );

  function updateDraft(update: Partial<PersistedDraft>) {
    setDraft((current) => (current ? { ...current, ...update } : current));
  }

  function resetAndClose() {
    localStorage.removeItem(storageKey);
    localStorage.removeItem(legacyStorageKey);
    setDraft(null);
    setPayables([]);
    setCursor(null);
    setSearch("");
    setReceipt(null);
    setResult(null);
    activeSelectionRequestRef.current = null;
    initialValidatedPayableRef.current = null;
    setValidatingInitialSelection(false);
    onSelectionRequestClear();
    onOpenChange(false);
  }

  function chooseSupplier(supplierId: string) {
    updateDraft({
      supplierId,
      selectedIds: [],
      selectedPayables: {},
      amounts: {},
      initialPayableId: null,
    });
    setPayables([]);
    setCursor(null);
  }

  function togglePayable(payable: SupplierOpenPayable) {
    if (!draft) return;
    if (!payable.payment_eligible) {
      toast.warning(payable.recognition_state === "draft_pending_publication"
        ? "Publique la partida de reconocimiento antes de pagar esta obligación."
        : "Complete el reconocimiento contable antes de pagar esta obligación.");
      return;
    }
    const exists = draft.selectedIds.includes(payable.id);
    if (exists) {
      const amounts = { ...draft.amounts };
      const selectedPayables = { ...draft.selectedPayables };
      delete amounts[payable.id];
      delete selectedPayables[payable.id];
      updateDraft({
        selectedIds: draft.selectedIds.filter((id) => id !== payable.id),
        selectedPayables,
        amounts,
      });
      return;
    }
    if (draft.selectedIds.length >= 200) {
      toast.error("Un pago admite como máximo 200 aplicaciones.");
      return;
    }
    updateDraft({
      selectedIds: [...draft.selectedIds, payable.id],
      selectedPayables: {
        ...draft.selectedPayables,
        [payable.id]: payable,
      },
      amounts: { ...draft.amounts, [payable.id]: payable.balance.toFixed(2) },
    });
  }

  function applyAllBalances() {
    if (!draft) return;
    updateDraft({
      amounts: Object.fromEntries(
        selected.map((payable) => [payable.id, payable.balance.toFixed(2)]),
      ),
    });
  }

  function setApplication(payable: SupplierOpenPayable, value: string) {
    if (!draft) return;
    updateDraft({ amounts: { ...draft.amounts, [payable.id]: value } });
  }

  function nextStep() {
    if (!draft) return;
    if (draft.step === 1 && !draft.supplierId) {
      toast.error("Selecciona un proveedor.");
      return;
    }
    if (draft.step === 2 && selected.length === 0) {
      toast.error("Selecciona al menos una factura o cuenta por pagar.");
      return;
    }
    if (draft.step === 3 && !applicationsValid) {
      toast.error("Revisa los importes aplicados.");
      return;
    }
    if (draft.step === 4) {
      if (!isCivilDate(draft.paidDate)) {
        toast.error("Selecciona una fecha efectiva válida.");
        return;
      }
      if (!draft.paymentMethod || !selectedAccount) {
        toast.error("Selecciona un método con cuenta financiera configurada.");
        return;
      }
      if (draft.paymentMethod === "bank_transfer" && !draft.reference.trim()) {
        toast.error("La referencia es obligatoria para una transferencia.");
        return;
      }
      updateDraft({ step: 5, reviewedPaidDate: draft.paidDate });
      return;
    }
    updateDraft({ step: Math.min(5, draft.step + 1) as Step });
  }

  function previousStep() {
    if (!draft || draft.step === 1) return;
    updateDraft({
      step: (draft.step - 1) as Step,
      reviewedPaidDate: draft.step === 5 ? null : draft.reviewedPaidDate,
    });
  }

  function submit() {
    if (!draft || !applicationsValid || !draft.paymentMethod || isPending) return;
    if (
      !isCivilDate(draft.reviewedPaidDate) ||
      draft.reviewedPaidDate !== draft.paidDate
    ) {
      toast.error("La fecha cambió después de la revisión. Vuelve a confirmarla.");
      updateDraft({ step: 4, reviewedPaidDate: null });
      return;
    }
    const payload = {
      request_key: draft.requestKey,
      supplier_id: draft.supplierId,
      payment_method: draft.paymentMethod,
      paid_date: draft.reviewedPaidDate,
      reference: draft.reference || null,
      notes: draft.notes || null,
      applications: selected.map((payable) => ({
        accounts_payable_id: payable.id,
        applied_amount: moneyFromCents(cents(draft.amounts[payable.id])),
      })),
    };
    const formData = new FormData();
    formData.set("payload", JSON.stringify(payload));
    if (receipt) formData.set("receipt", receipt);

    startTransition(async () => {
      const response = await registerSupplierMultiPaymentAction(formData).catch(
        () => ({
          ok: false as const,
          message: "No se recibió respuesta. Intenta confirmar de nuevo con el mismo borrador.",
        }),
      );
      if (!response.ok) {
        toast.error(response.message);
        return;
      }
      localStorage.removeItem(storageKey);
      localStorage.removeItem(legacyStorageKey);
      setResult(response.result);
      toast.success(response.message);
    });
  }

  function submitVoid() {
    if (!voidingId || voidReason.trim().length < 3 || isPending) return;
    const requestKey =
      voidKeysRef.current.get(voidingId) ?? globalThis.crypto.randomUUID();
    voidKeysRef.current.set(voidingId, requestKey);
    startTransition(async () => {
      const response = await voidSupplierMultiPaymentAction({
        payment_id: voidingId,
        request_key: requestKey,
        reason: voidReason,
      }).catch(() => ({
        ok: false as const,
        message: "No se recibió respuesta. Reintenta con la misma solicitud.",
      }));
      if (!response.ok) {
        toast.error(response.message);
        return;
      }
      voidKeysRef.current.delete(voidingId);
      setVoidingId(null);
      setVoidReason("");
      toast.success(response.message);
      window.location.reload();
    });
  }

  if (!config.enabled) {
    return null;
  }

  return (
    <section ref={sectionRef} className="rounded-xl border border-[#e4252c]/20 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#b91c25]">
            Pago único · múltiples aplicaciones
          </p>
          <h2 className="mt-1 text-lg font-semibold">Registrar pago a proveedor</h2>
          <p className="text-sm text-black/55">
            Una transferencia, una salida económica y una sola partida en borrador.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => {
            const openedFromPayableRow = selectionRequest !== null;
            activeSelectionRequestRef.current = null;
            initialValidatedPayableRef.current = null;
            setValidatingInitialSelection(false);
            onSelectionRequestClear();
            if (openedFromPayableRow) {
              localStorage.removeItem(storageKey);
              localStorage.removeItem(legacyStorageKey);
            }
            setDraft(openedFromPayableRow ? newDraft() : readDraft());
            setResult(null);
            onOpenChange(true);
            setFocusRequest((current) => current + 1);
          }}
          disabled={!canManage}
        >
          <Plus size={17} />
          Registrar pago
        </Button>
      </div>

      {open ? (
        <div className="mt-5 rounded-xl border border-black/10 bg-[#fafafa]">
          <div className="flex items-start justify-between gap-3 border-b border-black/10 p-4">
            <div>
              <h3
                ref={stepHeadingRef}
                tabIndex={-1}
                aria-label={
                  result
                    ? "Registrar pago a proveedor. Pago confirmado."
                    : "Registrar pago a proveedor. Paso " +
                      (draft?.step ?? 1) +
                      " de 5" +
                      (draft?.step === 2 ? ". Selección de saldos." : ".")
                }
                className="text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c]"
              >
                {result ? "Pago confirmado" : `Paso ${draft?.step ?? 1} de 5`}
              </h3>
              <p className="text-xs text-black/50">
                Solicitud ••••{draft?.requestKey.slice(-8)}
              </p>
            </div>
            <button
              type="button"
              onClick={resetAndClose}
              className="rounded-md p-2 text-black/55 hover:bg-black/5"
              aria-label={result ? "Cerrar" : "Cancelar pago"}
            >
              <X size={20} />
            </button>
          </div>

          {result ? (
            <div className="grid gap-4 p-5 text-center">
              <CheckCircle2 className="mx-auto text-emerald-600" size={44} />
              <div>
                <h3 className="text-lg font-semibold">Pago registrado correctamente</h3>
                <p className="mt-1 text-sm text-black/60">
                  {result.application_count} aplicaciones · {formatCurrency(result.payment_total)}
                </p>
              </div>
              <div className="mx-auto grid w-full max-w-xl gap-2 rounded-lg bg-white p-4 text-left text-sm">
                <p><span className="text-black/50">Pago:</span> ••••{result.payment_id.slice(-8)}</p>
                <p><span className="text-black/50">Contabilidad:</span> {result.accounting_status}</p>
                <p><span className="text-black/50">Fecha contable:</span> {dateLabel(result.accounting_date)}</p>
                <p className="text-black/60">
                  El borrador aparecerá mediante el flujo automático y deberá publicarse manualmente.
                </p>
              </div>
              <Button type="button" onClick={resetAndClose}>Finalizar</Button>
            </div>
          ) : draft ? (
            <>
              <div className="p-4 sm:p-5">
                {draft.step === 1 ? (
                  <div className="grid gap-4">
                    <div>
                      <h3 className="font-semibold">Proveedor</h3>
                      <p className="text-sm text-black/55">Selecciona un proveedor activo.</p>
                    </div>
                    <label className="grid gap-1 text-sm font-semibold">
                      Buscar y seleccionar
                      <select
                        value={draft.supplierId}
                        onChange={(event) => chooseSupplier(event.target.value)}
                        className="min-h-11 rounded-md border border-black/10 bg-white px-3"
                      >
                        <option value="">Seleccionar proveedor</option>
                        {suppliers
                          .filter((supplier) => supplier.is_active)
                          .map((supplier) => (
                            <option key={supplier.id} value={supplier.id}>
                              {supplier.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                ) : null}

                {draft.step === 2 ? (
                  <div className="grid gap-4">
                    <div>
                      <h3 className="font-semibold">Facturas y cuentas por pagar</h3>
                      <p className="text-sm text-black/55">
                        {selectedSupplier?.name} · solo saldos abiertos en HNL.
                      </p>
                    </div>
                    {validatingInitialSelection ? (
                      <p
                        className="flex items-center gap-2 rounded-md bg-white p-3 text-sm text-black/60"
                        role="status"
                      >
                        <Loader2 className="animate-spin" size={16} />
                        Validando el saldo seleccionado…
                      </p>
                    ) : null}
                    {draft.initialPayableId &&
                    draft.selectedPayables[draft.initialPayableId]
                      ? (() => {
                          const initialPayable =
                            draft.selectedPayables[draft.initialPayableId];
                          const origin = initialPayable.supplier_invoice_id
                            ? "Factura de proveedor"
                            : initialPayable.purchase_id
                              ? "Compra sin factura"
                              : "Saldo inicial o registro manual reconocido";
                          return (
                            <div
                              data-testid="supplier-payment-initial-payable"
                              className="rounded-lg border border-[#e4252c]/30 bg-[#fff8f8] p-4"
                            >
                              <p className="text-xs font-semibold uppercase tracking-wide text-[#b91c25]">
                                Saldo preseleccionado
                              </p>
                              <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                                <p><span className="text-black/50">Factura:</span> {initialPayable.invoice_number ?? "Sin factura"}</p>
                                <p><span className="text-black/50">Compra:</span> {initialPayable.purchase_number ?? "Sin compra"}</p>
                                <p><span className="text-black/50">Total:</span> {formatCurrency(initialPayable.total_amount)}</p>
                                <p><span className="text-black/50">Pagado:</span> {formatCurrency(initialPayable.paid_amount)}</p>
                                <p><span className="text-black/50">Saldo:</span> <strong>{formatCurrency(initialPayable.balance)}</strong></p>
                                <p>
                                  <span className="text-black/50">Estado:</span>{" "}
                                  {initialPayable.status === "partial"
                                    ? "Parcial"
                                    : initialPayable.status === "overdue"
                                      ? "Vencido"
                                      : "Pendiente"}
                                </p>
                                <p className="sm:col-span-2"><span className="text-black/50">Origen:</span> {origin}</p>
                              </div>
                            </div>
                          );
                        })()
                      : null}
                    <label className="flex items-center gap-2 rounded-md border border-black/10 bg-white px-3">
                      <Search size={17} className="text-black/45" />
                      <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Buscar número de factura"
                        className="min-h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
                      />
                    </label>
                    <div className="hidden overflow-x-auto rounded-lg border border-black/10 bg-white md:block">
                      <table className="w-full min-w-[760px] text-left text-sm">
                        <thead className="bg-[#f0efee] text-xs uppercase text-black/55">
                          <tr>
                            <th className="px-3 py-2">Seleccionar</th>
                            <th className="px-3 py-2">Factura</th>
                            <th className="px-3 py-2">Fecha</th>
                            <th className="px-3 py-2">Vencimiento</th>
                            <th className="px-3 py-2">Saldo</th>
                            <th className="px-3 py-2">Aplicar</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-black/10">
                          {payables.map((payable) => (
                            <tr
                              key={payable.id}
                              className={draft.initialPayableId === payable.id ? "bg-[#fff8f8]" : undefined}
                            >
                              <td className="px-3 py-3">
                                <input
                                  type="checkbox"
                                  checked={draft.selectedIds.includes(payable.id)}
                                  onChange={() => togglePayable(payable)}
                                  disabled={!payable.payment_eligible}
                                  aria-label={`Seleccionar ${payable.invoice_number ?? payable.id}`}
                                />
                              </td>
                              <td className="px-3 py-3 font-semibold">
                                {payable.invoice_number ?? "Sin factura"}
                                {draft.initialPayableId === payable.id ? (
                                  <span className="ml-2 rounded-full bg-[#e4252c]/10 px-2 py-1 text-[11px] text-[#b91c25]">
                                    Preseleccionada
                                  </span>
                                ) : null}
                                {!payable.payment_eligible ? <span className="ml-2 rounded-full bg-[#f0efee] px-2 py-1 text-[11px] text-black/65">{payable.recognition_state === "draft_pending_publication" ? "Partida por publicar" : "Reconocimiento pendiente"}</span> : null}
                              </td>
                              <td className="px-3 py-3">{dateLabel(payable.invoice_date)}</td>
                              <td className="px-3 py-3">{dateLabel(payable.due_date)}</td>
                              <td className="px-3 py-3">{formatCurrency(payable.balance)}</td>
                              <td className="px-3 py-3">
                                {draft.selectedIds.includes(payable.id)
                                  ? formatCurrency(Number(draft.amounts[payable.id] ?? 0))
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="grid gap-3 md:hidden">
                      {payables.map((payable) => (
                        <label key={payable.id} className="grid gap-2 rounded-lg border border-black/10 bg-white p-4">
                          <span className="flex items-center justify-between gap-3">
                            <span className="font-semibold">{payable.invoice_number ?? "Sin factura"}</span>
                            <input
                              type="checkbox"
                              checked={draft.selectedIds.includes(payable.id)}
                              onChange={() => togglePayable(payable)}
                              disabled={!payable.payment_eligible}
                            />
                          </span>
                          <span className="text-xs text-black/55">Fecha {dateLabel(payable.invoice_date)}</span>
                          <span className="text-xs text-black/55">Vence {dateLabel(payable.due_date)}</span>
                          <span className="text-sm font-semibold">Saldo {formatCurrency(payable.balance)}</span>
                          {!payable.payment_eligible ? <span className="text-xs text-black/55">{payable.recognition_state === "draft_pending_publication" ? "Partida contable pendiente de publicación" : "Reconocimiento contable pendiente"}</span> : null}
                        </label>
                      ))}
                    </div>
                    {loadingPayables ? (
                      <p className="flex items-center gap-2 text-sm text-black/55"><Loader2 className="animate-spin" size={16} />Cargando…</p>
                    ) : null}
                    {cursor ? (
                      <Button type="button" variant="ghost" onClick={() => void loadPayables({ append: true })}>
                        Cargar más
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                {draft.step === 3 ? (
                  <div className="grid gap-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold">Distribución</h3>
                        <p className="text-sm text-black/55">Aplica el saldo completo o un importe parcial.</p>
                      </div>
                      <div className="flex gap-2">
                        <Button type="button" variant="ghost" onClick={applyAllBalances}>Aplicar total pendiente</Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => updateDraft({ selectedIds: [], amounts: {} })}
                        >
                          Limpiar
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-3">
                      {selected.map((payable) => {
                        const applied = cents(draft.amounts[payable.id] ?? 0);
                        const after = cents(payable.balance) - applied;
                        return (
                          <div key={payable.id} className="grid gap-3 rounded-lg border border-black/10 bg-white p-4 sm:grid-cols-[1fr_180px]">
                            <div>
                              <p className="font-semibold">{payable.invoice_number ?? "Sin factura"}</p>
                              <p className="text-sm text-black/55">Saldo anterior {formatCurrency(payable.balance)}</p>
                              <button
                                type="button"
                                onClick={() => setApplication(payable, payable.balance.toFixed(2))}
                                className="mt-2 text-sm font-semibold text-[#b91c25]"
                              >
                                Aplicar saldo completo
                              </button>
                            </div>
                            <label className="grid gap-1 text-sm font-semibold">
                              Aplicar
                              <Input
                                type="number"
                                min="0.01"
                                max={payable.balance}
                                step="0.01"
                                value={draft.amounts[payable.id] ?? ""}
                                onChange={(event) => setApplication(payable, event.target.value)}
                              />
                              <span className={after < 0 ? "text-red-700" : "text-black/55"}>
                                Saldo posterior {formatCurrency(moneyFromCents(after))}
                              </span>
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {draft.step === 4 ? (
                  <div className="grid gap-4">
                    <div>
                      <h3 className="font-semibold">Datos del pago</h3>
                      <p className="text-sm text-black/55">La cuenta financiera se deriva de la configuración activa.</p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="grid gap-1 text-sm font-semibold">
                        Fecha efectiva
                        <Input
                          type="date"
                          max={todayValue()}
                          value={draft.paidDate}
                          onChange={(event) =>
                            updateDraft({
                              paidDate: event.target.value,
                              reviewedPaidDate: null,
                            })
                          }
                        />
                      </label>
                      <label className="grid gap-1 text-sm font-semibold">
                        Método
                        <select
                          value={draft.paymentMethod}
                          onChange={(event) => updateDraft({ paymentMethod: event.target.value as PaymentMethod })}
                          className="min-h-11 rounded-md border border-black/10 bg-white px-3"
                        >
                          <option value="">Seleccionar</option>
                          {config.methodAccounts.map((account) => (
                            <option key={account.method} value={account.method}>{methodLabels[account.method]}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className="grid gap-1 text-sm font-semibold">
                      Referencia {draft.paymentMethod === "bank_transfer" ? "(obligatoria)" : "(opcional)"}
                      <Input
                        maxLength={160}
                        value={draft.reference}
                        onChange={(event) => updateDraft({ reference: event.target.value })}
                      />
                    </label>
                    <label className="grid gap-1 text-sm font-semibold">
                      Comprobante opcional
                      <input
                        ref={receiptRef}
                        type="file"
                        accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                        onChange={(event) => setReceipt(event.target.files?.[0] ?? null)}
                        className="min-h-11 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
                      />
                      <span className="text-xs font-normal text-black/50">Privado · JPG, PNG, WEBP o PDF · máximo 8 MB</span>
                    </label>
                    <label className="grid gap-1 text-sm font-semibold">
                      Notas
                      <textarea
                        rows={3}
                        maxLength={2000}
                        value={draft.notes}
                        onChange={(event) => updateDraft({ notes: event.target.value })}
                        className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
                      />
                    </label>
                    <div className="rounded-lg border border-black/10 bg-white p-4 text-sm">
                      <p><span className="text-black/50">Cuenta derivada:</span> {selectedAccount ? `${selectedAccount.accountCode} — ${selectedAccount.accountName}` : "Selecciona un método"}</p>
                      <p className="mt-1 font-semibold">Total {formatCurrency(moneyFromCents(totalCents))}</p>
                    </div>
                  </div>
                ) : null}

                {draft.step === 5 ? (
                  <div className="grid gap-4">
                    <div>
                      <h3 className="font-semibold">Revisión</h3>
                      <p className="text-sm text-black/55">Confirma una sola vez la salida económica completa.</p>
                    </div>
                    <div className="grid gap-3 rounded-lg border border-black/10 bg-white p-4 text-sm">
                      <p><span className="text-black/50">Proveedor:</span> {selectedSupplier?.name}</p>
                      <p><span className="text-black/50">Método:</span> {draft.paymentMethod ? methodLabels[draft.paymentMethod] : "—"}</p>
                      <p className="font-semibold">
                        Fecha efectiva del pago: {dateLabel(draft.reviewedPaidDate)}
                      </p>
                      <p><span className="text-black/50">Referencia:</span> {maskReference(draft.reference)}</p>
                      <p><span className="text-black/50">Cuenta:</span> {selectedAccount ? `${selectedAccount.accountCode} — ${selectedAccount.accountName}` : "—"}</p>
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-black/10 bg-white">
                      <table className="w-full min-w-[620px] text-left text-sm">
                        <thead className="bg-[#f0efee] text-xs uppercase text-black/55">
                          <tr><th className="px-3 py-2">Factura</th><th className="px-3 py-2">Saldo anterior</th><th className="px-3 py-2">Aplicar</th><th className="px-3 py-2">Saldo posterior</th></tr>
                        </thead>
                        <tbody className="divide-y divide-black/10">
                          {selected.map((payable) => {
                            const applied = moneyFromCents(cents(draft.amounts[payable.id]));
                            return (
                              <tr key={payable.id}>
                                <td className="px-3 py-3 font-semibold">{payable.invoice_number ?? "Sin factura"}</td>
                                <td className="px-3 py-3">{formatCurrency(payable.balance)}</td>
                                <td className="px-3 py-3">{formatCurrency(applied)}</td>
                                <td className="px-3 py-3">{formatCurrency(payable.balance - applied)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="grid gap-2 rounded-lg bg-[#171717] p-4 text-sm text-white sm:grid-cols-4">
                      <p><span className="block text-white/55">Facturas seleccionadas</span>{selected.length}</p>
                      <p><span className="block text-white/55">Total aplicado</span>{formatCurrency(moneyFromCents(totalCents))}</p>
                      <p><span className="block text-white/55">Total del pago</span>{formatCurrency(moneyFromCents(totalCents))}</p>
                      <p><span className="block text-white/55">Diferencia</span>L 0.00</p>
                    </div>
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                      <p className="font-semibold">Partida prevista</p>
                      <p>Débito 2101001 — PROVEEDORES LOCALES</p>
                      <p>Crédito {selectedAccount?.accountCode} — {selectedAccount?.accountName}</p>
                      <p className="mt-1">Publicación exclusivamente manual.</p>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="sticky bottom-0 flex flex-col gap-3 border-t border-black/10 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                  <span className="font-semibold">{selected.length} facturas</span>
                  <span className="mx-2 text-black/30">·</span>
                  <span>Total {formatCurrency(moneyFromCents(totalCents))}</span>
                </div>
                <div className="flex gap-2">
                  {draft.step > 1 ? (
                    <Button type="button" variant="ghost" onClick={previousStep} disabled={isPending}>
                      <ArrowLeft size={17} />Regresar
                    </Button>
                  ) : (
                    <Button type="button" variant="ghost" onClick={resetAndClose}>Cancelar</Button>
                  )}
                  {draft.step < 5 ? (
                    <Button type="button" onClick={nextStep} disabled={loadingPayables || isPending}>
                      Continuar<ArrowRight size={17} />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      onClick={submit}
                      disabled={!applicationsValid || totalCents <= 0}
                      pending={isPending}
                      pendingLabel="Registrando pago…"
                    >
                      <FileCheck2 size={17} />
                      Confirmar pago
                    </Button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="p-5 text-sm text-black/55">Preparando el flujo…</div>
          )}
        </div>
      ) : null}

      {history.length > 0 ? (
        <div className="mt-5 border-t border-black/10 pt-4">
          <h3 className="text-sm font-semibold">Pagos multifáctura recientes</h3>
          <div className="mt-3 grid gap-2">
            {history.slice(0, 10).map((payment) => (
              <div
                key={payment.id}
                className="flex flex-col gap-3 rounded-lg bg-[#fafafa] p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-semibold">
                    {payment.supplier_name} · {formatCurrency(payment.amount)}
                  </p>
                  <p className="text-xs text-black/55">
                    {payment.application_count} aplicaciones · {dateLabel(payment.paid_at ?? payment.created_at)} · {payment.status === "paid" ? "Pagado" : "Anulado"}
                  </p>
                </div>
                {payment.status === "paid" && canManage ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setVoidingId(payment.id);
                      setVoidReason("");
                    }}
                    disabled={isPending}
                  >
                    Anular pago completo
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {voidingId ? (
        <div className="mt-4 grid gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
          <div>
            <p className="font-semibold text-red-900">Anular pago completo</p>
            <p className="text-sm text-red-800">Se restaurarán todas las CxP. No se puede anular una sola aplicación.</p>
          </div>
          <textarea
            value={voidReason}
            onChange={(event) => setVoidReason(event.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="Motivo de la anulación"
            className="rounded-md border border-red-200 bg-white px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setVoidingId(null)} disabled={isPending}>Regresar</Button>
            <Button type="button" onClick={submitVoid} disabled={voidReason.trim().length < 3} pending={isPending} pendingLabel="Anulando pago…">
              Confirmar anulación completa
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
