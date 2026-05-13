import type { CommerceSettings } from "@/types/settings";

export const defaultCommerceSettings: CommerceSettings = {
  free_shipping_threshold: 3000,
  standard_shipping_fee: 120,
  cash_on_delivery_percentage: 5,
  enable_cash_on_delivery_fee: true,
  first_wholesale_minimum: 10000,
};

export function toPositiveMoney(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : fallback;
}

export function normalizeCommerceSettings(value: Partial<CommerceSettings> | null | undefined): CommerceSettings {
  return {
    free_shipping_threshold: toPositiveMoney(value?.free_shipping_threshold, defaultCommerceSettings.free_shipping_threshold),
    standard_shipping_fee: toPositiveMoney(value?.standard_shipping_fee, defaultCommerceSettings.standard_shipping_fee),
    cash_on_delivery_percentage: toPositiveMoney(
      value?.cash_on_delivery_percentage,
      defaultCommerceSettings.cash_on_delivery_percentage,
    ),
    enable_cash_on_delivery_fee: value?.enable_cash_on_delivery_fee ?? defaultCommerceSettings.enable_cash_on_delivery_fee,
    first_wholesale_minimum: toPositiveMoney(value?.first_wholesale_minimum, defaultCommerceSettings.first_wholesale_minimum),
  };
}

export function calculateCheckoutFees({
  subtotal,
  paymentMethod,
  settings,
}: {
  subtotal: number;
  paymentMethod: "Transferencia bancaria" | "Tarjeta" | "Efectivo" | "bank_transfer" | "card" | "cash";
  settings: CommerceSettings;
}) {
  const normalized = normalizeCommerceSettings(settings);
  const normalizedPaymentMethod =
    paymentMethod === "Transferencia bancaria" ? "bank_transfer" : paymentMethod === "Efectivo" ? "cash" : paymentMethod;
  const safeSubtotal = toPositiveMoney(subtotal, 0);
  const shippingFee = safeSubtotal >= normalized.free_shipping_threshold ? 0 : normalized.standard_shipping_fee;
  const cashOnDeliveryFee =
    normalizedPaymentMethod === "cash" && normalized.enable_cash_on_delivery_fee
      ? Math.round(safeSubtotal * (normalized.cash_on_delivery_percentage / 100) * 100) / 100
      : 0;

  return {
    shippingFee,
    cashOnDeliveryFee,
    totalFees: Math.round((shippingFee + cashOnDeliveryFee) * 100) / 100,
  };
}
