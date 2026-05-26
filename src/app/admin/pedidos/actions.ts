"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getAdminInvoiceDetail } from "@/services/supabase/admin-invoices.service";
import { canMoveOrderToStatus, canonicalOrderStatus, hasTransferReceipt, isPaymentConfirmed } from "@/utils/order-workflow";

type PaymentStatus = "approved" | "rejected";
type OrderStatus =
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

const allowedOrderStatuses = new Set<OrderStatus>([
  "recibido",
  "confirmado",
  "preparacion",
  "empacado",
  "enviado",
  "en_ruta",
  "entregado",
  "cancelado",
  "pending",
  "confirmed",
  "paid",
  "preparing",
  "shipped",
  "delivered",
  "cancelled",
]);

type OrderPaymentContext = {
  id: string;
  order_number: string;
  status: string;
  tracking_status: string | null;
  payment_method: "bank_transfer" | "card" | "cash";
  order_reservation_status: string | null;
  payments: Array<{
    id: string;
    payment_status: string | null;
    status: string | null;
    paid_at: string | null;
    amount: number;
    bank_reference_number: string | null;
    reference: string | null;
    transfer_receipt_url: string | null;
    transfer_receipt_public_id: string | null;
  }> | null;
};

function safeAdminOrderMessage(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("row-level security") || normalized.includes("permission denied")) {
    return "No tienes permiso para realizar esta acción.";
  }
  return message || "No se pudo actualizar el pedido.";
}

export async function updateOrderPaymentStatusAction(orderId: string, status: PaymentStatus) {
  await requirePermission("payments:manage");
  const supabase = await getSupabaseServerClient();
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select(
      `
      id,
      order_number,
      status,
      tracking_status,
      payment_method,
      order_reservation_status,
      payments(
        id,
        payment_status,
        status,
        paid_at,
        amount,
        bank_reference_number,
        reference,
        transfer_receipt_url,
        transfer_receipt_public_id
      )
    `,
    )
    .eq("id", orderId)
    .single<OrderPaymentContext>();

  if (orderError) {
    return { ok: false, message: orderError.message };
  }

  const payment = order.payments?.[0] ?? null;
  if (!payment) {
    return { ok: false, message: "No hay pago registrado para este pedido." };
  }

  if (canonicalOrderStatus(order.status) === "cancelado") {
    return { ok: false, message: "No se puede modificar el pago de un pedido cancelado." };
  }

  const paymentContext = {
    status: order.status,
    payment_method: order.payment_method,
    payment_status: payment.payment_status ?? payment.status,
    transfer_receipt_url: payment.transfer_receipt_url,
    transfer_receipt_public_id: payment.transfer_receipt_public_id,
    order_reservation_status: order.order_reservation_status,
  };

  if (status === "approved" && order.payment_method === "bank_transfer" && !hasTransferReceipt(paymentContext)) {
    return { ok: false, message: "No se puede confirmar pago por transferencia sin comprobante." };
  }

  if (status === "approved" && order.payment_method === "card") {
    return { ok: false, message: "Los pagos con tarjeta solo deben confirmarse mediante pasarela o webhook autorizado." };
  }

  const paidAt = status === "approved" ? new Date().toISOString() : null;
  const { error: updatePaymentError } = await supabase
    .from("payments")
    .update({
      payment_status: status,
      status,
      paid_at: paidAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", payment.id);

  if (updatePaymentError) {
    return { ok: false, message: updatePaymentError.message };
  }

  const currentOrderStatus = canonicalOrderStatus(order.status);
  const nextOrderStatus =
    status === "rejected"
      ? "cancelado"
      : currentOrderStatus === "recibido"
        ? "confirmado"
        : currentOrderStatus;
  const { error: updateOrderError } = await supabase
    .from("orders")
    .update({
      status: nextOrderStatus,
      tracking_status: nextOrderStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId);

  if (updateOrderError) {
    return { ok: false, message: updateOrderError.message };
  }

  await writeAuditLog({
    tableName: "payments",
    recordId: payment.id,
    action: status === "approved" ? "fiscal.payment.approved" : "fiscal.payment.rejected",
    oldData: {
      order_id: order.id,
      order_number: order.order_number,
      order_status: order.status,
      payment_method: order.payment_method,
      payment_id: payment.id,
      payment_status: payment.payment_status ?? payment.status,
      paid_at: payment.paid_at,
      amount: payment.amount,
      bank_reference: payment.bank_reference_number ?? payment.reference,
      has_transfer_receipt: hasTransferReceipt(paymentContext),
    },
    newData: {
      order_id: order.id,
      order_number: order.order_number,
      order_status: nextOrderStatus,
      payment_method: order.payment_method,
      payment_id: payment.id,
      payment_status: status,
      paid_at: paidAt,
      changes: {
        payment_status: { from: payment.payment_status ?? payment.status, to: status },
        order_status: { from: order.status, to: nextOrderStatus },
        paid_at: { from: payment.paid_at, to: paidAt },
      },
    },
  });

  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/reportes");
  revalidatePath("/rastreo");

  return {
    ok: true,
    message:
      status === "approved"
        ? order.payment_method === "cash"
          ? "Pago recibido confirmado."
          : "Pago confirmado. El pedido puede avanzar."
        : "Pago rechazado. El pedido fue cancelado y la reserva debe quedar liberada.",
  };
}

export async function updateOrderStatusAction(orderId: string, status: OrderStatus) {
  await requirePermission("orders:manage");

  if (!allowedOrderStatuses.has(status)) {
    return { ok: false, message: "Estado de pedido inválido." };
  }

  const supabase = await getSupabaseServerClient();
  const { data: previousOrder, error: previousError } = await supabase
    .from("orders")
    .select(
      `
      id,
      order_number,
      status,
      tracking_status,
      payment_method,
      order_reservation_status,
      payments(payment_status, status, transfer_receipt_url, transfer_receipt_public_id)
    `,
    )
    .eq("id", orderId)
    .single<{
      id: string;
      order_number: string;
      status: string;
      tracking_status: string | null;
      payment_method: "bank_transfer" | "card" | "cash";
      order_reservation_status: string | null;
      payments: Array<{
        payment_status: string | null;
        status: string | null;
        transfer_receipt_url: string | null;
        transfer_receipt_public_id: string | null;
      }> | null;
    }>();

  if (previousError) {
    return { ok: false, message: safeAdminOrderMessage(previousError.message) };
  }

  const payment = previousOrder.payments?.[0] ?? null;
  const transition = canMoveOrderToStatus(
    {
      status: previousOrder.status,
      payment_method: previousOrder.payment_method,
      payment_status: payment?.payment_status ?? payment?.status ?? null,
      transfer_receipt_url: payment?.transfer_receipt_url ?? null,
      transfer_receipt_public_id: payment?.transfer_receipt_public_id ?? null,
      order_reservation_status: previousOrder.order_reservation_status,
    },
    status,
  );

  if (!transition.ok) {
    return { ok: false, message: transition.message };
  }

  const { error } = await supabase
    .from("orders")
    .update({
      status: transition.status,
      tracking_status: transition.status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId);

  if (error) {
    return { ok: false, message: safeAdminOrderMessage(error.message) };
  }

  await writeAuditLog({
    tableName: "orders",
    recordId: orderId,
    action: "order.status_updated",
    oldData: {
      order_number: previousOrder.order_number,
      status: previousOrder.status,
      tracking_status: previousOrder.tracking_status,
      payment_method: previousOrder.payment_method,
      payment_status: payment?.payment_status ?? payment?.status ?? null,
      order_reservation_status: previousOrder.order_reservation_status,
    },
    newData: {
      order_number: previousOrder.order_number,
      status: transition.status,
      tracking_status: transition.status,
      payment_method: previousOrder.payment_method,
      payment_status: payment?.payment_status ?? payment?.status ?? null,
    },
  });

  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/reportes");
  revalidatePath("/rastreo");

  return { ok: true, message: "Estado del pedido actualizado." };
}

export async function generateInvoiceFromOrderAction(orderId: string) {
  await requirePermission("invoices:create");
  const supabase = await getSupabaseServerClient();
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, payments(payment_status, status)")
    .eq("id", orderId)
    .maybeSingle<{ id: string; payments: Array<{ payment_status: string | null; status: string | null }> | null }>();

  if (orderError) {
    return { ok: false, message: orderError.message || "No se pudo validar el estado del pago." };
  }

  const payment = order?.payments?.[0] ?? null;
  if (!isPaymentConfirmed(payment?.payment_status ?? payment?.status ?? null)) {
    return { ok: false, message: "No se puede emitir factura porque el pago aún no ha sido confirmado." };
  }

  const { data, error } = await supabase
    .rpc("generate_fiscal_invoice_from_order", {
      target_order_id: orderId,
    })
    .returns<Array<{ invoice_id: string; invoice_number: string }>>();

  if (error) {
    return { ok: false, message: error.message || "Error fiscal: no se pudo crear la factura." };
  }

  const rows = (Array.isArray(data) ? data : []) as Array<{ invoice_id: string; invoice_number: string }>;
  const invoice = rows[0];

  if (!invoice) {
    return { ok: false, message: "Error fiscal: no se pudo crear la factura." };
  }

  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/facturas");
  revalidatePath("/admin/reportes");
  revalidatePath("/admin/configuracion-fiscal");

  return {
    ok: true,
    message: `Factura ${invoice.invoice_number} generada correctamente.`,
    invoiceId: invoice.invoice_id,
    invoiceNumber: invoice.invoice_number,
    invoice: await getAdminInvoiceDetail(invoice.invoice_id),
    bankReference: null,
  };
}

