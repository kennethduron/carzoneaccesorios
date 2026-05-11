"use client";

import { useState, useTransition } from "react";
import { BadgeCheck, Banknote, CreditCard, ShieldCheck, Store, Upload } from "lucide-react";
import { createCheckoutOrderAction } from "@/app/checkout/actions";
import type { CheckoutData } from "@/types/commerce";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useShoppingCart } from "@/contexts/cart-context";
import { useOrders } from "@/contexts/orders-context";
import { Totals } from "@/components/store/cart-view";
import { formatCurrency } from "@/utils/pricing";
import { validateHondurasPhone } from "@/utils/validation";

const emptyCheckout: CheckoutData = {
  customerName: "",
  email: "",
  phone: "",
  rtn: "",
  country: "Honduras",
  address: "",
  paymentMethod: "Transferencia bancaria",
  bankTransferReference: "",
};

export function CheckoutView() {
  const [checkout, setCheckout] = useState<CheckoutData>(emptyCheckout);
  const [proofFileName, setProofFileName] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [checkoutMessage, setCheckoutMessage] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [isPending, startTransition] = useTransition();
  const { priceMode, wholesaleAccount } = usePriceMode();
  const { rows, subtotal, tax, total, clearCart } = useShoppingCart();
  const { createOrder } = useOrders();
  const sellsInHonduras = checkout.country === "Honduras";

  function submitOrder() {
    if (!sellsInHonduras) {
      setCheckoutMessage("Actualmente solo realizamos ventas dentro de Honduras.");
      return;
    }

    const phone = validateHondurasPhone(checkout.phone);
    if (!phone.ok) {
      setCheckoutMessage(phone.message);
      return;
    }

    if (!checkout.customerName || !checkout.address || rows.length === 0) {
      setCheckoutMessage("Completa tus datos y agrega productos para crear el pedido.");
      return;
    }

    const stockIssue = rows.find((item) => item.quantity > item.product.stock);
    if (stockIssue) {
      setCheckoutMessage(
        `No puedes comprar ${stockIssue.quantity} unidades de ${stockIssue.product.name}; solo hay ${stockIssue.product.stock} disponibles.`,
      );
      return;
    }

    const isBankTransfer = checkout.paymentMethod === "Transferencia bancaria";
    const bankTransferReference = checkout.bankTransferReference.trim();

    if (isBankTransfer && !bankTransferReference) {
      setCheckoutMessage("Debes ingresar el número de referencia de la transferencia.");
      return;
    }

    startTransition(async () => {
      const items = rows.map((item) => ({
        productId: item.product.id,
        quantity: item.quantity,
      }));
      const formData = new FormData();

      formData.set("checkout", JSON.stringify({ ...checkout, phone: phone.value }));
      formData.set("items", JSON.stringify(items));
      formData.set("priceMode", priceMode);
      formData.set("wholesaleCode", wholesaleAccount?.code ?? "");
      formData.set("wholesaleCodeId", wholesaleAccount?.id ?? "");

      if (isBankTransfer && proofFile) {
        formData.set("transferReceipt", proofFile);
      }

      const result = await createCheckoutOrderAction(formData);

      if (!result.ok || !result.orderNumber) {
        setCheckoutMessage(result.message);
        return;
      }

      createOrder({
        orderNumber: result.orderNumber,
        customer: { ...checkout, phone: phone.value },
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
        wholesaleCode: wholesaleAccount?.code ?? null,
        subtotal,
        tax,
        total,
        paymentMethod: checkout.paymentMethod,
        paymentReference: isBankTransfer ? bankTransferReference : null,
        paymentProofFileName: isBankTransfer ? proofFileName || null : null,
        address: checkout.address,
        phone: phone.value,
        customerPhone: phone.value,
        paymentStatus: "pending_review",
      });

      setOrderNumber(result.orderNumber);
      setCheckoutMessage(result.message);
      setProofFile(null);
      setProofFileName("");
      clearCart();
    });
  }

  return (
    <section className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[1fr_420px]">
      <div className="rounded-lg border border-black/10 bg-white p-5">
        <div className="flex flex-col justify-between gap-3 border-b border-black/10 pb-5 sm:flex-row sm:items-start">
          <div>
            <h1 className="text-2xl font-semibold">Checkout</h1>
            <p className="mt-2 text-sm text-black/55">
              Precio aplicado: {priceMode === "wholesale" ? "precio mayorista" : "precio al detalle"}
            </p>
          </div>
          <p className="inline-flex w-fit items-center gap-2 rounded-md bg-[#e8f3f2] px-3 py-2 text-sm font-medium text-[#1e5960]">
            <ShieldCheck size={17} />
            Pago seguro. Tu información está protegida.
          </p>
        </div>

        <div className="mt-5 grid gap-3">
          {([
            ["customerName", "Nombre del cliente", "Nombre del cliente"],
            ["email", "Correo", "Correo"],
            ["phone", "Teléfono / WhatsApp", "Ej. 31986284"],
            ["rtn", "RTN para factura", "Opcional"],
          ] as const).map(([field, label, placeholder]) => (
            <label key={field} className="grid gap-1">
              <span className="text-xs font-medium uppercase text-black/50">{label}</span>
              <input
                value={checkout[field]}
                onChange={(event) => setCheckout((current) => ({ ...current, [field]: event.target.value }))}
                placeholder={placeholder}
                className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
              />
            </label>
          ))}
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-black/50">País de entrega</span>
            <select
              value={checkout.country}
              onChange={(event) => {
                const country = event.target.value;
                setCheckout((current) => ({ ...current, country }));
                setCheckoutMessage(
                  country === "Honduras"
                    ? ""
                    : "Actualmente solo realizamos ventas dentro de Honduras.",
                );
              }}
              className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
            >
              <option>Honduras</option>
              <option>Guatemala</option>
              <option>El Salvador</option>
              <option>Nicaragua</option>
              <option>Costa Rica</option>
              <option>Panamá</option>
              <option>Otro país</option>
            </select>
          </label>
          {!sellsInHonduras ? (
            <p className="rounded-md bg-[#fff0ea] p-3 text-sm font-medium text-[#9b341b]">
              Actualmente solo realizamos ventas dentro de Honduras.
            </p>
          ) : null}
          <input
            value={checkout.address}
            onChange={(event) => setCheckout((current) => ({ ...current, address: event.target.value }))}
            placeholder="Dirección de entrega"
            className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
          />
          <div className="mt-2">
            <p className="mb-2 text-sm font-semibold">Método de pago</p>
            <div className="grid gap-2 sm:grid-cols-3">
            {[
              ["Transferencia bancaria", Banknote],
              ["Tarjeta", CreditCard],
              ["Efectivo", Store],
            ].map(([method, Icon]) => (
              <button
                key={method as string}
                onClick={() => {
                  setCheckout((current) => ({ ...current, paymentMethod: method as CheckoutData["paymentMethod"] }));
                  if (method !== "Transferencia bancaria") {
                    setProofFileName("");
                    setProofFile(null);
                  }
                  setCheckoutMessage("");
                }}
                className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-md border px-2 text-xs ${
                  checkout.paymentMethod === method ? "border-[#246a73] bg-[#e8f3f2]" : "border-black/10"
                }`}
              >
                <Icon size={17} />
                {method as string}
              </button>
            ))}
            </div>
          </div>

          {checkout.paymentMethod === "Transferencia bancaria" ? (
            <section className="rounded-lg border border-black/10 bg-[#f7f7f2] p-4">
              <div className="flex items-start gap-3">
                <Banknote size={19} className="mt-0.5 text-[#246a73]" />
                <div>
                  <h2 className="font-semibold">Transferencia bancaria</h2>
                  <p className="mt-1 text-sm text-black/60">
                    Realiza la transferencia e ingresa la referencia bancaria para que contabilidad confirme el pago.
                  </p>
                </div>
              </div>
              <label className="mt-4 block">
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">
                  Número de referencia de la transferencia
                </span>
                <input
                  value={checkout.bankTransferReference}
                  onChange={(event) =>
                    setCheckout((current) => ({ ...current, bankTransferReference: event.target.value }))
                  }
                  placeholder="Ej. 839201746"
                  className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
                />
                <span className="mt-1 block text-xs text-black/50">
                  Ingresa el número de referencia que aparece en tu comprobante bancario.
                </span>
              </label>
              <label className="mt-4 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-black/20 bg-white px-4 py-4 text-sm font-medium">
                <Upload size={17} />
                {proofFileName || "Subir comprobante si aplica"}
                <input
                  type="file"
                  accept="image/*,.pdf"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    setProofFile(file);
                    setProofFileName(file?.name ?? "");
                  }}
                />
              </label>
            </section>
          ) : null}

          {checkout.paymentMethod === "Tarjeta" ? (
            <section className="rounded-lg border border-black/10 bg-[#f7f7f2] p-4">
              <div className="flex items-start gap-3">
                <CreditCard size={19} className="mt-0.5 text-[#246a73]" />
                <div>
                  <h2 className="font-semibold">Tarjeta de crédito/débito</h2>
                  <p className="mt-1 text-sm text-black/60">
                    Preparado para conectar una pasarela de pago. El pedido quedará pendiente de autorización.
                  </p>
                </div>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <input disabled placeholder="Número de tarjeta" className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm text-black/40" />
                <input disabled placeholder="MM/AA  CVC" className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm text-black/40" />
              </div>
            </section>
          ) : null}

          {checkout.paymentMethod === "Efectivo" ? (
            <section className="rounded-lg border border-black/10 bg-[#f7f7f2] p-4">
              <div className="flex items-start gap-3">
                <Store size={19} className="mt-0.5 text-[#246a73]" />
                <div>
                  <h2 className="font-semibold">Pago contra entrega</h2>
                  <p className="mt-1 text-sm text-black/60">
                    Pagarás en efectivo al recibir tu pedido. Nuestro equipo confirmará disponibilidad y despacho.
                  </p>
                </div>
              </div>
            </section>
          ) : null}

          {checkoutMessage ? (
            <p
              className={`rounded-md p-3 text-sm ${
                orderNumber ? "bg-[#e8f3f2] text-[#1e5960]" : "bg-[#fff0ea] text-[#9b341b]"
              }`}
            >
              {checkoutMessage}
            </p>
          ) : null}

          <button
            onClick={submitOrder}
            disabled={!sellsInHonduras || isPending}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#246a73] px-4 py-3 text-sm font-semibold text-white"
          >
            <BadgeCheck size={18} />
            {isPending ? "Creando pedido" : "Crear pedido"}
          </button>
        </div>
      </div>

      <aside className="h-fit rounded-lg border border-black/10 bg-white p-5">
        <h2 className="font-semibold">Pedido</h2>
        <div className="mt-4 space-y-3">
          {rows.length === 0 ? (
            <p className="rounded-md bg-[#f7f7f2] p-4 text-sm text-black/55">Agrega productos para continuar.</p>
          ) : (
            rows.map((item) => (
              <div key={item.product.id} className="flex justify-between gap-3 text-sm">
                <span>
                  {item.quantity} x {item.product.name}
                </span>
                <span>{formatCurrency(item.lineTotal)}</span>
              </div>
            ))
          )}
        </div>
        {wholesaleAccount ? (
          <p className="mt-4 rounded-md bg-[#f7f7f2] p-3 text-sm text-black/60">
            Código mayorista: {wholesaleAccount.code}
          </p>
        ) : null}
        <Totals subtotal={subtotal} tax={tax} total={total} />
        {orderNumber ? (
          <div className="mt-5 rounded-md bg-[#e8f3f2] p-4 text-sm">
            <p className="font-semibold">Pedido creado: {orderNumber}</p>
            <p className="mt-1 text-black/60">La factura usará {priceMode === "wholesale" ? "precio mayorista" : "precio al detalle"}.</p>
          </div>
        ) : null}
      </aside>
    </section>
  );
}
