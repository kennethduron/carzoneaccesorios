"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { writeAuditLog } from "@/lib/audit";
import { effectiveRole, hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { processCriticalEmailQueue } from "@/lib/notifications/email-queue";
import { notifyCustomerOfOrderChange } from "@/lib/notifications/order-email";
import { revalidateProductAvailability } from "@/lib/product-availability-cache";
import {
  dispatchAccountingEvent,
  dispatchCommercialCreditCancellationAccountingEventForOrder,
} from "@/services/accounting/accounting-event-dispatcher";
import { processAccountingOutboxesForOrderV2 } from "@/services/accounting/accounting-outbox-v2";
import {
  findLatestReceivablePaymentOutboxId,
  processReceivablePaymentAccountingOutbox,
} from "@/services/accounting/receivable-payment-outbox";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getAdminInvoiceDetail } from "@/services/supabase/admin-invoices.service";
import type { AppRole, Permission } from "@/types/auth";
import type { AdjustSaleTermsInput, SaleFinancialSnapshot } from "@/types/orders";
import { isSqlDate } from "@/utils/honduras-date";
import { cashOnDeliveryApplies, isCashOnDeliveryPending } from "@/utils/cash-on-delivery";
import { canMoveOrderToStatus, canonicalOrderStatus, isPaymentConfirmed } from "@/utils/order-workflow";

type PaymentStatus = "approved" | "rejected";
type CreditPaymentReceivedMethod = "bank_transfer" | "card" | "cash";
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
  if (
    normalized.includes("accounts_receivable_payments_idempotency_idx") ||
    normalized.includes("idempotency") ||
    normalized.includes("duplicate key") ||
    normalized.includes("ya está registrado")
  ) {
    return "Este abono ya estaba siendo procesado. Actualiza el historial antes de intentarlo de nuevo.";
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
    "/admin/cuentas-por-cobrar",
    "/admin/crm",
    "/rastreo",
    "/mis-pedidos",
    "/cuenta",
    "/facturas",
  ].forEach((path) => revalidatePath(path));
}

function canManageCommercialCredit(role: AppRole, permissions: Permission[], email: string | null) {
  const authorizedRoles = new Set<AppRole>(["technical_owner", "business_owner", "admin", "contadora"]);
  return authorizedRoles.has(effectiveRole(role, email))
    && hasEffectivePermission(role, permissions, "credit:mark_paid", email);
}

function normalizeCreditPaymentMethod(value: unknown): CreditPaymentReceivedMethod | null {
  return value === "bank_transfer" || value === "card" || value === "cash" ? value : null;
}

function normalizePositiveMoney(value: unknown) {
  const amount = Math.round(Number(value) * 100) / 100;
  return Number.isFinite(amount) ? amount : Number.NaN;
}

async function processCreditPaymentEmails(receivableId: string, queueIds: Array<string | null | undefined> = []) {
  const ids = new Set(queueIds.filter((id): id is string => Boolean(id)));
  const admin = getSupabaseAdminClient();
  const { data } = await admin
    .from("email_queue")
    .select("id")
    .eq("related_id", receivableId)
    .in("status", ["pending", "retrying"])
    .in("template_key", ["commercial_credit.payment_registered", "commercial_credit.paid_complete"])
    .order("created_at", { ascending: false })
    .limit(3)
    .returns<Array<{ id: string }>>();

  (data ?? []).forEach((row) => ids.add(row.id));

  if (ids.size === 0) {
    return;
  }

  await processCriticalEmailQueue({
    queueIds: [...ids],
    limit: Math.min(Math.max(ids.size, 1), 3),
    route: "/admin/cuentas-por-cobrar",
    action: "notifications.credit_payment_immediate_send_failed",
    metadata: {
      receivable_id: receivableId,
      queue_ids: [...ids],
    },
  });
}

export async function updateOrderPaymentStatusAction(orderId: string, status: PaymentStatus, reason = "") {
  const profile = await requirePermission(status === "approved" ? "payments:confirm" : "payments:reject");
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

  const accountingResults =
    status === "approved"
      ? await processAccountingOutboxesForOrderV2(orderId)
      : [];
  const cancellationResult =
    status === "rejected"
      ? await dispatchAccountingEvent({
          sourceType: "order",
          sourceId: orderId,
          eventPurpose: "order_cancellation",
          triggeredBy: profile.id,
          route: "/admin/pedidos",
        })
      : null;
  const creditCancellationResult =
    status === "rejected"
      ? await dispatchCommercialCreditCancellationAccountingEventForOrder({ orderId, triggeredBy: profile.id, route: "/admin/pedidos" })
      : null;

  revalidateOperationalPaths();
  revalidatePath("/admin/contabilidad");
  revalidateProductAvailability();

  const accountingWarning =
    accountingResults.some((result) => !result.ok && !["pending_mapping", "pending_data"].includes(result.outboxStatus))
      || cancellationResult?.ok === false
      || creditCancellationResult?.ok === false
      ? " Advertencia: el hecho quedó en la outbox y el borrador contable requiere reintento."
      : "";
  return {
    ok: true,
    message: (status === "approved" ? "Pago recibido confirmado." : "Pago rechazado. El pedido fue cancelado y la reserva quedó liberada.") + accountingWarning,
  };
}

export async function markCreditReceivablePaidAction(input: {
  receivableId: string;
  paymentMethod: CreditPaymentReceivedMethod;
  paymentReference?: string;
}) {
  const profile = await requirePermission("credit:mark_paid");
  const receivableId = input.receivableId.trim();
  const paymentMethod = normalizeCreditPaymentMethod(input.paymentMethod);
  const paymentReference = (input.paymentReference ?? "").trim();

  if (!canManageCommercialCredit(profile.role, profile.permissions, profile.email)) {
    await writeAuditLog({
      tableName: "accounts_receivable",
      recordId: receivableId,
      action: "commercial_credit.permission_denied",
      newData: {
        attempted_action: "mark_paid",
        role: profile.role,
      },
    });
    return { ok: false, message: "Solo usuarios autorizados pueden marcar crédito como pagado." };
  }

  if (!paymentMethod) {
    return { ok: false, message: "Selecciona el método con el que pagó el cliente." };
  }

  if (paymentReference.length > 200) {
    return { ok: false, message: "La referencia no puede exceder 200 caracteres." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("mark_credit_receivable_paid", {
    target_receivable_id: receivableId,
    received_payment_method: paymentMethod,
    payment_reference: paymentReference || null,
  });

  if (error || data !== true) {
    return { ok: false, message: safeAdminOrderMessage(error?.message || "No se pudo marcar el crédito como pagado.") };
  }

  await processCreditPaymentEmails(receivableId);
  const outboxId = await findLatestReceivablePaymentOutboxId(receivableId).catch(() => null);
  const accountingResult = outboxId
    ? await processReceivablePaymentAccountingOutbox({ outboxId, actorId: profile.id })
    : null;
  const receivablePaidResult = await dispatchAccountingEvent({
    sourceType: "accounts_receivable",
    sourceId: receivableId,
    eventPurpose: "receivable_paid",
    triggeredBy: profile.id,
    route: "/admin/cuentas-por-cobrar",
  });
  revalidateOperationalPaths();
  revalidatePath("/admin/contabilidad");
  const accountingWarning = accountingResult?.ok && receivablePaidResult.ok ? "" : " El procesamiento contable quedó pendiente y puede reintentarse.";
  return { ok: true, message: "Crédito marcado como pagado correctamente." + accountingWarning };
}

export async function registerCreditReceivablePaymentAction(input: {
  receivableId: string;
  amount: number | string;
  paymentMethod: CreditPaymentReceivedMethod;
  paymentReference?: string;
  receivedAt?: string;
  note?: string;
  receiptUrl?: string;
  receiptPublicId?: string;
  idempotencyKey?: string;
}) {
  const profile = await requirePermission("credit:mark_paid");
  const receivableId = input.receivableId.trim();
  const amount = normalizePositiveMoney(input.amount);
  const paymentMethod = normalizeCreditPaymentMethod(input.paymentMethod);
  const paymentReference = (input.paymentReference ?? "").trim();
  const note = (input.note ?? "").trim();
  const receiptUrl = (input.receiptUrl ?? "").trim();
  const receiptPublicId = (input.receiptPublicId ?? "").trim();
  const idempotencyKey = (input.idempotencyKey ?? "").trim();
  const receivedAt = (input.receivedAt ?? "").trim();

  if (!canManageCommercialCredit(profile.role, profile.permissions, profile.email)) {
    await writeAuditLog({
      tableName: "accounts_receivable",
      recordId: receivableId,
      action: "commercial_credit.permission_denied",
      newData: {
        attempted_action: "register_payment",
        role: profile.role,
      },
    });
    return { ok: false, message: "Solo usuarios autorizados pueden registrar abonos de crédito comercial." };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "El abono debe ser mayor que cero." };
  }

  if (!paymentMethod) {
    return { ok: false, message: "Selecciona el método de pago del abono." };
  }

  if (paymentReference.length > 200) {
    return { ok: false, message: "La referencia no puede exceder 200 caracteres." };
  }

  if (note.length > 1000) {
    return { ok: false, message: "La nota no puede exceder 1000 caracteres." };
  }

  if (receiptUrl.length > 1000 || receiptPublicId.length > 300) {
    return { ok: false, message: "El comprobante no tiene un formato válido." };
  }

  const receivedAtDate = receivedAt ? new Date(`${receivedAt}T12:00:00-06:00`) : new Date();
  if (Number.isNaN(receivedAtDate.getTime())) {
    return { ok: false, message: "Selecciona una fecha de recepción válida." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .rpc("register_credit_receivable_payment", {
      target_receivable_id: receivableId,
      payment_amount: amount,
      received_payment_method: paymentMethod,
      payment_reference: paymentReference || null,
      payment_received_at: receivedAtDate.toISOString(),
      payment_note: note || null,
      payment_receipt_url: receiptUrl || null,
      payment_receipt_public_id: receiptPublicId || null,
      request_key: idempotencyKey || null,
    })
    .returns<Array<{
      payment_id: string;
      receivable_id: string;
      previous_balance: unknown;
      balance_due: unknown;
      total_paid: unknown;
      receivable_status: string;
      queued_email_id: string | null;
      outbox_id: string;
      outbox_created: boolean;
      idempotent_replay: boolean;
    }>>();

  if (error || !Array.isArray(data) || data.length === 0) {
    return { ok: false, message: safeAdminOrderMessage(error?.message || "No se pudo registrar el abono.") };
  }

  const result = data[0];
  await processCreditPaymentEmails(receivableId, [result.queued_email_id]);
  const accountingResult = await processReceivablePaymentAccountingOutbox({
    outboxId: result.outbox_id,
    actorId: profile.id,
  });
  const receivablePaidResult =
    Number(result.balance_due ?? 0) <= 0
      ? await dispatchAccountingEvent({
          sourceType: "accounts_receivable",
          sourceId: receivableId,
          eventPurpose: "receivable_paid",
          triggeredBy: profile.id,
          route: "/admin/cuentas-por-cobrar",
        })
      : null;
  revalidateOperationalPaths();
  revalidatePath("/admin/contabilidad");

  const accountingMessage =
    accountingResult.draftStatus === "borrador"
      ? " La partida contable fue creada en borrador y está pendiente de revisión."
      : accountingResult.reason === "mapping_missing"
        ? " El evento contable quedó pendiente porque falta configurar una cuenta contable para este método de pago."
        : accountingResult.reason === "period_closed"
          ? " El evento contable quedó pendiente porque la fecha del abono pertenece a un período cerrado."
          : " El abono fue registrado correctamente, pero el procesamiento contable quedó pendiente. Puede reintentarse sin duplicar el abono.";
  const controlWarning = receivablePaidResult?.ok === false
    ? " No se pudo actualizar el evento final de control."
    : "";
  return {
    ok: true,
    message: (Number(result.balance_due ?? 0) <= 0 ? "Abono registrado correctamente. El crédito quedó pagado completamente." : "Abono registrado correctamente.") + accountingMessage + controlWarning,
    payment: {
      ok: true as const,
      paymentId: result.payment_id,
      previousBalance: Number(result.previous_balance ?? 0),
      newBalance: Number(result.balance_due ?? 0),
      receivableStatus: result.receivable_status,
      idempotentReplay: result.idempotent_replay,
    },
    accounting: {
      eventStatus: accountingResult.eventStatus,
      eventId: accountingResult.eventId,
      draftStatus: accountingResult.draftStatus,
      draftId: accountingResult.draftId,
      reason: accountingResult.reason,
      outboxId: accountingResult.outboxId,
    },
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
    return { ok: false, message: "Solo usuarios autorizados pueden realizar esta acción." };
  }

  if (normalizedStatus === "cancelado" && !canManageOrders && !canCancelOrders) {
    return { ok: false, message: "Solo usuarios autorizados pueden cancelar pedidos." };
  }

  if (normalizedStatus === "cancelado" && statusReason.length < 8) {
    return { ok: false, message: "Ingresa un motivo de cancelación de al menos 8 caracteres." };
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
    const accountingResult = await dispatchAccountingEvent({
      sourceType: "order",
      sourceId: orderId,
      eventPurpose: "order_cancellation",
      triggeredBy: profile.id,
      route: "/admin/pedidos",
    });
    const creditCancellationResult = await dispatchCommercialCreditCancellationAccountingEventForOrder({ orderId, triggeredBy: profile.id, route: "/admin/pedidos" });
    revalidateOperationalPaths();
    revalidatePath("/admin/contabilidad");
    revalidateProductAvailability();
    const accountingWarning = accountingResult.ok && creditCancellationResult.ok ? "" : " Advertencia: no se pudo registrar el evento contable.";
    return { ok: true, message: "Pedido cancelado y reserva liberada." + accountingWarning };
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
      payment_method: "bank_transfer" | "card" | "cash" | "commercial_credit";
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
    return { ok: false, message: "Este pedido está cancelado. No requiere avance operativo." };
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

  const accountingResults = await processAccountingOutboxesForOrderV2(orderId);

  revalidateOperationalPaths();
  if (accountingResults.length > 0) revalidatePath("/admin/contabilidad");
  revalidateProductAvailability();

  await notifyCustomerOfOrderChange({
    orderId,
    eventType: "order.status_update",
    status: transition.status,
  });

  const accountingWarning = accountingResults.some(
    (result) => !result.ok && !["pending_mapping", "pending_data"].includes(result.outboxStatus),
  )
    ? " Advertencia: el hecho quedó en la outbox y el borrador contable requiere reintento."
    : "";
  return { ok: true, message: "Estado del pedido actualizado." + accountingWarning };
}

type AdjustSaleTermsRpcResult = {
  order_id: string;
  commercial_terms_version: number;
  requested_invoice_date: string;
  delivery_mode: AdjustSaleTermsInput["deliveryMode"];
  external_delivery_provider: string | null;
  financials: SaleFinancialSnapshot;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validMoney(value: number) {
  return Number.isFinite(value) && value >= 0 && Math.round(value * 100) === value * 100;
}

export async function adjustSaleTermsAction(input: AdjustSaleTermsInput) {
  const profile = await requirePermission("admin:access");
  const canAdjust = ([
    "sales:set_invoice_date",
    "sales:override_price",
    "sales:override_delivery",
  ] as Permission[]).some((permission) =>
    hasEffectivePermission(profile.role, profile.permissions, permission, profile.email),
  );

  if (!canAdjust) {
    return { ok: false as const, message: "No tienes permiso para ajustar los términos comerciales." };
  }
  if (!uuidPattern.test(input.orderId) || !uuidPattern.test(input.idempotencyKey)) {
    return { ok: false as const, message: "El pedido o la clave de guardado no es válida." };
  }
  if (!isSqlDate(input.requestedInvoiceDate)) {
    return { ok: false as const, message: "Selecciona una fecha de factura válida." };
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    return { ok: false as const, message: "La versión de los términos no es válida. Recarga el pedido." };
  }
  if (!validMoney(input.requestedShippingFee)) {
    return { ok: false as const, message: "Ingresa un cargo de entrega no negativo con máximo dos decimales." };
  }
  if (!Array.isArray(input.linePriceOverrides) || input.linePriceOverrides.length === 0) {
    return { ok: false as const, message: "El pedido debe incluir al menos una línea." };
  }

  const itemIds = new Set<string>();
  for (const line of input.linePriceOverrides) {
    if (!uuidPattern.test(line.orderItemId) || !validMoney(line.finalUnitPrice) || line.finalUnitPrice <= 0) {
      return { ok: false as const, message: "Revisa los precios finales del pedido." };
    }
    if (itemIds.has(line.orderItemId)) {
      return { ok: false as const, message: "Cada línea del pedido debe enviarse una sola vez." };
    }
    itemIds.add(line.orderItemId);
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("adjust_sale_terms_v1", {
    p_order_id: input.orderId,
    p_requested_invoice_date: input.requestedInvoiceDate,
    p_line_price_overrides: input.linePriceOverrides.map((line) => ({
      order_item_id: line.orderItemId,
      final_unit_price: line.finalUnitPrice,
    })),
    p_requested_shipping_fee: input.requestedShippingFee,
    p_delivery_mode: input.deliveryMode ?? null,
    p_external_delivery_provider: input.externalDeliveryProvider?.trim() || null,
    p_price_reason: input.priceReason?.trim() || null,
    p_delivery_reason: input.deliveryReason?.trim() || null,
    p_expected_version: input.expectedVersion,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) {
    return { ok: false as const, message: error.message || "No se pudieron guardar los términos comerciales." };
  }

  const snapshot = data as AdjustSaleTermsRpcResult | null;
  if (!snapshot?.financials || !Number.isInteger(snapshot.commercial_terms_version)) {
    return { ok: false as const, message: "El servidor no devolvió el snapshot monetario confirmado." };
  }

  revalidateOperationalPaths();
  revalidatePath("/admin/reportes");
  return {
    ok: true as const,
    message: "Términos guardados y recalculados correctamente.",
    snapshot,
  };
}

export async function generateInvoiceFromOrderAction(orderId: string) {
  const profile = await requirePermission("invoices:create");
  const supabase = await getSupabaseServerClient();
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, status, payment_method, payment_timing, cash_on_delivery_fee, order_reservation_status, payments(payment_status, status), invoices(id, invoice_number, status)")
    .eq("id", orderId)
    .maybeSingle<{
      id: string;
      status: string;
      payment_method: "bank_transfer" | "card" | "cash" | "commercial_credit";
      payment_timing: "before_delivery" | "on_delivery";
      cash_on_delivery_fee: unknown;
      order_reservation_status: string | null;
      payments: Array<{ payment_status: string | null; status: string | null }> | null;
      invoices: Array<{ id: string; invoice_number: string | null; status: string | null }> | null;
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

  if (isCashOnDeliveryPending(order.payment_method, order.payment_timing, order.cash_on_delivery_fee)) {
    return { ok: false, message: "Debes confirmar el cargo contra entrega antes de emitir la factura." };
  }

  const activeInvoice = (order.invoices ?? []).find((invoice) => !["anulada", "cancelled"].includes(String(invoice.status ?? "")));
  if (activeInvoice) {
    const invoiceDetail = await getAdminInvoiceDetail(activeInvoice.id);
    if (!invoiceDetail) {
      return { ok: false, message: "Este pedido ya tiene factura, pero no se pudo cargar el detalle fiscal." };
    }

    return {
      ok: true,
      message: "Este pedido ya tiene una factura emitida. Se abrirá la factura existente.",
      invoiceId: activeInvoice.id,
      invoiceNumber: activeInvoice.invoice_number ?? "",
      invoice: invoiceDetail,
      bankReference: null,
    };
  }

  const payment = order.payments?.[0] ?? null;
  if (order.payment_method !== "commercial_credit" && !isPaymentConfirmed(payment?.payment_status ?? payment?.status ?? null)) {
    return { ok: false, message: "La factura solo puede generarse cuando el pago esté confirmado." };
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

  const invoiceDetail = await getAdminInvoiceDetail(invoice.invoice_id);
  if (!invoiceDetail) {
    return { ok: false, message: "La factura fue generada, pero no se pudo cargar la vista previa." };
  }

  const accountingResult = await dispatchAccountingEvent({
    sourceType: "invoice",
    sourceId: invoice.invoice_id,
    eventPurpose: "invoice_issued",
    triggeredBy: profile.id,
    route: "/admin/pedidos",
  });

  revalidateOperationalPaths();
  revalidatePath("/admin/configuracion-fiscal");
  revalidatePath("/admin/contabilidad");

  return {
    ok: true,
    message: `Factura ${invoice.invoice_number} generada correctamente.${accountingResult.ok ? "" : " Advertencia: no se pudo registrar el evento contable."}`,
    invoiceId: invoice.invoice_id,
    invoiceNumber: invoice.invoice_number,
    invoice: invoiceDetail,
    bankReference: null,
  };
}

export async function updateCashOnDeliveryFeeAction(orderId: string, rawFee: number | string) {
  const profile = await requirePermission("admin:access");
  const canUpdate =
    hasEffectivePermission(profile.role, profile.permissions, "orders:manage", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "payments:manage", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "crm:manage", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "commercial_settings:manage", profile.email);

  if (!canUpdate) {
    return { ok: false, message: "Solo usuarios autorizados pueden modificar el cargo contra entrega." };
  }

  const fee = Math.round(Number(rawFee) * 100) / 100;
  if (!Number.isFinite(fee) || fee < 0) {
    return { ok: false, message: "Ingresa un cargo contra entrega válido." };
  }

  const supabase = await getSupabaseServerClient();
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select(
      `
      id,
      order_number,
      status,
      payment_method,
      payment_timing,
      subtotal,
      tax,
      shipping_fee,
      shipping_total,
      cash_on_delivery_fee,
      small_order_fee,
      discount_total,
      additional_fees,
      invoices(id, invoice_number, status)
    `,
    )
    .eq("id", orderId)
    .maybeSingle<{
      id: string;
      order_number: string;
      status: string;
      payment_method: "bank_transfer" | "card" | "cash" | "commercial_credit";
      payment_timing: "before_delivery" | "on_delivery";
      subtotal: unknown;
      tax: unknown;
      shipping_fee: unknown;
      shipping_total: unknown;
      cash_on_delivery_fee: unknown;
      small_order_fee: unknown;
      discount_total: unknown;
      additional_fees: unknown;
      invoices: Array<{ id: string; invoice_number: string | null; status: string | null }> | null;
    }>();

  if (orderError) {
    return { ok: false, message: safeAdminOrderMessage(orderError.message) };
  }

  if (!order) {
    return { ok: false, message: "Pedido no encontrado." };
  }

  if (!cashOnDeliveryApplies(order.payment_method, order.payment_timing)) {
    return { ok: false, message: "Este pedido no usa pago contra entrega." };
  }

  if (canonicalOrderStatus(order.status) === "cancelado") {
    return { ok: false, message: "No se puede modificar el cargo contra entrega de un pedido cancelado." };
  }

  const invoices = Array.isArray(order.invoices) ? order.invoices : order.invoices ? [order.invoices] : [];
  const issuedInvoice = invoices.find((invoice) => invoice.invoice_number && !["anulada", "cancelled"].includes(String(invoice.status ?? "")));
  if (issuedInvoice) {
    return { ok: false, message: "El cargo contra entrega no puede modificarse porque la factura fiscal ya fue emitida." };
  }

  const { data: financials, error: updateError } = await supabase.rpc("update_checkout_cash_on_delivery_fee_v1", {
    target_order_id: orderId,
    requested_fee: fee,
  });

  if (updateError || !financials || typeof financials !== "object") {
    return {
      ok: false,
      message: safeAdminOrderMessage(updateError?.message || "No se pudo actualizar el cargo contra entrega."),
    };
  }

  revalidateOperationalPaths();

  return {
    ok: true,
    message: fee > 0 ? "Cargo contra entrega actualizado correctamente." : "Cargo contra entrega guardado en L 0.00. El pedido seguirá pendiente de confirmación antes de facturar.",
  };
}

export async function correctOrderFiscalCustomerDataAction(input: {
  orderId: string;
  customerName: string;
  customerRtn: string;
}) {
  const profile = await requirePermission("admin:access");
  const canCorrectFiscalData =
    ["technical_owner", "business_owner", "admin"].includes(profile.role) &&
    hasEffectivePermission(profile.role, profile.permissions, "invoices:correct", profile.email);

  if (!canCorrectFiscalData) {
    return { ok: false, message: "No tienes permiso para corregir datos fiscales del pedido." };
  }

  const customerName = input.customerName.trim();
  const customerRtn = normalizeOptionalRtn(input.customerRtn);

  if (customerName.length < 2) {
    return { ok: false, message: "El nombre o razón social es obligatorio." };
  }

  if (typeof customerRtn === "object" && customerRtn?.error) {
    return { ok: false, message: customerRtn.error };
  }

  const supabase = await getSupabaseServerClient();
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select(
      `
      id,
      order_number,
      fiscal_customer_name,
      fiscal_customer_rtn,
      fiscal_customer_phone,
      fiscal_customer_email,
      fiscal_customer_address,
      invoices(id, invoice_number, status)
    `,
    )
    .eq("id", input.orderId)
    .maybeSingle<{
      id: string;
      order_number: string;
      fiscal_customer_name: string | null;
      fiscal_customer_rtn: string | null;
      fiscal_customer_phone: string | null;
      fiscal_customer_email: string | null;
      fiscal_customer_address: string | null;
      invoices: Array<{ id: string; invoice_number: string | null; status: string | null }> | null;
    }>();

  if (orderError) {
    return { ok: false, message: safeAdminOrderMessage(orderError.message) };
  }

  if (!order) {
    return { ok: false, message: "Pedido no encontrado." };
  }

  const invoices = Array.isArray(order.invoices) ? order.invoices : order.invoices ? [order.invoices] : [];
  const issuedInvoice = invoices.find((invoice) => invoice.invoice_number);
  if (issuedInvoice) {
    return {
      ok: false,
      message: "Este pedido ya tiene factura emitida. Para cambios fiscales, utiliza el proceso fiscal correspondiente.",
    };
  }

  const normalizedCustomerRtn = typeof customerRtn === "string" ? customerRtn : null;
  const changedFields = [
    order.fiscal_customer_name !== customerName ? "customer_name" : null,
    (order.fiscal_customer_rtn ?? null) !== normalizedCustomerRtn ? "customer_rtn" : null,
  ].filter((field): field is "customer_name" | "customer_rtn" => Boolean(field));

  if (changedFields.length === 0) {
    return { ok: true, message: "No hubo cambios fiscales que guardar." };
  }

  const auditMetadata = await getAuditRequestMetadata();
  const automaticCorrectionReason = "Corrección operativa automática desde Admin > Pedidos.";
  const { error } = await supabase.rpc("correct_order_fiscal_customer_data", {
    target_order_id: input.orderId,
    corrected_customer_name: customerName,
    corrected_customer_rtn: normalizedCustomerRtn,
    corrected_customer_phone: order.fiscal_customer_phone,
    corrected_customer_email: order.fiscal_customer_email,
    corrected_customer_address: order.fiscal_customer_address,
    correction_reason: automaticCorrectionReason,
    actor_ip: auditMetadata.ipAddress,
    actor_user_agent: auditMetadata.userAgent,
  });

  if (error) {
    return { ok: false, message: error.message || "No se pudieron corregir los datos fiscales del pedido." };
  }

  await writeAuditLog({
    tableName: "orders",
    recordId: input.orderId,
    action: "fiscal_data_corrected",
    oldData: {
      order_id: order.id,
      order_number: order.order_number,
      fields_modified: changedFields,
      customer_name: order.fiscal_customer_name,
      customer_rtn: order.fiscal_customer_rtn,
    },
    newData: {
      order_id: order.id,
      order_number: order.order_number,
      fields_modified: changedFields,
      customer_name: customerName,
      customer_rtn: normalizedCustomerRtn,
      audit_mode: "automatic",
    },
    ipAddress: auditMetadata.ipAddress,
    userAgent: auditMetadata.userAgent,
  });

  revalidateOperationalPaths();

  return {
    ok: true,
    message: "Datos fiscales corregidos. La auditoría quedó registrada automáticamente.",
  };
}
