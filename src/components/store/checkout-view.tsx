"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { BadgeCheck, Banknote, Copy, CreditCard, Home, SearchCheck, ShieldCheck, Store, Upload } from "lucide-react";
import {
  createCheckoutOrderAction,
  getCheckoutAccountAction,
  getWholesalePurchaseStatusAction,
  type CheckoutAccountInfo,
} from "@/app/checkout/actions";
import { CardBrandList } from "@/components/store/card-brand-list";
import type { CheckoutData } from "@/types/commerce";
import type { PublicCompanySettings } from "@/types/settings";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useShoppingCart } from "@/contexts/cart-context";
import { useOrders } from "@/contexts/orders-context";
import { useToast } from "@/contexts/toast-context";
import { calculateCheckoutFees } from "@/utils/commerce-settings";
import { formatCurrency } from "@/utils/pricing";
import { validateHondurasPhone } from "@/utils/validation";

const emptyCheckout: CheckoutData = {
  customerName: "",
  email: "",
  phone: "",
  rtn: "",
  country: "Honduras",
  department: "",
  city: "",
  address: "",
  paymentMethod: "Transferencia bancaria",
  paymentTiming: "before_delivery",
  bankTransferReference: "",
};

const guestCheckoutAccount: CheckoutAccountInfo = {
  isAuthenticated: false,
  email: null,
  customerName: null,
  phone: null,
  rtn: null,
  address: null,
  city: null,
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const bankReferencePattern = /^[A-Za-z0-9 -]+$/;

function mergeCheckoutAccount(current: CheckoutData, account: CheckoutAccountInfo): CheckoutData {
  return {
    ...current,
    email: account.isAuthenticated ? account.email ?? "" : current.email,
    customerName: current.customerName || account.customerName || "",
    phone: current.phone || account.phone || "",
    rtn: current.rtn || account.rtn || "",
    address: current.address || account.address || "",
    city: current.city || account.city || "",
  };
}

function validateBankReference(value: string) {
  const reference = value.trim().replace(/\s+/g, " ");

  if (!reference) {
    return "Ingresa el número de referencia bancaria.";
  }

  if (reference.length < 4) {
    return "La referencia bancaria debe tener al menos 4 caracteres.";
  }

  if (reference.length > 80) {
    return "La referencia bancaria no debe superar 80 caracteres.";
  }

  if (!bankReferencePattern.test(reference)) {
    return "La referencia bancaria solo puede incluir letras, números, espacios y guiones.";
  }

  return "";
}

const hondurasDepartments = [
  "Atlántida",
  "Choluteca",
  "Colón",
  "Comayagua",
  "Copán",
  "Cortés",
  "El Paraíso",
  "Francisco Morazán",
  "Gracias a Dios",
  "Intibucá",
  "Islas de la Bahía",
  "La Paz",
  "Lempira",
  "Ocotepeque",
  "Olancho",
  "Santa Bárbara",
  "Valle",
  "Yoro",
];

type OrderConfirmation = {
  orderNumber: string;
  trackingCode: string;
  paymentMethod: CheckoutData["paymentMethod"];
  total: number;
  currentStatus: string;
};

export function CheckoutView({
  settings,
  initialAccount = guestCheckoutAccount,
}: {
  settings: PublicCompanySettings;
  initialAccount?: CheckoutAccountInfo;
}) {
  const [checkout, setCheckout] = useState<CheckoutData>(() => mergeCheckoutAccount(emptyCheckout, initialAccount));
  const [accountInfo, setAccountInfo] = useState<CheckoutAccountInfo>(initialAccount);
  const [proofFileName, setProofFileName] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofMessage, setProofMessage] = useState("");
  const [checkoutMessage, setCheckoutMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [orderNumber, setOrderNumber] = useState("");
  const [confirmation, setConfirmation] = useState<OrderConfirmation | null>(null);
  const [isFirstWholesalePurchase, setIsFirstWholesalePurchase] = useState(true);
  const [isPending, startTransition] = useTransition();
  const { priceMode, wholesaleAccount } = usePriceMode();
  const { rows, wholesaleQuantityIssues, invalidItemCount, subtotal, tax, clearCart, clearInvalidCartItems } = useShoppingCart();
  const { createOrder } = useOrders();
  const toast = useToast();
  const sellsInHonduras = checkout.country === "Honduras";
  const checkoutFees = useMemo(
    () => calculateCheckoutFees({ subtotal, paymentMethod: checkout.paymentMethod, paymentTiming: checkout.paymentTiming, settings }),
    [checkout.paymentMethod, checkout.paymentTiming, settings, subtotal],
  );
  const paymentMethods = useMemo(() => {
    const methods: Array<[CheckoutData["paymentMethod"], typeof Banknote]> = [];
    if (settings.allow_bank_transfer) {
      methods.push(["Transferencia bancaria", Banknote]);
    }
    if (settings.bac_card_status === "active") {
      methods.push(["Tarjeta", CreditCard]);
    }
    if (settings.allow_cash_on_delivery) {
      methods.push(["Efectivo", Store]);
    }
    return methods;
  }, [settings.allow_bank_transfer, settings.allow_cash_on_delivery, settings.bac_card_status]);
  const smallOrderFee = 0;
  const discountTotal = 0;
  const additionalFees: [] = [];
  const finalTotal = Math.round((subtotal + tax + checkoutFees.shippingFee + checkoutFees.cashOnDeliveryFee + smallOrderFee - discountTotal) * 100) / 100;
  const wholesaleMinimumMissing = Math.max(0, Math.round((settings.first_wholesale_minimum - finalTotal) * 100) / 100);
  const effectiveIsFirstWholesalePurchase = wholesaleAccount ? isFirstWholesalePurchase : true;
  const wholesaleMinimumApplies =
    priceMode === "wholesale" &&
    Boolean(wholesaleAccount) &&
    effectiveIsFirstWholesalePurchase &&
    settings.first_wholesale_minimum > 0;
  const blocksFirstWholesaleOrder = wholesaleMinimumApplies && wholesaleMinimumMissing > 0;
  const blocksWholesalePurchases = priceMode === "wholesale" && !settings.wholesale_purchases_enabled;
  const blocksWholesaleQuantityMinimum = priceMode === "wholesale" && wholesaleQuantityIssues.length > 0;

  const wholesaleMinimumBlockMessage = `Tu primera compra mayorista debe alcanzar un total final de ${formatCurrency(settings.first_wholesale_minimum)} o más. Te faltan ${formatCurrency(wholesaleMinimumMissing)} para completar el mínimo de primera compra mayorista.`;
  const wholesaleQuantityBlockMessage =
    wholesaleQuantityIssues.length === 1
      ? `No se puede crear el pedido. El producto ${wholesaleQuantityIssues[0].productName} requiere mínimo ${wholesaleQuantityIssues[0].minimumQuantity} unidades para compra mayorista.`
      : `No se puede crear el pedido. Corrige las cantidades mínimas mayoristas antes de crear el pedido: ${wholesaleQuantityIssues
          .map((issue) => `${issue.productName} requiere mínimo ${issue.minimumQuantity}`)
          .join("; ")}.`;

  useEffect(() => {
    let active = true;

    getCheckoutAccountAction().then((account) => {
      if (active) {
        setAccountInfo(account);
        setCheckout((current) => mergeCheckoutAccount(current, account));
      }
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (paymentMethods.length === 0) {
      return;
    }

    if (!paymentMethods.some(([method]) => method === checkout.paymentMethod)) {
      updateCheckoutField("paymentMethod", paymentMethods[0][0]);
    }
  }, [checkout.paymentMethod, paymentMethods]);

  useEffect(() => {
    let active = true;

    if (!wholesaleAccount?.customerId) {
      return;
    }

    getWholesalePurchaseStatusAction(wholesaleAccount.customerId).then((result) => {
      if (active) {
        setIsFirstWholesalePurchase(result.isFirstWholesalePurchase);
      }
    });

    return () => {
      active = false;
    };
  }, [wholesaleAccount?.customerId]);

  function showCheckoutError(field: string, message: string) {
    setFieldErrors((current) => ({ ...current, [field]: message }));
    setCheckoutMessage(message);
    toast.error(message);
  }

  function updateCheckoutField<K extends keyof CheckoutData>(field: K, value: CheckoutData[K]) {
    setCheckout((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => {
      if (!current[field]) {
        return current;
      }
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function submitOrder() {
    if (!sellsInHonduras) {
      showCheckoutError("country", "Actualmente solo realizamos entregas dentro de Honduras.");
      return;
    }

    if (!checkout.customerName.trim()) {
      showCheckoutError("customerName", "Ingresa tu nombre para continuar.");
      return;
    }

    if (accountInfo.isAuthenticated) {
      if (!accountInfo.email) {
        showCheckoutError("email", "No pudimos validar el correo de tu cuenta. Cierra sesión e inicia sesión nuevamente.");
        return;
      }
    } else if (!emailPattern.test(checkout.email.trim())) {
      showCheckoutError("email", "Ingresa un correo válido para el pedido.");
      return;
    }

    const phone = validateHondurasPhone(checkout.phone);
    if (!phone.ok) {
      showCheckoutError("phone", "Ingresa un número de teléfono válido.");
      return;
    }

    if (!checkout.department.trim()) {
      showCheckoutError("department", "Selecciona el departamento de entrega.");
      return;
    }

    if (!checkout.city.trim()) {
      showCheckoutError("city", "Ingresa la ciudad o municipio de entrega.");
      return;
    }

    if (!checkout.address.trim()) {
      showCheckoutError("address", "Ingresa la dirección de entrega.");
      return;
    }

    if (rows.length === 0) {
      const message =
        invalidItemCount > 0
          ? "Hay un producto inválido en el carrito. Elimínalo y vuelve a intentar."
          : "Agrega productos al carrito para crear el pedido.";
      setCheckoutMessage(message);
      toast.warning(message);
      return;
    }

    if (invalidItemCount > 0) {
      const message = "Hay un producto inválido en el carrito. Elimínalo y vuelve a intentar.";
      setCheckoutMessage(message);
      toast.error(message);
      return;
    }

    const stockIssue = rows.find((item) => item.quantity > item.product.stock);
    if (stockIssue) {
      const message = `No puedes comprar ${stockIssue.quantity} unidades de ${stockIssue.product.name}; solo hay ${stockIssue.product.stock} disponibles.`;
      setCheckoutMessage(message);
      toast.warning(message);
      return;
    }

    const isBankTransfer = checkout.paymentMethod === "Transferencia bancaria";
    const isBankTransferNow = isBankTransfer && checkout.paymentTiming === "before_delivery";
    const bankTransferReference = checkout.bankTransferReference.trim();

    if (isBankTransfer && !settings.allow_bank_transfer) {
      showCheckoutError("paymentMethod", "La transferencia bancaria no está disponible en este momento.");
      return;
    }

    if (checkout.paymentMethod === "Efectivo" && !settings.allow_cash_on_delivery) {
      showCheckoutError("paymentMethod", "El pago contra entrega no está disponible en este momento.");
      return;
    }

    if (checkout.paymentMethod === "Tarjeta" && settings.bac_card_status !== "active") {
      showCheckoutError("paymentMethod", "El pago con tarjeta no está disponible hasta activar la pasarela BAC.");
      return;
    }

    const bankReferenceError = isBankTransferNow ? validateBankReference(bankTransferReference) : "";
    if (bankReferenceError) {
      showCheckoutError("bankTransferReference", bankReferenceError);
      return;
    }

    if (isBankTransferNow && proofMessage && !proofFile) {
      setCheckoutMessage(proofMessage);
      toast.error(proofMessage);
      return;
    }

    if (blocksWholesalePurchases) {
      const message = "Las compras mayoristas están desactivadas temporalmente.";
      setCheckoutMessage(message);
      toast.error(message);
      return;
    }

    if (blocksWholesaleQuantityMinimum) {
      setCheckoutMessage(wholesaleQuantityBlockMessage);
      toast.error(wholesaleQuantityBlockMessage);
      return;
    }

    if (blocksFirstWholesaleOrder) {
      setCheckoutMessage(wholesaleMinimumBlockMessage);
      toast.error(wholesaleMinimumBlockMessage);
      return;
    }

    startTransition(async () => {
      toast.loading("Creando pedido...");
      const items = rows.map((item) => ({
        productId: item.product.id,
        quantity: item.quantity,
      }));
      const formData = new FormData();
      const checkoutForOrder = {
        ...checkout,
        email: accountInfo.isAuthenticated ? accountInfo.email ?? "" : checkout.email.trim(),
        phone: phone.value,
      };

      formData.set("checkout", JSON.stringify(checkoutForOrder));
      formData.set("items", JSON.stringify(items));
      formData.set("priceMode", priceMode);

      if (isBankTransferNow && proofFile) {
        formData.set("transferReceipt", proofFile);
      }

      const result = await createCheckoutOrderAction(formData);

      if (!result.ok || !result.orderNumber || !result.trackingCode) {
        setCheckoutMessage(result.message);
        toast.error(result.message || "No se pudo crear el pedido. Revisa la información e intenta nuevamente.");
        return;
      }

      createOrder({
        orderNumber: result.orderNumber,
        trackingCode: result.trackingCode,
        customer: checkoutForOrder,
        items: rows.map((item) => ({
          productId: item.product.id,
          sku: item.product.sku,
          name: item.product.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          retailPriceSnapshot: item.product.retail_price,
          wholesalePriceSnapshot: item.product.wholesale_price,
        })),
        priceMode,
        wholesaleCode: null,
        subtotal,
        tax,
        shippingFee: checkoutFees.shippingFee,
        cashOnDeliveryFee: checkoutFees.cashOnDeliveryFee,
        smallOrderFee,
        discountTotal,
        additionalFees,
        total: finalTotal,
        paymentMethod: checkout.paymentMethod,
        paymentReference: isBankTransferNow ? bankTransferReference : null,
        paymentProofFileName: isBankTransferNow ? proofFileName || null : null,
        address: checkout.address,
        phone: phone.value,
        customerPhone: phone.value,
        paymentStatus: "pending_review",
      });

      setOrderNumber(result.orderNumber);
      setCheckoutMessage(result.message);
      setConfirmation({
        orderNumber: result.orderNumber,
        trackingCode: result.trackingCode,
        paymentMethod: checkout.paymentMethod,
        total: finalTotal,
        currentStatus:
          checkout.paymentMethod === "Transferencia bancaria"
            ? checkout.paymentTiming === "on_delivery"
              ? "Tu pago quedará pendiente hasta que recibas el pedido."
              : "Tu pedido está pendiente de revisión de pago."
            : checkout.paymentMethod === "Efectivo"
              ? "Tu pedido está pendiente de confirmación."
              : "Tu pedido será procesado cuando el pago sea aprobado.",
      });
      setFieldErrors({});
      toast.success("Pedido creado correctamente. Te contactaremos para confirmar el pago.");
      setProofFile(null);
      setProofFileName("");
      setProofMessage("");
      clearCart();
    });
  }

  return (
    <>
    <section className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[1fr_420px]">
      <div className="rounded-lg border border-black/10 bg-white p-5">
        <div className="flex flex-col justify-between gap-3 border-b border-black/10 pb-5 sm:flex-row sm:items-start">
          <div>
            <h1 className="text-2xl font-semibold">Finalizar compra</h1>
            <p className="mt-2 text-sm text-black/55">
              Precio aplicado: {priceMode === "wholesale" ? "precio mayorista" : "precio al detalle"}
            </p>
          </div>
          <p className="inline-flex w-fit items-center gap-2 rounded-md bg-[#fff1f2] px-3 py-2 text-sm font-medium text-[#b91c25]">
            <ShieldCheck size={17} />
            Pago seguro. Tu información está protegida.
          </p>
        </div>

        <div className="mt-5 grid gap-3">
          {([
            ["customerName", "Nombre del cliente", "Nombre del cliente"],
            ["phone", "Teléfono / WhatsApp", "Ej. 31986284"],
            ["rtn", "RTN para factura", "Opcional"],
          ] as const).map(([field, label, placeholder]) => (
            <label key={field} className="grid gap-1">
              <span className="text-xs font-medium uppercase text-black/50">{label}</span>
              <input
                value={checkout[field]}
                onChange={(event) => updateCheckoutField(field, event.target.value)}
                placeholder={placeholder}
                className={`w-full rounded-md border px-3 py-2 text-sm outline-none ${
                  fieldErrors[field] ? "border-[#e4252c]" : "border-black/10"
                }`}
              />
              {fieldErrors[field] ? <span className="text-xs text-[#9b341b]">{fieldErrors[field]}</span> : null}
            </label>
          ))}
          {accountInfo.isAuthenticated ? (
            <label className="grid gap-1">
              <span className="text-xs font-medium uppercase text-black/50">Correo de la cuenta</span>
              <input
                value={accountInfo.email ?? ""}
                disabled
                className="w-full rounded-md border border-black/10 bg-[#f4f4f5] px-3 py-2 text-sm text-black/70 outline-none"
              />
              <span className="text-xs text-black/50">El pedido usará el correo verificado de tu cuenta.</span>
              {fieldErrors.email ? <span className="text-xs text-[#9b341b]">{fieldErrors.email}</span> : null}
            </label>
          ) : (
            <label className="grid gap-1">
              <span className="text-xs font-medium uppercase text-black/50">Correo</span>
              <input
                type="email"
                value={checkout.email}
                onChange={(event) => updateCheckoutField("email", event.target.value)}
                placeholder="Correo"
                autoComplete="email"
                className={`w-full rounded-md border px-3 py-2 text-sm outline-none ${
                  fieldErrors.email ? "border-[#e4252c]" : "border-black/10"
                }`}
              />
              {fieldErrors.email ? <span className="text-xs text-[#9b341b]">{fieldErrors.email}</span> : null}
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-black/50">País de entrega</span>
            <input
              value={checkout.country}
              readOnly
              className="w-full rounded-md border border-black/10 bg-[#f4f4f5] px-3 py-2 text-sm outline-none"
            />
            <span className="mt-1 block text-xs text-black/50">
              Por ahora solo realizamos entregas dentro de Honduras.
            </span>
          </label>
          {!sellsInHonduras ? (
            <p className="rounded-md bg-[#fff0ea] p-3 text-sm font-medium text-[#9b341b]">
              Actualmente solo realizamos entregas dentro de Honduras.
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1">
              <span className="text-xs font-medium uppercase text-black/50">Departamento</span>
              <select
                value={checkout.department}
                onChange={(event) => updateCheckoutField("department", event.target.value)}
                className={`w-full rounded-md border bg-white px-3 py-2 text-sm outline-none ${
                  fieldErrors.department ? "border-[#e4252c]" : "border-black/10"
                }`}
              >
                <option value="">Seleccionar departamento</option>
                {hondurasDepartments.map((department) => (
                  <option key={department} value={department}>
                    {department}
                  </option>
                ))}
              </select>
              {fieldErrors.department ? <span className="text-xs text-[#9b341b]">{fieldErrors.department}</span> : null}
            </label>
            <label className="grid gap-1">
              <span className="text-xs font-medium uppercase text-black/50">Ciudad o municipio</span>
              <input
                value={checkout.city}
                onChange={(event) => updateCheckoutField("city", event.target.value)}
                placeholder="Ej. San Pedro Sula"
                className={`w-full rounded-md border px-3 py-2 text-sm outline-none ${
                  fieldErrors.city ? "border-[#e4252c]" : "border-black/10"
                }`}
              />
              {fieldErrors.city ? <span className="text-xs text-[#9b341b]">{fieldErrors.city}</span> : null}
            </label>
          </div>
          <input
            value={checkout.address}
            onChange={(event) => updateCheckoutField("address", event.target.value)}
            placeholder="Dirección de entrega"
            className={`w-full rounded-md border px-3 py-2 text-sm outline-none ${
              fieldErrors.address ? "border-[#e4252c]" : "border-black/10"
            }`}
          />
          {fieldErrors.address ? <span className="text-xs text-[#9b341b]">{fieldErrors.address}</span> : null}
          <div className="mt-2">
            <p className="mb-2 text-sm font-semibold">Método de pago</p>
            <div className="grid gap-2 sm:grid-cols-3">
            {paymentMethods.map(([method, Icon]) => (
              <button
                key={method as string}
                onClick={() => {
                  setCheckout((current) => ({
                    ...current,
                    paymentMethod: method as CheckoutData["paymentMethod"],
                    paymentTiming: method === "Efectivo" ? "on_delivery" : method === "Tarjeta" ? "before_delivery" : current.paymentTiming,
                  }));
                  if (method !== "Transferencia bancaria") {
                    setProofFileName("");
                    setProofFile(null);
                    setProofMessage("");
                  }
                  setCheckoutMessage("");
                }}
                className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-md border px-2 text-xs ${
                  checkout.paymentMethod === method ? "border-[#e4252c] bg-[#fff1f2]" : "border-black/10"
                }`}
              >
                <Icon size={17} />
                {method as string}
              </button>
            ))}
            </div>
          </div>

          {checkout.paymentMethod === "Transferencia bancaria" ? (
            <section className="rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
              <div className="flex items-start gap-3">
                <Banknote size={19} className="mt-0.5 text-[#e4252c]" />
                <div>
                  <h2 className="font-semibold">Transferencia bancaria</h2>
                  <p className="mt-1 text-sm text-black/60">
                    Elige si transferirás antes del envío o cuando recibas tu pedido.
                  </p>
                </div>
              </div>
              <div className="mt-4 grid gap-2">
                <label className="flex gap-3 rounded-md border border-black/10 bg-white p-3 text-sm">
                  <input
                    type="radio"
                    name="paymentTiming"
                    checked={checkout.paymentTiming === "before_delivery"}
                    onChange={() => updateCheckoutField("paymentTiming", "before_delivery")}
                    className="mt-1 accent-[#e4252c]"
                  />
                  <span>
                    <span className="block font-semibold">Transferencia ahora</span>
                    <span className="mt-1 block text-black/55">Ya hice o haré la transferencia antes de enviar el pedido.</span>
                  </span>
                </label>
                <label className="flex gap-3 rounded-md border border-black/10 bg-white p-3 text-sm">
                  <input
                    type="radio"
                    name="paymentTiming"
                    checked={checkout.paymentTiming === "on_delivery"}
                    onChange={() => {
                      updateCheckoutField("paymentTiming", "on_delivery");
                      updateCheckoutField("bankTransferReference", "");
                      setProofFileName("");
                      setProofFile(null);
                      setProofMessage("");
                    }}
                    className="mt-1 accent-[#e4252c]"
                  />
                  <span>
                    <span className="block font-semibold">Transferencia al recibir</span>
                    <span className="mt-1 block text-black/55">Haré la transferencia cuando reciba el pedido. Aplica tarifa contra entrega.</span>
                  </span>
                </label>
              </div>
              {checkout.paymentTiming === "before_delivery" ? (
              <>
              <label className="mt-4 block">
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">
                  Número de referencia bancaria
                </span>
                <input
                  value={checkout.bankTransferReference}
                  onChange={(event) =>
                    updateCheckoutField("bankTransferReference", event.target.value)
                  }
                  placeholder="Ej. 123456789"
                  className={`w-full rounded-md border bg-white px-3 py-2 text-sm outline-none ${
                    fieldErrors.bankTransferReference ? "border-[#e4252c]" : "border-black/10"
                  }`}
                />
                {fieldErrors.bankTransferReference ? (
                  <span className="mt-1 block text-xs text-[#9b341b]">{fieldErrors.bankTransferReference}</span>
                ) : null}
                <span className="mt-1 block text-xs text-black/50">
                  Ingresa el número de referencia de tu transferencia o depósito.
                </span>
              </label>
              <div className="mt-4">
                <p className="mb-1 text-xs font-medium uppercase text-black/50">Comprobante de transferencia (opcional)</p>
                <p className="mb-2 text-xs text-black/50">
                  Puedes subir una imagen o PDF para ayudarnos a validar más rápido tu pago.
                </p>
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-black/20 bg-white px-4 py-4 text-sm font-medium">
                  <Upload size={17} />
                  {proofFileName || "Subir comprobante opcional"}
                  <input
                    type="file"
                    accept="image/*,.pdf"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      if (!file) {
                        setProofFile(null);
                        setProofFileName("");
                        setProofMessage("");
                        return;
                      }

                      const isAllowedType = file.type.startsWith("image/") || file.type === "application/pdf";
                      if (!isAllowedType) {
                        const message = "El comprobante debe ser imagen o PDF.";
                        setProofFile(null);
                        setProofFileName("");
                        setProofMessage(message);
                        toast.error(message);
                        return;
                      }

                      if (file.size > 8 * 1024 * 1024) {
                        const message = "El comprobante no debe superar 8 MB.";
                        setProofFile(null);
                        setProofFileName("");
                        setProofMessage(message);
                        toast.error(message);
                        return;
                      }

                      setProofFile(file);
                      setProofFileName(file.name);
                      setProofMessage("Comprobante listo para subir al crear el pedido.");
                      toast.success("Comprobante listo para subir al crear el pedido.");
                    }}
                  />
                </label>
              </div>
              {proofMessage ? (
                <p
                  className={`mt-2 rounded-md px-3 py-2 text-xs ${
                    proofFile ? "bg-[#fff1f2] text-[#b91c25]" : "bg-[#fff0ea] text-[#9b341b]"
                  }`}
                >
                  {proofMessage}
                </p>
              ) : null}
              </>
              ) : (
                <p className="mt-4 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
                  Este pedido tendrá tarifa contra entrega porque el pago se realizará al recibir. No necesitas referencia bancaria todavía.
                </p>
              )}
            </section>
          ) : null}

          {checkout.paymentMethod === "Tarjeta" ? (
            <section className="rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
              <div className="flex items-start gap-3">
                <CreditCard size={19} className="mt-0.5 text-[#e4252c]" />
                <div>
                  <h2 className="font-semibold">Pago seguro con tarjeta</h2>
                  <p className="mt-1 text-sm text-black/60">
                    {settings.bac_card_status === "active"
                      ? "Opción activa para procesarse mediante BAC Credomatic o su proveedor autorizado."
                      : "Pendiente de activación BAC. Esta opción queda preparada para procesarse mediante BAC Credomatic o su proveedor autorizado."}
                  </p>
                </div>
              </div>
              <div className="mt-4 rounded-md border border-[#e4252c]/20 bg-white p-3 text-sm leading-6 text-black/65">
                <p>No guardamos número de tarjeta, CVV ni fecha de vencimiento en nuestra base de datos.</p>
                <p>Compatible con validación bancaria y 3D Secure cuando BAC lo requiera y entregue la documentación técnica.</p>
                <p>El pedido quedará pendiente de aprobación hasta recibir la respuesta de la pasarela.</p>
              </div>
              <div className="mt-4">
                <p className="mb-2 text-xs font-medium uppercase text-black/50">Tarjetas aceptadas al activar la pasarela</p>
                <CardBrandList />
              </div>
            </section>
          ) : null}

          {checkout.paymentMethod === "Efectivo" ? (
            <section className="rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
              <div className="flex items-start gap-3">
                <Store size={19} className="mt-0.5 text-[#e4252c]" />
                <div>
                  <h2 className="font-semibold">Pago contra entrega</h2>
                  <p className="mt-1 text-sm text-black/60">
                    Pagarás en efectivo al recibir tu pedido. Puede aplicar tarifa contra entrega.
                  </p>
                </div>
              </div>
            </section>
          ) : null}

          {checkoutMessage ? (
            <p
              className={`rounded-md p-3 text-sm ${
                orderNumber ? "bg-[#fff1f2] text-[#b91c25]" : "bg-[#fff0ea] text-[#9b341b]"
              }`}
            >
              {checkoutMessage}
            </p>
          ) : null}

          <button
            onClick={submitOrder}
            disabled={!sellsInHonduras || isPending || paymentMethods.length === 0}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#e4252c] px-4 py-3 text-sm font-semibold text-white"
          >
            <BadgeCheck size={18} />
            {isPending ? "Creando pedido..." : "Crear pedido"}
          </button>
        </div>
      </div>

      <aside className="h-fit rounded-lg border border-black/10 bg-white p-5">
        <h2 className="font-semibold">Pedido</h2>
        <div className="mt-4 space-y-3">
          {invalidItemCount > 0 ? (
            <div className="rounded-md bg-[#fff0ea] p-3 text-sm text-[#9b341b]">
              <p className="font-medium">Uno de los productos de tu carrito ya no está disponible.</p>
              <button
                type="button"
                onClick={clearInvalidCartItems}
                className="mt-2 rounded-md bg-[#9b341b] px-3 py-2 text-xs font-semibold text-white"
              >
                Limpiar carrito
              </button>
            </div>
          ) : null}
          {blocksWholesaleQuantityMinimum ? (
            <div className="rounded-md bg-[#fff0ea] p-3 text-sm text-[#9b341b]">
              <p className="font-medium">Corrige las cantidades mínimas mayoristas antes de crear el pedido.</p>
              <ul className="mt-2 space-y-1">
                {wholesaleQuantityIssues.map((issue) => (
                  <li key={issue.productId}>
                    {issue.productName}: mínimo {issue.minimumQuantity} unidades, tienes {issue.currentQuantity}.
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {rows.length === 0 ? (
            <p className="rounded-md bg-[#f4f4f5] p-4 text-sm text-black/55">Agrega productos para continuar.</p>
          ) : (
            rows.map((item) => (
              <div key={item.product.id} className="space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <span>
                    {item.quantity} x {item.product.name}
                  </span>
                  <span>{formatCurrency(item.lineTotal)}</span>
                </div>
                {wholesaleQuantityIssues.some((issue) => issue.productId === item.product.id) ? (
                  <p className="text-xs font-medium text-[#9b341b]">
                    Este producto requiere mínimo {item.product.wholesale_min_quantity} unidades para precio mayorista.
                  </p>
                ) : null}
              </div>
            ))
          )}
        </div>
        {wholesaleAccount ? (
          <p className="mt-4 rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">
            Cuenta mayorista aprobada: {wholesaleAccount.businessName}
          </p>
        ) : null}
        {blocksWholesalePurchases ? (
          <p className="mt-3 rounded-md bg-[#fff0ea] p-3 text-sm text-[#9b341b]">
            Las compras mayoristas están desactivadas temporalmente.
          </p>
        ) : null}
        {wholesaleAccount && wholesaleMinimumApplies ? (
          <div
            className={`mt-3 rounded-md p-3 text-sm ${
              blocksFirstWholesaleOrder ? "bg-[#fff0ea] text-[#9b341b]" : "bg-[#fff1f2] text-[#b91c25]"
            }`}
          >
            <p>
              {blocksFirstWholesaleOrder
                ? `Tu primera compra mayorista debe alcanzar un total final de ${formatCurrency(settings.first_wholesale_minimum)} o más. Te faltan ${formatCurrency(wholesaleMinimumMissing)} para completar el mínimo de primera compra mayorista.`
                : "Has alcanzado el mínimo requerido para tu primera compra mayorista."}
            </p>
            <p className="mt-1 text-xs opacity-80">
              Se calcula con el mismo total final que aparece como Total a pagar.
            </p>
          </div>
        ) : null}
        <CheckoutTotals
          subtotal={subtotal}
          tax={tax}
          shippingFee={checkoutFees.shippingFee}
          cashOnDeliveryFee={checkoutFees.cashOnDeliveryFee}
          smallOrderFee={smallOrderFee}
          discountTotal={discountTotal}
          additionalFeesTotal={0}
          total={finalTotal}
          settings={settings}
          paymentMethod={checkout.paymentMethod}
          paymentTiming={checkout.paymentTiming}
        />
        {orderNumber ? (
          <div className="mt-5 rounded-md bg-[#fff1f2] p-4 text-sm">
            <p className="font-semibold">Pedido creado: {orderNumber}</p>
            <p className="mt-1 text-black/60">La factura usará {priceMode === "wholesale" ? "precio mayorista" : "precio al detalle"}.</p>
          </div>
        ) : null}
      </aside>
    </section>
    {confirmation ? (
      <div className="cz-layer-modal fixed inset-0 grid place-items-center bg-black/45 px-4 py-6">
        <section className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 text-[#080808] shadow-xl">
          <div className="grid size-12 place-items-center rounded-md bg-[#fff1f2] text-[#b91c25]">
            <BadgeCheck size={24} />
          </div>
          <h2 className="mt-4 text-2xl font-semibold">Pedido creado correctamente</h2>
          <p className="mt-2 text-sm text-black/60">
            Gracias por tu compra. Guarda este código para consultar el estado de tu pedido.
          </p>

          <div className="mt-5 space-y-2 rounded-lg border border-black/10 bg-[#f4f4f5] p-4 text-sm">
            <InfoRow label="Número de pedido" value={confirmation.orderNumber} />
            <InfoRow label="Código de seguimiento" value={confirmation.trackingCode} strong />
            <InfoRow label="Método de pago" value={confirmation.paymentMethod} />
            <InfoRow label="Estado actual" value={confirmation.currentStatus} />
            <InfoRow label="Total" value={formatCurrency(confirmation.total)} strong />
          </div>

          <div className="mt-5 grid gap-2 sm:grid-cols-3">
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(confirmation.trackingCode);
                toast.success("Código de seguimiento copiado.");
              }}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm font-semibold"
            >
              <Copy size={16} />
              Copiar código
            </button>
            <Link
              href={`/rastreo?codigo=${encodeURIComponent(confirmation.trackingCode)}`}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-[#e4252c] px-3 py-2 text-sm font-semibold text-white"
            >
              <SearchCheck size={16} />
              Ver estado
            </Link>
            <Link
              href="/"
              className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm font-semibold"
            >
              <Home size={16} />
              Volver al inicio
            </Link>
          </div>
        </section>
      </div>
    ) : null}
    </>
  );
}

function InfoRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-black/55">{label}</span>
      <span className={`text-right ${strong ? "font-semibold" : "font-medium"}`}>{value}</span>
    </div>
  );
}

function CheckoutTotals({
  subtotal,
  tax,
  shippingFee,
  cashOnDeliveryFee,
  smallOrderFee,
  discountTotal,
  additionalFeesTotal,
  total,
  settings,
  paymentMethod,
  paymentTiming,
}: {
  subtotal: number;
  tax: number;
  shippingFee: number;
  cashOnDeliveryFee: number;
  smallOrderFee: number;
  discountTotal: number;
  additionalFeesTotal: number;
  total: number;
  settings: PublicCompanySettings;
  paymentMethod: CheckoutData["paymentMethod"];
  paymentTiming: CheckoutData["paymentTiming"];
}) {
  const hasFreeShipping = shippingFee === 0 && subtotal >= settings.free_shipping_threshold;

  return (
    <div className="mt-4 space-y-2 border-t border-black/10 pt-4 text-sm">
      <p className="text-xs font-semibold uppercase text-black/50">Resumen financiero</p>
      <div className="flex justify-between">
        <span>Subtotal productos</span>
        <span>{formatCurrency(subtotal)}</span>
      </div>
      <div className="flex justify-between">
        <span>ISV</span>
        <span>{formatCurrency(tax)}</span>
      </div>
      <div className="flex justify-between">
        <span>{hasFreeShipping ? "Envío gratis" : "Envío estándar"}</span>
        <span>{shippingFee === 0 ? "Gratis" : formatCurrency(shippingFee)}</span>
      </div>
      {(paymentMethod === "Efectivo" || (paymentMethod === "Transferencia bancaria" && paymentTiming === "on_delivery")) &&
      settings.enable_cash_on_delivery_fee ? (
        <div className="flex justify-between">
          <span>Cargo contra entrega</span>
          <span>{formatCurrency(cashOnDeliveryFee)}</span>
        </div>
      ) : null}
      <div className="flex justify-between">
        <span>Recargo pedido minimo</span>
        <span>{formatCurrency(smallOrderFee)}</span>
      </div>
      <div className="flex justify-between">
        <span>Descuentos</span>
        <span>{discountTotal > 0 ? `-${formatCurrency(discountTotal)}` : formatCurrency(0)}</span>
      </div>
      <div className="flex justify-between">
        <span>Otros cargos</span>
        <span>{formatCurrency(additionalFeesTotal)}</span>
      </div>
      <div className="rounded-md bg-[#f4f4f5] p-3 text-xs text-black/60">
        <p>El envío es gratis en compras mayores o iguales a {formatCurrency(settings.free_shipping_threshold)}.</p>
        <p>Para compras menores aplica envío estándar de {formatCurrency(settings.standard_shipping_fee)}.</p>
        <p>El pago al recibir puede incluir una comisión adicional definida por la empresa de entrega.</p>
      </div>
      {paymentMethod === "Efectivo" || (paymentMethod === "Transferencia bancaria" && paymentTiming === "on_delivery") ? (
        <p className="rounded-md bg-[#fff7ed] p-3 text-xs text-[#7c2d12]">
          Este pedido tendrá tarifa contra entrega porque el pago se realizará al recibir.
        </p>
      ) : null}
      <div className="flex justify-between text-lg font-semibold">
        <span>Total a pagar</span>
        <span>{formatCurrency(total)}</span>
      </div>
    </div>
  );
}


