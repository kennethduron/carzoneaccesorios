type PaymentMethodLike =
  | "Transferencia bancaria"
  | "Tarjeta"
  | "Tarjeta por link de pago"
  | "Tarjeta mediante enlace de pago"
  | "Efectivo"
  | "bank_transfer"
  | "card"
  | "cash"
  | string
  | null
  | undefined;
type PaymentTimingLike = "before_delivery" | "on_delivery" | string | null | undefined;
type DeliveryModeLike = "store_pickup" | "customer_arranged" | string | null | undefined;

export function normalizePaymentMethod(value: PaymentMethodLike) {
  if (value === "Transferencia bancaria") return "bank_transfer";
  if (value === "Efectivo") return "cash";
  if (value === "Tarjeta" || value === "Tarjeta por link de pago" || value === "Tarjeta mediante enlace de pago") return "card";
  return String(value ?? "");
}

export function normalizeAccountingDeliveryMode(value: DeliveryModeLike) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (!mode) return "home_delivery";
  if (mode === "store_pickup" || mode === "customer_arranged") return "pickup";
  if (mode === "car_zone" || mode === "external_company") return "home_delivery";
  return mode;
}

export function cashOnDeliveryApplies(
  paymentMethod: PaymentMethodLike,
  paymentTiming?: PaymentTimingLike,
  deliveryMode?: DeliveryModeLike,
) {
  const method = normalizePaymentMethod(paymentMethod);
  if (normalizeAccountingDeliveryMode(deliveryMode) === "pickup") return false;
  return method === "cash" || (method === "bank_transfer" && paymentTiming === "on_delivery");
}

export function isCashOnDeliveryPending(
  paymentMethod: PaymentMethodLike,
  paymentTiming: PaymentTimingLike,
  fee: unknown,
  deliveryMode?: DeliveryModeLike,
) {
  return cashOnDeliveryApplies(paymentMethod, paymentTiming, deliveryMode) && Number(fee ?? 0) <= 0;
}

export function cashOnDeliveryLabel(
  paymentMethod: PaymentMethodLike,
  paymentTiming: PaymentTimingLike,
  fee: unknown,
  deliveryMode?: DeliveryModeLike,
) {
  if (!cashOnDeliveryApplies(paymentMethod, paymentTiming, deliveryMode)) return "No aplica";
  return Number(fee ?? 0) > 0 ? null : "Pendiente de confirmación";
}
