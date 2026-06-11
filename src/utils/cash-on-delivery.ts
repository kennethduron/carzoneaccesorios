type PaymentMethodLike = "Transferencia bancaria" | "Tarjeta" | "Tarjeta por link de pago" | "Efectivo" | "bank_transfer" | "card" | "cash" | string | null | undefined;
type PaymentTimingLike = "before_delivery" | "on_delivery" | string | null | undefined;

export function normalizePaymentMethod(value: PaymentMethodLike) {
  if (value === "Transferencia bancaria") return "bank_transfer";
  if (value === "Efectivo") return "cash";
  if (value === "Tarjeta" || value === "Tarjeta por link de pago") return "card";
  return String(value ?? "");
}

export function cashOnDeliveryApplies(paymentMethod: PaymentMethodLike, paymentTiming?: PaymentTimingLike) {
  const method = normalizePaymentMethod(paymentMethod);
  return method === "cash" || (method === "bank_transfer" && paymentTiming === "on_delivery");
}

export function isCashOnDeliveryPending(paymentMethod: PaymentMethodLike, paymentTiming: PaymentTimingLike, fee: unknown) {
  return cashOnDeliveryApplies(paymentMethod, paymentTiming) && Number(fee ?? 0) <= 0;
}

export function cashOnDeliveryLabel(paymentMethod: PaymentMethodLike, paymentTiming: PaymentTimingLike, fee: unknown) {
  if (!cashOnDeliveryApplies(paymentMethod, paymentTiming)) return "No aplica";
  return Number(fee ?? 0) > 0 ? null : "Pendiente de confirmación";
}
