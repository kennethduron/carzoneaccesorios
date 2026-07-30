"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { dispatchAccountingEvent } from "@/services/accounting/accounting-event-dispatcher";
import { processAccountingOutboxV2 } from "@/services/accounting/accounting-outbox-v2";
import { repairLateRecordedSupplierPayment } from "@/services/accounting/supplier-payment-accounting-repairs";
import {
  applyHistoricalPayableImportBatch,
  assignHistoricalPayableImportRow,
  cancelHistoricalPayableImportRow,
  createHistoricalAccountsPayableImportBatch,
  rollbackHistoricalPayableImportBatch,
} from "@/services/supabase/accounts-payable-import.service";
import { setImportBatchStatus } from "@/services/supabase/import-foundation.service";
import {
  getSupplierOpenPayables,
  registerSupplierMultiPayment,
} from "@/services/supabase/supplier-multi-payment.service";
import {
  uploadSupplierPaymentReceipt,
} from "@/services/supplier-payment-receipt.service";
import {
  supplierMultiPaymentSchema,
  supplierMultiPaymentVoidSchema,
  supplierOpenPayablesQuerySchema,
  type SupplierMultiPaymentRpcResult,
} from "@/schemas/supplier-multi-payment";
import type { HistoricalPayableImportActionState } from "@/types/accounts-payable-import";
import type { AccountsPayableStatus, SupplierInvoiceStatus } from "@/types/purchases";
import type { SupplierPaymentRepairResult } from "@/types/supplier-payment-accounting-repair";

type ActionResult = { ok: true; message: string } | { ok: false; message: string };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SupplierInvoiceFormInput = {
  id?: string;
  supplier_id: string;
  purchase_id?: string | null;
  invoice_number: string;
  invoice_date: string;
  due_date?: string | null;
  subtotal: number | string;
  tax_amount?: number | string | null;
  discount_amount?: number | string | null;
  currency?: string | null;
  notes?: string | null;
};

export type AccountsPayableFormInput = {
  id?: string;
  supplier_id: string;
  purchase_id?: string | null;
  supplier_invoice_id?: string | null;
  total_amount: number | string;
  due_date?: string | null;
  currency?: string | null;
  notes?: string | null;
};


export type SupplierCreditFormInput = {
  supplier_id: string;
  purchase_id?: string | null;
  supplier_invoice_id?: string | null;
  accounts_payable_id?: string | null;
  credit_number: string;
  credit_date: string;
  amount: number | string;
  reason?: string | null;
};
export type SupplierPaymentFormInput = {
  accounts_payable_id: string;
  amount: number | string;
  payment_method: "cash" | "bank_transfer" | "card_credit" | "card_debit" | "";
  paid_at?: string | null;
  notes?: string | null;
  idempotency_key: string;
};

function cleanText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function toMoney(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : NaN;
}

function invoiceErrorMessage(message: string) {
  if (message.includes("supplier_invoices_supplier_invoice_active_unique") || message.includes("supplier_invoices_supplier_invoice_number_key")) {
    return "Ya existe una factura activa con ese número para este proveedor.";
  }

  return "No se pudo guardar la factura de proveedor.";
}

async function findActivePayableConflict(input: { supplierInvoiceId: string | null; purchaseId: string | null; excludeId?: string | null }) {
  const admin = getSupabaseAdminClient();
  const activeStatuses: AccountsPayableStatus[] = ["pending", "partial", "paid", "overdue"];

  if (input.supplierInvoiceId) {
    let query = admin
      .from("accounts_payable")
      .select("id", { count: "exact", head: true })
      .eq("supplier_invoice_id", input.supplierInvoiceId)
      .in("status", activeStatuses);

    if (input.excludeId) {
      query = query.neq("id", input.excludeId);
    }

    const { count, error } = await query;
    if (error) throw new Error("No se pudo validar si la factura ya tiene cuenta por pagar activa.");
    if ((count ?? 0) > 0) return "Ya existe una cuenta por pagar activa para esta factura.";
  }

  if (input.purchaseId) {
    let query = admin
      .from("accounts_payable")
      .select("id", { count: "exact", head: true })
      .eq("purchase_id", input.purchaseId)
      .in("status", activeStatuses);

    if (input.excludeId) {
      query = query.neq("id", input.excludeId);
    }

    const { count, error } = await query;
    if (error) throw new Error("No se pudo validar si la compra ya tiene cuenta por pagar activa.");
    if ((count ?? 0) > 0) return "Ya existe una cuenta por pagar activa para esta compra.";
  }

  return null;
}
async function ensureActiveSupplier(supplierId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("suppliers")
    .select("id, name, is_active")
    .eq("id", supplierId)
    .maybeSingle<{ id: string; name: string; is_active: boolean }>();

  if (error || !data) {
    throw new Error("El proveedor seleccionado no existe.");
  }

  if (!data.is_active) {
    throw new Error("El proveedor seleccionado esta inactivo.");
  }

  return data;
}

export async function saveSupplierInvoiceAction(input: SupplierInvoiceFormInput): Promise<ActionResult> {
  const profile = await requirePermission("payables:manage");
  const supplierId = cleanText(input.supplier_id);
  const invoiceNumber = cleanText(input.invoice_number);
  const invoiceDate = cleanText(input.invoice_date);
  const purchaseId = cleanText(input.purchase_id);
  const dueDate = cleanText(input.due_date);
  const subtotal = toMoney(input.subtotal);
  const taxAmount = toMoney(input.tax_amount ?? 0);
  const discountAmount = toMoney(input.discount_amount ?? 0);
  const currency = cleanText(input.currency) ?? "HNL";

  if (!supplierId) return { ok: false, message: "Selecciona un proveedor." };
  if (!invoiceNumber) return { ok: false, message: "El número de factura es obligatorio." };
  if (!invoiceDate) return { ok: false, message: "La fecha de factura es obligatoria." };
  if (!Number.isFinite(subtotal) || subtotal < 0 || !Number.isFinite(taxAmount) || taxAmount < 0 || !Number.isFinite(discountAmount) || discountAmount < 0) {
    return { ok: false, message: "Los montos de la factura no pueden ser negativos." };
  }

  const total = Math.max(Math.round((subtotal + taxAmount - discountAmount) * 100) / 100, 0);

  try {
    await ensureActiveSupplier(supplierId);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Proveedor inválido." };
  }

  const admin = getSupabaseAdminClient();

  const payload = {
    supplier_id: supplierId,
    purchase_id: purchaseId,
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    due_date: dueDate,
    subtotal,
    tax_amount: taxAmount,
    discount_amount: discountAmount,
    total,
    currency,
    notes: cleanText(input.notes),
    updated_at: new Date().toISOString(),
  };

  if (input.id) {
    const { data: existing, error: existingError } = await admin
      .from("supplier_invoices")
      .select("id, status")
      .eq("id", input.id)
      .maybeSingle<{ id: string; status: SupplierInvoiceStatus }>();

    if (existingError || !existing) return { ok: false, message: "La factura de proveedor no existe." };
    if (!["draft", "received"].includes(existing.status)) return { ok: false, message: "Esta factura ya no se puede editar." };

    const { data, error } = await admin
      .from("supplier_invoices")
      .update(payload)
      .eq("id", input.id)
      .select("id, invoice_number, status, total")
      .single();

    if (error) return { ok: false, message: invoiceErrorMessage(error.message) };

    await writeAuditLog({ tableName: "supplier_invoices", recordId: data.id, action: "supplier_invoices.update", newData: { invoice_number: data.invoice_number, status: data.status, total: data.total } });
    revalidatePath("/admin/cuentas-por-pagar");
    return { ok: true, message: "Factura de proveedor actualizada." };
  }

  const { data, error } = await admin
    .from("supplier_invoices")
    .insert({ ...payload, status: "draft", created_by: profile.id })
    .select("id, invoice_number, status, total")
    .single();

  if (error) return { ok: false, message: invoiceErrorMessage(error.message) };

  await writeAuditLog({ tableName: "supplier_invoices", recordId: data.id, action: "supplier_invoices.create", newData: { invoice_number: data.invoice_number, status: data.status, total: data.total } });
  revalidatePath("/admin/cuentas-por-pagar");
  return { ok: true, message: "Factura de proveedor registrada." };
}

export async function receiveSupplierInvoiceAction(invoiceId: string): Promise<ActionResult> {
  const profile = await requirePermission("payables:manage");
  const admin = getSupabaseAdminClient();
  const { data: invoice, error: invoiceError } = await admin
    .from("supplier_invoices")
    .select("id, invoice_number, status")
    .eq("id", invoiceId)
    .maybeSingle<{ id: string; invoice_number: string; status: SupplierInvoiceStatus }>();

  if (invoiceError || !invoice) return { ok: false, message: "La factura de proveedor no existe." };
  if (invoice.status !== "draft") return { ok: false, message: "Solo se pueden recibir facturas en borrador." };

  const { error } = await admin
    .from("supplier_invoices")
    .update({ status: "received", received_by: profile.id, received_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", invoiceId);

  if (error) return { ok: false, message: "No se pudo recibir la factura." };

  await writeAuditLog({ tableName: "supplier_invoices", recordId: invoiceId, action: "supplier_invoices.receive", newData: { invoice_number: invoice.invoice_number, status: "received" } });
  await dispatchAccountingEvent({ sourceType: "supplier_invoice", sourceId: invoiceId, eventPurpose: "supplier_invoice_received", triggeredBy: profile.id, route: "/admin/cuentas-por-pagar" });
  revalidatePath("/admin/cuentas-por-pagar");
  return { ok: true, message: "Factura recibida." };
}

export async function cancelSupplierInvoiceAction(invoiceId: string): Promise<ActionResult> {
  const profile = await requirePermission("payables:manage");
  const admin = getSupabaseAdminClient();
  const { data: invoice, error: invoiceError } = await admin
    .from("supplier_invoices")
    .select("id, invoice_number, status")
    .eq("id", invoiceId)
    .maybeSingle<{ id: string; invoice_number: string; status: SupplierInvoiceStatus }>();

  if (invoiceError || !invoice) return { ok: false, message: "La factura de proveedor no existe." };
  if (["cancelled", "paid"].includes(invoice.status)) return { ok: false, message: "Esta factura ya no se puede cancelar." };

  const { count, error: payableError } = await admin
    .from("accounts_payable")
    .select("id", { count: "exact", head: true })
    .eq("supplier_invoice_id", invoiceId)
    .neq("status", "cancelled");

  if (payableError) return { ok: false, message: "No se pudo validar la cuenta por pagar vinculada." };
  if ((count ?? 0) > 0) return { ok: false, message: "No se puede cancelar una factura con cuenta por pagar activa." };

  const { error } = await admin
    .from("supplier_invoices")
    .update({ status: "cancelled", cancelled_by: profile.id, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", invoiceId);

  if (error) return { ok: false, message: "No se pudo cancelar la factura." };

  await writeAuditLog({ tableName: "supplier_invoices", recordId: invoiceId, action: "supplier_invoices.cancel", newData: { invoice_number: invoice.invoice_number, status: "cancelled" } });
  revalidatePath("/admin/cuentas-por-pagar");
  return { ok: true, message: "Factura cancelada." };
}

export async function saveAccountsPayableAction(input: AccountsPayableFormInput): Promise<ActionResult> {
  const profile = await requirePermission("payables:manage");
  const supplierId = cleanText(input.supplier_id);
  const purchaseId = cleanText(input.purchase_id);
  const invoiceId = cleanText(input.supplier_invoice_id);
  const totalAmount = toMoney(input.total_amount);
  const dueDate = cleanText(input.due_date);
  const currency = cleanText(input.currency) ?? "HNL";

  if (!supplierId) return { ok: false, message: "Selecciona un proveedor." };
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) return { ok: false, message: "El total por pagar debe ser mayor que cero." };

  try {
    await ensureActiveSupplier(supplierId);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Proveedor inválido." };
  }

  const admin = getSupabaseAdminClient();
  let conflictMessage: string | null = null;
  try {
    conflictMessage = await findActivePayableConflict({ supplierInvoiceId: invoiceId, purchaseId, excludeId: input.id ?? null });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo validar duplicidad de la cuenta por pagar." };
  }

  if (conflictMessage) {
    return { ok: false, message: conflictMessage };
  }

  const payload = {
    supplier_id: supplierId,
    purchase_id: purchaseId,
    supplier_invoice_id: invoiceId,
    total_amount: totalAmount,
    due_date: dueDate,
    currency,
    notes: cleanText(input.notes),
    updated_at: new Date().toISOString(),
  };

  if (input.id) {
    const { data: existing, error: existingError } = await admin
      .from("accounts_payable")
      .select("id, status, paid_amount")
      .eq("id", input.id)
      .maybeSingle<{ id: string; status: AccountsPayableStatus; paid_amount: unknown }>();

    if (existingError || !existing) return { ok: false, message: "La cuenta por pagar no existe." };
    if (["paid", "cancelled"].includes(existing.status)) return { ok: false, message: "Esta cuenta por pagar ya no se puede editar." };
    if (totalAmount < Number(existing.paid_amount ?? 0)) return { ok: false, message: "El total no puede ser menor que el monto pagado." };

    const nextStatus = Number(existing.paid_amount ?? 0) > 0 ? "partial" : "pending";
    const { data, error } = await admin
      .from("accounts_payable")
      .update({ ...payload, status: nextStatus })
      .eq("id", input.id)
      .select("id, total_amount, status")
      .single();

    if (error) return { ok: false, message: "No se pudo actualizar la cuenta por pagar." };

    await writeAuditLog({ tableName: "accounts_payable", recordId: data.id, action: "accounts_payable.update", newData: { total_amount: data.total_amount, status: data.status } });
    revalidatePath("/admin/cuentas-por-pagar");
    return { ok: true, message: "Cuenta por pagar actualizada." };
  }

  const { data, error } = await admin
    .from("accounts_payable")
    .insert({ ...payload, paid_amount: 0, status: "pending", created_by: profile.id })
    .select("id, supplier_invoice_id, total_amount, status")
    .single();

  if (error) return { ok: false, message: "No se pudo crear la cuenta por pagar." };

  if (invoiceId) {
    await admin
      .from("supplier_invoices")
      .update({ status: "posted_to_ap", updated_at: new Date().toISOString() })
      .eq("id", invoiceId)
      .neq("status", "cancelled");
  }

  await writeAuditLog({ tableName: "accounts_payable", recordId: data.id, action: "accounts_payable.create", newData: { total_amount: data.total_amount, status: data.status, supplier_invoice_id: data.supplier_invoice_id } });
  await dispatchAccountingEvent({ sourceType: "accounts_payable", sourceId: data.id, eventPurpose: "accounts_payable_created", triggeredBy: profile.id, route: "/admin/cuentas-por-pagar" });
  revalidatePath("/admin/cuentas-por-pagar");
  return { ok: true, message: "Cuenta por pagar registrada." };
}

export async function cancelAccountsPayableAction(payableId: string): Promise<ActionResult> {
  const profile = await requirePermission("payables:manage");
  const admin = getSupabaseAdminClient();
  const { data: payable, error: payableError } = await admin
    .from("accounts_payable")
    .select("id, status, paid_amount")
    .eq("id", payableId)
    .maybeSingle<{ id: string; status: AccountsPayableStatus; paid_amount: unknown }>();

  if (payableError || !payable) return { ok: false, message: "La cuenta por pagar no existe." };
  if (["paid", "cancelled"].includes(payable.status)) return { ok: false, message: "Esta cuenta por pagar ya no se puede cancelar." };
  if (Number(payable.paid_amount ?? 0) > 0) return { ok: false, message: "No se puede cancelar una cuenta por pagar con pagos registrados." };

  const { error } = await admin
    .from("accounts_payable")
    .update({ status: "cancelled", cancelled_by: profile.id, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", payableId);

  if (error) return { ok: false, message: "No se pudo cancelar la cuenta por pagar." };

  await writeAuditLog({ tableName: "accounts_payable", recordId: payableId, action: "accounts_payable.cancel", newData: { status: "cancelled" } });
  revalidatePath("/admin/cuentas-por-pagar");
  return { ok: true, message: "Cuenta por pagar cancelada." };
}

export async function registerSupplierPaymentAction(input: SupplierPaymentFormInput): Promise<ActionResult> {
  await requirePermission("payables:manage");
  const payableId = cleanText(input.accounts_payable_id);
  const amount = toMoney(input.amount);
  const paymentMethod = cleanText(input.payment_method);
  const paidAt = cleanText(input.paid_at);
  const idempotencyKey = cleanText(input.idempotency_key);

  if (!payableId) return { ok: false, message: "Selecciona una cuenta por pagar." };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: "El pago debe ser mayor que cero." };
  if (!paymentMethod || !["cash", "bank_transfer", "card_credit", "card_debit"].includes(paymentMethod)) {
    return { ok: false, message: "Selecciona un método de pago permitido." };
  }
  if (!idempotencyKey || !uuidPattern.test(idempotencyKey)) {
    return { ok: false, message: "La clave segura del pago no es válida. Vuelve a abrir el formulario." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("register_supplier_payment_v2", {
    target_accounts_payable_id: payableId,
    payment_amount: amount,
    supplier_payment_method: paymentMethod,
    payment_paid_date: paidAt,
    payment_notes: cleanText(input.notes),
    request_key: idempotencyKey,
  });

  if (error) {
    return { ok: false, message: error.message || "No se pudo registrar el pago." };
  }

  const row = Array.isArray(data) ? data[0] : data;
  revalidatePath("/admin/cuentas-por-pagar");
  revalidatePath("/admin/contabilidad");
  const accountingMessage = row?.outbox_id
    ? " Pago registrado y enviado al procesamiento contable. La publicación continuará siendo manual."
    : " Pago registrado. Contabilidad pendiente de revisión histórica.";
  return {
    ok: true,
    message: `${row?.idempotent_replay ? "Pago recuperado sin duplicarlo." : "Pago a proveedor registrado."}${accountingMessage}`,
  };
}

export type SupplierPaymentRepairActionInput = {
  request_key: string;
  payment_id: string;
  expected_fingerprint: string;
  reason: string;
};

export type SupplierPaymentRepairActionResult =
  | { ok: true; message: string; result: SupplierPaymentRepairResult }
  | { ok: false; message: string };

export async function repairLateRecordedSupplierPaymentAction(
  input: SupplierPaymentRepairActionInput,
): Promise<SupplierPaymentRepairActionResult> {
  const profile = await requirePermission("accounting:repair_supplier_payment");
  if (profile.role !== "technical_owner") {
    return { ok: false, message: "Solo technical_owner puede ejecutar esta reparación." };
  }

  const requestKey = cleanText(input.request_key);
  const paymentId = cleanText(input.payment_id);
  const fingerprint = cleanText(input.expected_fingerprint)?.toLowerCase();
  const reason = cleanText(input.reason);

  if (!requestKey || !uuidPattern.test(requestKey)) {
    return { ok: false, message: "La clave segura de reparación no es válida." };
  }
  if (!paymentId || !uuidPattern.test(paymentId)) {
    return { ok: false, message: "El pago seleccionado no es válido." };
  }
  if (!fingerprint || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    return { ok: false, message: "La vista previa cambió o no es válida. Actualízala." };
  }
  if (!reason || reason.length < 8 || reason.includes("@") || /\d{8,}/.test(reason)) {
    return { ok: false, message: "Indica un motivo operativo sin datos sensibles." };
  }

  try {
    const result = await repairLateRecordedSupplierPayment({
      requestKey,
      paymentId,
      expectedFingerprint: fingerprint,
      reason,
    });

    revalidatePath("/admin/cuentas-por-pagar");
    revalidatePath("/admin/contabilidad");

    if (!result.ok || result.status === "review_required") {
      return {
        ok: true,
        message: "Pago registrado. Contabilidad pendiente de revisión histórica.",
        result,
      };
    }

    return {
      ok: true,
      message: result.idempotent_replay
        ? "La solicitud ya estaba protegida; no se duplicó ningún efecto."
        : "Pago enviado al procesamiento contable. La publicación continuará siendo manual.",
      result,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error
        ? error.message
        : "No se pudo ejecutar la reparación contable.",
    };
  }
}

export async function voidSupplierPaymentAction(paymentId: string, notes?: string, requestKey?: string): Promise<ActionResult> {
  await requirePermission("payables:manage");
  const id = cleanText(paymentId);
  const idempotencyKey = cleanText(requestKey);

  if (!id) return { ok: false, message: "Selecciona un pago valido." };
  if (!idempotencyKey || !uuidPattern.test(idempotencyKey)) {
    return { ok: false, message: "La clave segura de anulación no es válida." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("void_supplier_payment_v2", {
    target_supplier_payment_id: id,
    void_notes: cleanText(notes),
    request_key: idempotencyKey,
  });

  if (error) {
    return { ok: false, message: error.message || "No se pudo anular el pago." };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (row?.compensation_outbox_id) {
    await processAccountingOutboxV2({ outboxId: row.compensation_outbox_id });
  }
  revalidatePath("/admin/cuentas-por-pagar");
  revalidatePath("/admin/contabilidad");
  return { ok: true, message: row?.idempotent_replay ? "La anulación ya había sido aplicada." : "Pago anulado." };
}

export async function registerSupplierCreditAction(input: SupplierCreditFormInput): Promise<ActionResult> {
  const profile = await requirePermission("payables:manage");
  const supplierId = cleanText(input.supplier_id);
  const creditNumber = cleanText(input.credit_number);
  const creditDate = cleanText(input.credit_date);
  const amount = toMoney(input.amount);

  if (!supplierId) return { ok: false, message: "Selecciona un proveedor." };
  if (!creditNumber) return { ok: false, message: "El número de nota de crédito es obligatorio." };
  if (!creditDate) return { ok: false, message: "La fecha de nota de crédito es obligatoria." };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: "El monto de la nota de crédito debe ser mayor que cero." };

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("register_supplier_credit", {
    target_supplier_id: supplierId,
    supplier_credit_number: creditNumber,
    supplier_credit_date: creditDate,
    credit_amount: amount,
    target_purchase_id: cleanText(input.purchase_id),
    target_supplier_invoice_id: cleanText(input.supplier_invoice_id),
    target_accounts_payable_id: cleanText(input.accounts_payable_id),
    credit_reason: cleanText(input.reason),
  });

  if (error) {
    return { ok: false, message: error.message || "No se pudo registrar la nota de crédito." };
  }

  const row = Array.isArray(data) ? data[0] : data;
  await writeAuditLog({ tableName: "supplier_credits", recordId: row?.supplier_credit_id ?? null, action: "supplier_credits.create", newData: { supplier_id: supplierId, amount } });
  if (row?.supplier_credit_id) {
    await dispatchAccountingEvent({ sourceType: "supplier_credit", sourceId: row.supplier_credit_id, eventPurpose: "supplier_credit", triggeredBy: profile.id, route: "/admin/cuentas-por-pagar" });
  }
  revalidatePath("/admin/cuentas-por-pagar");
  return { ok: true, message: "Nota de crédito de proveedor registrada." };
}

const initialError = "No se pudo procesar la importacion de cuentas por pagar.";

function canImportPayables(profile: Awaited<ReturnType<typeof requirePermission>>) {
  return hasEffectivePermission(profile.role, profile.permissions, "payables:import", profile.email);
}

function canAssignPayables(profile: Awaited<ReturnType<typeof requirePermission>>) {
  return hasEffectivePermission(profile.role, profile.permissions, "payables:assign", profile.email);
}

function canApplyPayables(profile: Awaited<ReturnType<typeof requirePermission>>) {
  return hasEffectivePermission(profile.role, profile.permissions, "payables:apply", profile.email);
}

function canRollbackPayables(profile: Awaited<ReturnType<typeof requirePermission>>) {
  return ["technical_owner", "business_owner"].includes(profile.role) && hasEffectivePermission(profile.role, profile.permissions, "payables:rollback", profile.email);
}

function revalidatePayableImportPaths(batchId?: string | null) {
  revalidatePath("/admin/cuentas-por-pagar");
  revalidatePath("/admin/importaciones");
  if (batchId) revalidatePath(`/admin/cuentas-por-pagar?importBatch=${batchId}`);
}

export async function importHistoricalAccountsPayableAction(
  _previousState: HistoricalPayableImportActionState,
  formData: FormData,
): Promise<HistoricalPayableImportActionState> {
  const profile = await requirePermission("admin:access");
  if (!canImportPayables(profile)) return { ok: false, message: "No tienes permiso para importar cuentas por pagar.", errors: ["Permiso insuficiente."] };

  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, message: "Selecciona un archivo Excel .xlsx.", errors: ["Selecciona un archivo Excel .xlsx."] };

  await writeAuditLog({
    tableName: "import_batches",
    action: "historical_payable_import.attempted",
    newData: { fileName: file.name, fileSize: file.size },
  });

  try {
    const result = await createHistoricalAccountsPayableImportBatch(file, profile.id);
    await writeAuditLog({
      tableName: "import_batches",
      recordId: result.batchId,
      action: "historical_payable_import.staged",
      newData: { fileName: file.name, rows: result.rows.length, errors: result.errors.length, status: result.status },
    });
    revalidatePayableImportPaths(result.batchId);

    if (result.errors.length > 0 || result.rows.some((row) => row.validationStatus === "invalid")) {
      return {
        ok: false,
        message: "El archivo fue guardado en staging con errores para revision.",
        errors: result.errors.length > 0 ? result.errors : ["Revisa las filas marcadas con error."],
        batchId: result.batchId,
      };
    }

    const pending = result.rows.filter((row) => row.assignmentStatus === "pending" || row.assignmentStatus === "suggested").length;
    return {
      ok: true,
      message: pending > 0 ? "Importacion validada. Hay proveedores pendientes de confirmacion." : "Importacion validada y lista para aplicar.",
      errors: [],
      batchId: result.batchId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : initialError;
    await writeAuditLog({
      tableName: "import_batches",
      action: "historical_payable_import.failed",
      newData: { fileName: file.name, error: message },
    });
    return { ok: false, message: initialError, errors: [message] };
  }
}

export async function assignHistoricalPayableRowAction(rowId: string, supplierId: string) {
  const profile = await requirePermission("admin:access");
  if (!canAssignPayables(profile)) return { ok: false, message: "No tienes permiso para confirmar proveedores." };

  try {
    await assignHistoricalPayableImportRow(rowId, supplierId);
    await writeAuditLog({
      tableName: "import_rows",
      recordId: rowId,
      action: "historical_payable_import.supplier_confirmed",
      newData: { supplierConfirmed: true },
    });
    revalidatePayableImportPaths();
    return { ok: true, message: "Proveedor confirmado." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo confirmar el proveedor." };
  }
}

export async function cancelHistoricalPayableRowAction(rowId: string) {
  const profile = await requirePermission("admin:access");
  if (!canImportPayables(profile)) return { ok: false, message: "No tienes permiso para cancelar filas en staging." };

  try {
    await cancelHistoricalPayableImportRow(rowId);
    await writeAuditLog({
      tableName: "import_rows",
      recordId: rowId,
      action: "historical_payable_import.row_cancelled",
      newData: { cancelled: true },
    });
    revalidatePayableImportPaths();
    return { ok: true, message: "Fila cancelada en staging." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo cancelar la fila." };
  }
}

export async function applyHistoricalPayableBatchAction(batchId: string) {
  const profile = await requirePermission("admin:access");
  if (!canApplyPayables(profile)) return { ok: false, message: "No tienes permiso para aplicar el lote." };

  try {
    const summary = await applyHistoricalPayableImportBatch(batchId);
    await writeAuditLog({
      tableName: "import_batches",
      recordId: batchId,
      action: "historical_payable_import.batch_applied",
      newData: summary,
    });
    revalidatePayableImportPaths(batchId);
    return { ok: true, message: `Lote aplicado. CxP creadas: ${summary.payables.toLocaleString("es-HN")}. Pagos historicos: ${summary.payments.toLocaleString("es-HN")}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo aplicar el lote." };
  }
}

export async function cancelHistoricalPayableBatchAction(batchId: string) {
  const profile = await requirePermission("admin:access");
  if (!canImportPayables(profile)) return { ok: false, message: "No tienes permiso para cancelar lotes." };

  try {
    await setImportBatchStatus(batchId, "cancelled", { cancelled_from: "historical_accounts_payable_import" });
    await writeAuditLog({
      tableName: "import_batches",
      recordId: batchId,
      action: "historical_payable_import.batch_cancelled",
      newData: { cancelled: true },
    });
    revalidatePayableImportPaths(batchId);
    return { ok: true, message: "Lote cancelado." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo cancelar el lote." };
  }
}

export async function rollbackHistoricalPayableBatchAction(batchId: string, reason: string) {
  const profile = await requirePermission("admin:access");
  if (!canRollbackPayables(profile)) return { ok: false, message: "Solo technical_owner o business_owner pueden revertir lotes aplicados." };

  try {
    const result = await rollbackHistoricalPayableImportBatch(batchId, reason.trim());
    await writeAuditLog({
      tableName: "import_batches",
      recordId: batchId,
      action: "historical_payable_import.batch_rolled_back",
      newData: { reason, ...result },
    });
    revalidatePayableImportPaths(batchId);
    return { ok: true, message: "Rollback completado." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo revertir el lote." };
  }
}

export type SupplierMultiPaymentActionResult =
  | {
      ok: true;
      message: string;
      result: SupplierMultiPaymentRpcResult;
    }
  | { ok: false; message: string };

function supplierMultiPaymentErrorMessage(error: unknown) {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "";

  if (message.includes("clave de solicitud")) {
    return "La solicitud ya fue usada con datos distintos. Cancela el borrador y vuelve a iniciar.";
  }
  if (message.includes("saldo") || message.includes("40001")) {
    return "Uno de los saldos cambió. Actualiza las facturas y revisa la distribución.";
  }
  if (message.includes("reconocimiento")) {
    return "Una obligación no cumple el reconocimiento contable requerido.";
  }
  if (message.includes("mapping") || message.includes("cuentas contables")) {
    return "Falta una configuración contable activa para este método.";
  }
  if (message.includes("periodo cerrado")) {
    return "La fecha contable pertenece a un período cerrado.";
  }
  if (message.includes("habilitado")) {
    return "El pago multifáctura todavía no está habilitado.";
  }
  return "No se pudo registrar el pago. No se aplicó ningún cambio.";
}

export async function getSupplierOpenPayablesAction(input: unknown) {
  await requirePermission("payables:manage");
  const parsed = supplierOpenPayablesQuerySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false as const,
      message: "Los filtros de cuentas por pagar no son válidos.",
      items: [],
      nextCursor: null,
    };
  }

  try {
    const result = await getSupplierOpenPayables(parsed.data);
    return { ok: true as const, ...result };
  } catch {
    return {
      ok: false as const,
      message: "No se pudieron cargar las cuentas por pagar del proveedor.",
      items: [],
      nextCursor: null,
    };
  }
}

export async function registerSupplierMultiPaymentAction(
  formData: FormData,
): Promise<SupplierMultiPaymentActionResult> {
  const actor = await requirePermission("payables:manage");

  const payloadValue = formData.get("payload");
  if (typeof payloadValue !== "string" || payloadValue.length > 120_000) {
    return { ok: false, message: "El borrador del pago no es válido." };
  }

  let rawInput: unknown;
  try {
    rawInput = JSON.parse(payloadValue);
  } catch {
    return { ok: false, message: "El borrador del pago no es válido." };
  }

  if (
    typeof rawInput === "object" &&
    rawInput !== null &&
    "receipt_public_id" in rawInput &&
    rawInput.receipt_public_id
  ) {
    return {
      ok: false,
      message: "El identificador del comprobante solo puede derivarse en el servidor.",
    };
  }

  const parsed = supplierMultiPaymentSchema.safeParse({
    ...(typeof rawInput === "object" && rawInput !== null ? rawInput : {}),
    receipt_public_id: null,
  });
  if (!parsed.success) {
    return {
      ok: false,
      message:
        parsed.error.issues[0]?.message ??
        "Revisa los datos y la distribución del pago.",
    };
  }

  const receiptValue = formData.get("receipt");
  const receipt = receiptValue instanceof File ? receiptValue : null;
  let upload: Awaited<
    ReturnType<typeof uploadSupplierPaymentReceipt>
  > = null;

  try {
    upload = await uploadSupplierPaymentReceipt(
      receipt,
      parsed.data.request_key,
    );
    const result = await registerSupplierMultiPayment({
      ...parsed.data,
      receipt_public_id: upload?.publicId ?? null,
    });

    revalidatePath("/admin/cuentas-por-pagar");
    revalidatePath("/admin/contabilidad");
    return {
      ok: true,
      message: result.replayed
        ? "Pago recuperado sin duplicarlo."
        : "Pago registrado en una sola transacción. El borrador contable se publicará manualmente.",
      result,
    };
  } catch (error) {
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;
    const errorMessage =
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
        ? error.message
        : "";
    const responseUnknown =
      !errorCode &&
      /fetch|network|timeout|connection|respuesta/i.test(errorMessage);

    if (!responseUnknown) {
      console.warn(
        errorCode === "40001"
          ? "supplier_multi_payment_balance_conflict"
          : "supplier_multi_payment_rejected",
        {
          actor_id: actor.id,
          actor_role: actor.role,
          supplier_id: parsed.data.supplier_id,
          payment_total: parsed.data.applications.reduce(
            (sum, application) => sum + application.applied_amount,
            0,
          ),
          payment_method: parsed.data.payment_method,
          paid_date: parsed.data.paid_date,
          application_count: parsed.data.applications.length,
          request_key_suffix: parsed.data.request_key.slice(-8),
          error_code: errorCode ?? "application_rejected",
          result: "rejected",
        },
      );
    }
    return { ok: false, message: supplierMultiPaymentErrorMessage(error) };
  }
}

export async function voidSupplierMultiPaymentAction(
  input: unknown,
): Promise<ActionResult> {
  await requirePermission("payables:manage");
  const parsed = supplierMultiPaymentVoidSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "La anulación no es válida.",
    };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    "void_supplier_multi_payment_v1",
    {
      p_payment_id: parsed.data.payment_id,
      p_request_key: parsed.data.request_key,
      p_reason: parsed.data.reason,
    },
  );
  if (error) {
    return {
      ok: false,
      message: "No se pudo anular el pago completo. No se aplicó ningún cambio.",
    };
  }

  revalidatePath("/admin/cuentas-por-pagar");
  revalidatePath("/admin/contabilidad");
  return {
    ok: true,
    message: data?.replayed
      ? "La anulación completa ya había sido aplicada."
      : "Pago completo anulado y saldos restaurados.",
  };
}
