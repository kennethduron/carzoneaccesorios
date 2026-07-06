"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { dispatchAccountingEvent } from "@/services/accounting/accounting-event-dispatcher";
import type { AccountsPayableStatus, SupplierInvoiceStatus } from "@/types/purchases";

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

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
  payment_method: string;
  paid_at?: string | null;
  notes?: string | null;
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
  if (message.includes("supplier_invoices_supplier_invoice_active_unique")) {
    return "Ya existe una factura activa con ese numero para este proveedor.";
  }

  return "No se pudo guardar la factura de proveedor.";
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
  if (!invoiceNumber) return { ok: false, message: "El numero de factura es obligatorio." };
  if (!invoiceDate) return { ok: false, message: "La fecha de factura es obligatoria." };
  if (!Number.isFinite(subtotal) || subtotal < 0 || !Number.isFinite(taxAmount) || taxAmount < 0 || !Number.isFinite(discountAmount) || discountAmount < 0) {
    return { ok: false, message: "Los montos de la factura no pueden ser negativos." };
  }

  const total = Math.max(Math.round((subtotal + taxAmount - discountAmount) * 100) / 100, 0);

  try {
    await ensureActiveSupplier(supplierId);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Proveedor invalido." };
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
    return { ok: false, message: error instanceof Error ? error.message : "Proveedor invalido." };
  }

  const admin = getSupabaseAdminClient();
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
  const profile = await requirePermission("payables:manage");
  const payableId = cleanText(input.accounts_payable_id);
  const amount = toMoney(input.amount);
  const paymentMethod = cleanText(input.payment_method);
  const paidAt = cleanText(input.paid_at);

  if (!payableId) return { ok: false, message: "Selecciona una cuenta por pagar." };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: "El pago debe ser mayor que cero." };
  if (!paymentMethod) return { ok: false, message: "El metodo de pago es obligatorio." };

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("register_supplier_payment", {
    target_accounts_payable_id: payableId,
    payment_amount: amount,
    payment_method: paymentMethod,
    payment_paid_at: paidAt ? new Date(paidAt).toISOString() : new Date().toISOString(),
    payment_notes: cleanText(input.notes),
  });

  if (error) {
    return { ok: false, message: error.message || "No se pudo registrar el pago." };
  }

  const row = Array.isArray(data) ? data[0] : data;
  await writeAuditLog({ tableName: "supplier_payments", recordId: row?.payment_id ?? null, action: "supplier_payments.pay", newData: { accounts_payable_id: payableId, amount } });
  if (row?.payment_id) {
    await dispatchAccountingEvent({ sourceType: "supplier_payment", sourceId: row.payment_id, eventPurpose: "supplier_payment", triggeredBy: profile.id, route: "/admin/cuentas-por-pagar" });
  }
  revalidatePath("/admin/cuentas-por-pagar");
  return { ok: true, message: "Pago a proveedor registrado." };
}

export async function voidSupplierPaymentAction(paymentId: string, notes?: string): Promise<ActionResult> {
  const profile = await requirePermission("payables:manage");
  const id = cleanText(paymentId);

  if (!id) return { ok: false, message: "Selecciona un pago valido." };

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("void_supplier_payment", {
    target_supplier_payment_id: id,
    void_notes: cleanText(notes),
  });

  if (error) {
    return { ok: false, message: error.message || "No se pudo anular el pago." };
  }

  const row = Array.isArray(data) ? data[0] : data;
  await writeAuditLog({ tableName: "supplier_payments", recordId: id, action: "supplier_payments.void", newData: { accounts_payable_id: row?.accounts_payable_id ?? null } });
  await dispatchAccountingEvent({ sourceType: "supplier_payment", sourceId: id, eventPurpose: "supplier_payment_cancelled", triggeredBy: profile.id, route: "/admin/cuentas-por-pagar" });
  revalidatePath("/admin/cuentas-por-pagar");
  return { ok: true, message: "Pago anulado." };
}

export async function registerSupplierCreditAction(input: SupplierCreditFormInput): Promise<ActionResult> {
  const profile = await requirePermission("payables:manage");
  const supplierId = cleanText(input.supplier_id);
  const creditNumber = cleanText(input.credit_number);
  const creditDate = cleanText(input.credit_date);
  const amount = toMoney(input.amount);

  if (!supplierId) return { ok: false, message: "Selecciona un proveedor." };
  if (!creditNumber) return { ok: false, message: "El numero de nota de credito es obligatorio." };
  if (!creditDate) return { ok: false, message: "La fecha de nota de credito es obligatoria." };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: "El monto de la nota de credito debe ser mayor que cero." };

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
    return { ok: false, message: error.message || "No se pudo registrar la nota de credito." };
  }

  const row = Array.isArray(data) ? data[0] : data;
  await writeAuditLog({ tableName: "supplier_credits", recordId: row?.supplier_credit_id ?? null, action: "supplier_credits.create", newData: { supplier_id: supplierId, amount } });
  if (row?.supplier_credit_id) {
    await dispatchAccountingEvent({ sourceType: "supplier_credit", sourceId: row.supplier_credit_id, eventPurpose: "supplier_credit", triggeredBy: profile.id, route: "/admin/cuentas-por-pagar" });
  }
  revalidatePath("/admin/cuentas-por-pagar");
  return { ok: true, message: "Nota de credito de proveedor registrada." };
}
