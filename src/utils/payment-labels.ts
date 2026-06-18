export const paymentMethodLabels: Record<string, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta",
  cash: "Efectivo",
  commercial_credit: "Crédito comercial",
};

export const detailedPaymentMethodLabels: Record<string, string> = {
  ...paymentMethodLabels,
  card: "Tarjeta mediante enlace de pago",
};

export function paymentMethodLabel(method: string | null | undefined, options: { detailedCard?: boolean } = {}) {
  if (!method) return "-";
  const labels = options.detailedCard ? detailedPaymentMethodLabels : paymentMethodLabels;
  if (labels[method]) return labels[method];
  return method.includes("_") ? "Método no especificado" : method;
}
