"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { writeAuditLog } from "@/lib/audit";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { notifyCustomerOfOrderChange } from "@/lib/notifications/order-email";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getAdminInvoiceDetail } from "@/services/supabase/admin-invoices.service";
import { canMoveOrderToStatus, canonicalOrderStatus, isPaymentConfirmed } from "@/utils/order-workflow";

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

function safeAdminOrderMessage(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("row-level security") || normalized.includes("permission denied")) {
    return "No tienes permiso para realizar esta acción.";
  }
  return message || "No se pudo actualizar el pedido.";
}

function normalizeOptionalRtn(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const digits = trimmed.replace(/[\s-]/g, "");
  if (!/^\d{14}$/.test(digits)) {
      return { error: "El RTN debe contener 14 dígitos." };
  }

  return digits;
}

async function getAuditRequestMetadata() {
  const headerStore = await headers();
  const forwardedFor = headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ipAddress = forwardedFor || headerStore.get("x-real-ip") || headerStore.get("cf-connecting-ip");

  return {
    ipAddress: ipAddress && /^[0-9a-fA-F:.]+$/.test(ipAddress) ? ipAddress : null,
    userAgent: headerStore.get("user-agent"),
  };
}

function revalidateOperationalPaths() {
  [
    "/admin/pedidos",
    "/admin/facturas",
    "/admin/reportes",
    "/admin/crm",
    "/rastreo",
    "/mis-pedidos",
    "/cuenta",
    "/facturas",
  ].forEach((path) => revalidatePath(path));
}

export async function updateOrderPaymentStatusAction(orderId: string, status: PaymentStatus, reason = "") {
  await requirePermission(status === "approved" ? "payments:confirm" : "payments:reject");
  const rejectionReason = reason.trim();

  if (status === "rejected" && rejectionReason.length < 4) {
    return { ok: false, message: "Ingresa un motivo para rechazar el pago." };
  }

  const supabase = await getSupabaseServerClient();
  const { error } =
    status === "approved"
      ? await supabase.rpc("confirm_manual_order_payment", { target_order_id: orderId })
      : await supabase.rpc("reject_order_payment_and_release", {
          target_order_id: orderId,
          rejection_reason: rejectionReason,
        });

  if (error) {
    return { ok: false, message: safeAdminOrderMessage(error.message) };
  }

  await notifyCustomerOfOrderChange({
    orderId,
    eventType: status === "approved" ? "payment.confirmed" : "payment.rejected",
    status,
    force: status === "rejected",
  });

  revalidateOperationalPaths();

  return {
    ok: true,
    message: status === "approved" ? "Pago recibido confirmado." : "Pago rechazado. El pedido fue cancelado y la reserva quedó liberada.",
  };
}

export async function extendOrderReservationAction(orderId: string, minutes: 720 | 1440 | 2880, reason: string) {
  await requirePermission("orders:extend_reservation");
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("extend_order_reservation", {
    target_order_id: orderId,
    extension_minutes: minutes,
    extension_reason: reason.trim(),
  });

  if (error) return { ok: false, message: safeAdminOrderMessage(error.message) };
  revalidateOperationalPaths();
  return { ok: true, message: "Reserva extendida correctamente." };
}

export async function addOrderInternalNoteAction(orderId: string, note: string) {
  await requirePermission("reservations:review");
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("add_order_internal_note", {
    target_order_id: orderId,
    note_text: note.trim(),
  });

  if (error) return { ok: false, message: safeAdminOrderMessage(error.message) };
  revalidateOperationalPaths();
  return { ok: true, message: "Nota interna agregada." };
}

export async function updateOrderStatusAction(orderId: string, status: OrderStatus, reason = "") {
  const profile = await requirePermission("admin:access");
  const canManageOrders = hasEffectivePermission(profile.role, profile.permissions, "orders:manage", profile.email);
  const canManageLogistics = hasEffectivePermission(profile.role, profile.permissions, "orders:manage_logistics", profile.email);
  const canCancelOrders = hasEffectivePermission(profile.role, profile.permissions, "orders:cancel", profile.email);
  const statusReason = reason.trim();
  const normalizedStatus = canonicalOrderStatus(status);

  if (
    normalizedStatus !== "cancelado" &&
    !canManageOrders &&
    (!canManageLogistics || !["preparacion", "empacado", "enviado", "en_ruta", "entregado"].includes(status))
  ) {
    return { ok: false, message: "Solo usuarios autorizados pueden realizar esta accion." };
  }

  if (normalizedStatus === "cancelado" && !canManageOrders && !canCancelOrders) {
    return { ok: false, message: "Solo usuarios autorizados pueden cancelar pedidos." };
  }

  if (normalizedStatus === "cancelado" && statusReason.length < 8) {
    return { ok: false, message: "Ingresa un motivo de cancelacion de al menos 8 caracteres." };
  }

  if (!allowedOrderStatuses.has(status)) {
    return { ok: false, message: "Estado de pedido inválido." };
  }

  const supabase = await getSupabaseServerClient();
  if (normalizedStatus === "cancelado") {
    const { error } = await supabase.rpc("cancel_order_and_release_reservation", {
      target_order_id: orderId,
      cancellation_reason: statusReason,
    });

    if (error) return { ok: false, message: safeAdminOrderMessage(error.message) };
    await notifyCustomerOfOrderChange({
      orderId,
      eventType: "order.cancelled",
      status: "cancelado",
      force: true,
    });
    revalidateOperationalPaths();
    return { ok: true, message: "Pedido cancelado y reserva liberada." };
  }

  const { data: previousOrder, error: previousError } = await supabase
    .from("orders")
    .select(
      `
      id,
      order_number,
      status,
      tracking_status,
      payment_method,
      payment_timing,
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
      payment_timing: "before_delivery" | "on_delivery";
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

  if (canonicalOrderStatus(previousOrder.status) === "cancelado" && canonicalOrderStatus(status) !== "cancelado") {
    return { ok: false, message: "Este pedido esta cancelado. No requiere avance operativo." };
  }

  const payment = previousOrder.payments?.[0] ?? null;
  const transition = canMoveOrderToStatus(
    {
      status: previousOrder.status,
      payment_method: previousOrder.payment_method,
      payment_timing: previousOrder.payment_timing,
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

  const { error } = canManageOrders
    ? await supabase
        .from("orders")
        .update({
          status: transition.status,
          tracking_status: transition.status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", orderId)
    : await supabase.rpc("advance_order_logistics", {
        target_order_id: orderId,
        target_status: transition.status,
      });

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
      reason: transition.status === "cancelado" ? statusReason : null,
    },
    newData: {
      order_number: previousOrder.order_number,
      status: transition.status,
      tracking_status: transition.status,
      payment_method: previousOrder.payment_method,
      payment_status: payment?.payment_status ?? payment?.status ?? null,
      reason: transition.status === "cancelado" ? statusReason : null,
    },
  });

  revalidateOperationalPaths();

  await notifyCustomerOfOrderChange({
    orderId,
    eventType: "order.status_update",
    status: transition.status,
  });

  return { ok: true, message: "Estado del pedido actualizado." };
}

export async function generateInvoiceFromOrderAction(orderId: string) {
  await requirePermission("invoices:create");
  const supabase = await getSupabaseServerClient();
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, status, order_reservation_status, payments(payment_status, status), invoices(id, status)")
    .eq("id", orderId)
    .maybeSingle<{
      id: string;
      status: string;
      order_reservation_status: string | null;
      payments: Array<{ payment_status: string | null; status: string | null }> | null;
      invoices: Array<{ id: string; status: string | null }> | null;
    }>();

  if (orderError) {
    return { ok: false, message: orderError.message || "No se pudo validar el estado del pago." };
  }

  if (!order) {
    return { ok: false, message: "Pedido no encontrado." };
  }

  if (canonicalOrderStatus(order.status) === "cancelado") {
    return { ok: false, message: "No se puede emitir factura de un pedido cancelado." };
  }

  if (["released", "expired", "canceled"].includes(String(order.order_reservation_status ?? ""))) {
    return { ok: false, message: "No se puede emitir factura porque la reserva de inventario fue liberada." };
  }

  const activeInvoice = (order.invoices ?? []).find((invoice) => !["anulada", "cancelled"].includes(String(invoice.status ?? "")));
  if (activeInvoice) {
    return { ok: false, message: "Este pedido ya tiene una factura fiscal activa." };
  }

  const payment = order.payments?.[0] ?? null;
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

  revalidateOperationalPaths();
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

export async function correctOrderFiscalCustomerDataAction(input: {
  orderId: string;
  customerName: string;
  customerRtn: string;
  customerPhone: string;
  customerEmail: string;
  customerAddress: string;
  correctionReason: string;
}) {
  await requirePermission("invoices:correct");
  const customerName = input.customerName.trim();
  const customerPhone = input.customerPhone.trim();
  const customerEmail = input.customerEmail.trim().toLowerCase();
  const customerAddress = input.customerAddress.trim();
  const correctionReason = input.correctionReason.trim();
  const customerRtn = normalizeOptionalRtn(input.customerRtn);

  if (!customerName) {
    return { ok: false, message: "El nombre o razon social es obligatorio." };
  }

  if (typeof customerRtn === "object" && customerRtn?.error) {
    return { ok: false, message: customerRtn.error };
  }

  if (correctionReason.length < 10) {
    return { ok: false, message: "El motivo de corrección es obligatorio y debe tener al menos 10 caracteres." };
  }

  const supabase = await getSupabaseServerClient();
  const auditMetadata = await getAuditRequestMetadata();
  const { error } = await supabase.rpc("correct_order_fiscal_customer_data", {
    target_order_id: input.orderId,
    corrected_customer_name: customerName,
    corrected_customer_rtn: customerRtn,
    corrected_customer_phone: customerPhone || null,
    corrected_customer_email: customerEmail || null,
    corrected_customer_address: customerAddress || null,
    correction_reason: correctionReason,
    actor_ip: auditMetadata.ipAddress,
    actor_user_agent: auditMetadata.userAgent,
  });

  if (error) {
    return { ok: false, message: error.message || "No se pudieron corregir los datos fiscales del pedido." };
  }

  revalidateOperationalPaths();

  return {
    ok: true,
    message: "Datos fiscales corregidos. Si la factura ya existia, conserva el mismo numero fiscal.",
  };
}

