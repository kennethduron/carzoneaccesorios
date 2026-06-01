export type OrderWorkflowStatus =
  | "recibido"
  | "confirmado"
  | "preparacion"
  | "empacado"
  | "enviado"
  | "en_ruta"
  | "entregado"
  | "cancelado"
  | "pending"
  | "confirmed"
  | "paid"
  | "preparing"
  | "shipped"
  | "delivered"
  | "cancelled";

export type OrderWorkflowInput = {
  status: string;
  payment_method: "bank_transfer" | "card" | "cash";
  payment_timing?: "before_delivery" | "on_delivery";
  payment_status: string | null;
  transfer_receipt_url?: string | null;
  transfer_receipt_public_id?: string | null;
  order_reservation_status?: string | null;
};

export type OrderStatusOption = {
  value: OrderWorkflowStatus;
  label: string;
};

export type ContextualOrderAction =
  | "accept_order"
  | "mark_preparing"
  | "mark_packed"
  | "mark_shipped"
  | "mark_in_route"
  | "mark_delivered"
  | "confirm_payment"
  | "reject_payment"
  | "cancel_order";

const canonicalStatusMap: Record<string, OrderWorkflowStatus> = {
  pending: "recibido",
  recibido: "recibido",
  confirmed: "confirmado",
  paid: "confirmado",
  confirmado: "confirmado",
  preparing: "preparacion",
  preparacion: "preparacion",
  empacado: "empacado",
  shipped: "enviado",
  enviado: "enviado",
  en_ruta: "en_ruta",
  delivered: "entregado",
  entregado: "entregado",
  cancelled: "cancelado",
  cancelado: "cancelado",
};

export const orderStatusLabels: Record<string, string> = {
  recibido: "Pedido recibido",
  confirmado: "Pedido aceptado",
  preparacion: "En preparacion",
  empacado: "Empacado",
  enviado: "Enviado",
  en_ruta: "En ruta",
  entregado: "Entregado",
  cancelado: "Cancelado",
  pending: "Pedido recibido",
  confirmed: "Pedido aceptado",
  paid: "Pedido aceptado",
  preparing: "En preparacion",
  shipped: "Enviado",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

const orderStatusOptions: OrderStatusOption[] = [
  { value: "recibido", label: "Pedido recibido" },
  { value: "confirmado", label: "Pedido aceptado" },
  { value: "preparacion", label: "En preparacion" },
  { value: "empacado", label: "Empacado" },
  { value: "enviado", label: "Enviado" },
  { value: "en_ruta", label: "En ruta" },
  { value: "entregado", label: "Entregado" },
  { value: "cancelado", label: "Cancelado" },
];

export function canonicalOrderStatus(status: string | null | undefined): OrderWorkflowStatus {
  return canonicalStatusMap[String(status ?? "recibido")] ?? "recibido";
}

export function isPaymentConfirmed(paymentStatus: string | null | undefined) {
  return ["approved", "confirmed", "paid"].includes(String(paymentStatus ?? ""));
}

export function hasTransferReceipt(order: Pick<OrderWorkflowInput, "transfer_receipt_url" | "transfer_receipt_public_id">) {
  return Boolean(order.transfer_receipt_public_id || order.transfer_receipt_url);
}

function canCancelOrder(order: OrderWorkflowInput) {
  if (canonicalOrderStatus(order.status) === "cancelado") {
    return true;
  }

  if (!isPaymentConfirmed(order.payment_status)) {
    return true;
  }

  return order.order_reservation_status === "reserved";
}

function nextFulfillmentStatuses(current: OrderWorkflowStatus): OrderWorkflowStatus[] {
  if (current === "confirmado") return ["preparacion"];
  if (current === "preparacion") return ["empacado"];
  if (current === "empacado") return ["enviado"];
  if (current === "enviado") return ["en_ruta"];
  if (current === "en_ruta") return ["entregado"];
  return [];
}

export function getAllowedOrderStatusOptions(order: OrderWorkflowInput): OrderStatusOption[] {
  const current = canonicalOrderStatus(order.status);
  const allowed = new Set<OrderWorkflowStatus>([current]);
  const paymentConfirmed = isPaymentConfirmed(order.payment_status);

  if (current === "cancelado") {
    return orderStatusOptions.filter((option) => allowed.has(option.value));
  }

  if (canCancelOrder(order)) {
    allowed.add("cancelado");
  }

  if (order.payment_method === "cash" || order.payment_timing === "on_delivery") {
    if (current === "recibido") {
      allowed.add("confirmado");
    } else {
      for (const status of nextFulfillmentStatuses(current)) {
        allowed.add(status);
      }
    }
  } else if (paymentConfirmed) {
    if (current === "recibido") {
      allowed.add("confirmado");
    } else {
      for (const status of nextFulfillmentStatuses(current)) {
        allowed.add(status);
      }
    }
  }

  return orderStatusOptions.filter((option) => allowed.has(option.value));
}

export function canMoveOrderToStatus(order: OrderWorkflowInput, targetStatus: string) {
  const target = canonicalOrderStatus(targetStatus);
  const allowed = getAllowedOrderStatusOptions(order).some((option) => option.value === target);

  if (allowed) {
    return { ok: true, status: target };
  }

  return {
    ok: false,
    status: target,
    message: "No puedes avanzar este pedido porque el flujo requiere aceptar el pedido, confirmar el pago o seguir el siguiente paso operativo.",
  };
}

export function canConfirmPayment(order: OrderWorkflowInput) {
  if (canonicalOrderStatus(order.status) === "cancelado") return false;
  if (isPaymentConfirmed(order.payment_status) || order.payment_status === "rejected") return false;
  if (order.payment_method === "card") return false;
  if (order.payment_method === "cash" || order.payment_timing === "on_delivery") {
    return canonicalOrderStatus(order.status) === "entregado";
  }
  return order.payment_method === "bank_transfer";
}

export function getContextualOrderActions(order: OrderWorkflowInput): ContextualOrderAction[] {
  const current = canonicalOrderStatus(order.status);
  const paymentConfirmed = isPaymentConfirmed(order.payment_status);

  if (current === "cancelado") return [];

  const actions: ContextualOrderAction[] = [];
  if (current === "recibido" && (order.payment_method === "cash" || order.payment_timing === "on_delivery" || paymentConfirmed)) {
    actions.push("accept_order");
  }

  if (current === "confirmado") actions.push("mark_preparing");
  if (current === "preparacion") actions.push("mark_packed");
  if (current === "empacado") actions.push("mark_shipped");
  if (current === "enviado") actions.push("mark_in_route");
  if (current === "en_ruta") actions.push("mark_delivered");

  if (canConfirmPayment(order)) actions.push("confirm_payment");
  if (order.payment_method === "bank_transfer" && !paymentConfirmed && order.payment_status !== "rejected") {
    actions.push("reject_payment");
  }
  if (canCancelOrder(order)) actions.push("cancel_order");

  return actions;
}

export function paymentDisplayLabel(order: OrderWorkflowInput) {
  const status = String(order.payment_status ?? "pending");

  if (status === "rejected") return "Pago rechazado";
  if (isPaymentConfirmed(status)) {
    if (order.payment_method === "cash") return "Pago recibido";
    if (order.payment_method === "card") return "Pago aprobado";
    return "Pago confirmado";
  }

  if (order.payment_method === "bank_transfer") {
    if (order.payment_timing === "on_delivery") return "Pago pendiente al recibir";
    return hasTransferReceipt(order) ? "Comprobante en revision" : "Pago en revision";
  }

  if (order.payment_method === "card") {
    return "Pendiente de pasarela";
  }

  return "Pendiente";
}

export function recommendedOrderAction(order: OrderWorkflowInput) {
  const current = canonicalOrderStatus(order.status);
  const paymentConfirmed = isPaymentConfirmed(order.payment_status);

  if (current === "cancelado") return "Pedido cancelado. No requiere avance operativo.";
  if (order.payment_status === "rejected") return "Pago rechazado. La reserva debe quedar liberada.";

  if (order.payment_method === "cash") {
    if (current === "recibido") return "Revisar y aceptar el pedido antes de prepararlo.";
    if (!paymentConfirmed && current === "entregado") return "Confirmar pago recibido para cerrar el pedido.";
    if (!paymentConfirmed) return "Continuar preparacion solo si el pedido ya fue aceptado; confirmar pago al recibir el dinero.";
    return "Pago recibido. Continuar seguimiento operativo.";
  }

  if (order.payment_method === "bank_transfer") {
    if (order.payment_timing === "on_delivery") {
      if (!paymentConfirmed && current === "entregado") return "Confirmar pago recibido para cerrar el pedido.";
      if (!paymentConfirmed) return "Continuar seguimiento operativo y confirmar la transferencia cuando el cliente reciba el pedido.";
      return "Transferencia recibida. Continuar seguimiento operativo.";
    }
    if (!paymentConfirmed && hasTransferReceipt(order)) return "Revisar referencia y comprobante antes de confirmar o rechazar pago.";
    if (!paymentConfirmed) return "Revisar la referencia bancaria en la cuenta antes de confirmar o rechazar pago.";
    return "Pago confirmado. El pedido puede prepararse o facturarse.";
  }

  if (!paymentConfirmed) return "Esperar confirmacion real de la pasarela antes de preparar.";
  return "Pago aprobado por pasarela. Preparar pedido.";
}
