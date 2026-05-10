"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { validateFiscalInvoiceSettings } from "@/utils/fiscal";

function numberValue(value: unknown) {
  return Number(value ?? 0);
}

type OrderForInvoice = {
  id: string;
  order_number: string;
  customer_id: string | null;
  customer_name: string;
  payment_method: "bank_transfer" | "card" | "cash";
  price_mode: "retail" | "wholesale";
  subtotal: unknown;
  tax: unknown;
  total: unknown;
  order_items: Array<{
    id: string;
    product_id: string | null;
    sku: string;
    product_name: string;
    quantity: unknown;
    unit_price: unknown;
    line_total: unknown;
    retail_price_snapshot: unknown;
    wholesale_price_snapshot: unknown;
  }> | null;
  payments: Array<{
    bank_reference_number: string | null;
    reference: string | null;
  }> | null;
  customers: {
    tax_id: string | null;
  } | null;
};

type PaymentStatus = "approved" | "rejected";

export async function updateOrderPaymentStatusAction(orderId: string, status: PaymentStatus) {
  await requirePermission("payments:manage");
  const supabase = await getSupabaseServerClient();
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, order_number, status")
    .eq("id", orderId)
    .single<{ id: string; order_number: string; status: string }>();

  if (orderError) {
    return { ok: false, message: orderError.message };
  }

  const { data: payment, error: paymentError } = await supabase
    .from("payments")
    .select("id, payment_status, status, paid_at, amount, bank_reference_number, reference")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{
      id: string;
      payment_status: string | null;
      status: string | null;
      paid_at: string | null;
      amount: number;
      bank_reference_number: string | null;
      reference: string | null;
    }>();

  if (paymentError) {
    return { ok: false, message: paymentError.message };
  }

  if (!payment) {
    return { ok: false, message: "No hay pago registrado para este pedido." };
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

  const nextOrderStatus = status === "approved" ? "paid" : "pending";
  const { error: updateOrderError } = await supabase
    .from("orders")
    .update({
      status: nextOrderStatus,
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
      payment_id: payment.id,
      payment_status: payment.payment_status ?? payment.status,
      paid_at: payment.paid_at,
      amount: payment.amount,
      bank_reference: payment.bank_reference_number ?? payment.reference,
    },
    newData: {
      order_id: order.id,
      order_number: order.order_number,
      order_status: nextOrderStatus,
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

  return {
    ok: true,
    message: status === "approved" ? "Pago confirmado. El pedido queda pagado." : "Pago rechazado. El pedido queda pendiente.",
  };
}

export async function generateInvoiceFromOrderAction(orderId: string) {
  await requirePermission("invoices:create");
  const supabase = await getSupabaseServerClient();
  const fiscalSettings = await getFiscalSettings();
  const fiscalValidation = validateFiscalInvoiceSettings(fiscalSettings);

  if (!fiscalValidation.ok) {
    return { ok: false, message: fiscalValidation.message };
  }

  const invoiceNumber = fiscalValidation.invoiceNumber;

  const { data: existingInvoice, error: existingInvoiceError } = await supabase
    .from("invoices")
    .select("id, invoice_number")
    .eq("order_id", orderId)
    .maybeSingle<{ id: string; invoice_number: string }>();

  if (existingInvoiceError) {
    return { ok: false, message: `Error fiscal: no se pudo validar si el pedido ya tiene factura. ${existingInvoiceError.message}` };
  }

  if (existingInvoice) {
    return { ok: false, message: `Error fiscal: este pedido ya tiene la factura ${existingInvoice.invoice_number}.` };
  }

  const { data: duplicatedNumber, error: duplicatedNumberError } = await supabase
    .from("invoices")
    .select("id")
    .eq("invoice_number", invoiceNumber)
    .maybeSingle<{ id: string }>();

  if (duplicatedNumberError) {
    return { ok: false, message: `Error fiscal: no se pudo validar el número de factura. ${duplicatedNumberError.message}` };
  }

  if (duplicatedNumber) {
    return { ok: false, message: `Error fiscal: el número de factura ${invoiceNumber} ya existe.` };
  }

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select(
      `
      id,
      order_number,
      customer_id,
      customer_name,
      payment_method,
      price_mode,
      subtotal,
      tax,
      total,
      order_items(
        id,
        product_id,
        sku,
        product_name,
        quantity,
        unit_price,
        line_total,
        retail_price_snapshot,
        wholesale_price_snapshot
      ),
      payments(bank_reference_number, reference),
      customers(tax_id)
    `,
    )
    .eq("id", orderId)
    .maybeSingle<OrderForInvoice>();

  if (orderError) {
    return { ok: false, message: orderError.message };
  }

  if (!order) {
    return { ok: false, message: "No se encontró el pedido." };
  }

  if (!order.order_items?.length) {
    return { ok: false, message: "El pedido no tiene productos para facturar." };
  }

  const now = new Date().toISOString();
  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .insert({
      order_id: order.id,
      customer_id: order.customer_id,
      invoice_number: invoiceNumber,
      rtn: fiscalSettings.rtn || null,
      cai: fiscalSettings.cai || null,
      customer_rtn: order.customers?.tax_id ?? null,
      status: "emitida",
      price_mode: order.price_mode,
      subtotal: numberValue(order.subtotal),
      tax: numberValue(order.tax),
      total: numberValue(order.total),
      issued_at: now,
      due_at: fiscalSettings.emission_deadline,
      company_legal_name: fiscalSettings.legal_name,
      company_rtn: fiscalSettings.rtn,
      company_address: fiscalSettings.fiscal_address,
      company_phone: fiscalSettings.phone,
      company_email: fiscalSettings.email,
      company_logo_url: fiscalSettings.logo_url,
      fiscal_range_start: fiscalSettings.invoice_range_start,
      fiscal_range_end: fiscalSettings.invoice_range_end,
    })
    .select("id, invoice_number")
    .single<{ id: string; invoice_number: string }>();

  if (invoiceError) {
    if (invoiceError.code === "23505") {
      return { ok: false, message: "Error fiscal: ya existe una factura para este pedido o para este número fiscal." };
    }

    return { ok: false, message: `Error fiscal: no se pudo crear la factura. ${invoiceError.message}` };
  }

  const invoiceItems = order.order_items.map((item) => ({
    invoice_id: invoice.id,
    order_item_id: item.id,
    product_id: item.product_id,
    sku: item.sku,
    product_name: item.product_name,
    quantity: numberValue(item.quantity),
    unit_price: numberValue(item.unit_price),
    line_total: numberValue(item.line_total),
    retail_price_snapshot: numberValue(item.retail_price_snapshot),
    wholesale_price_snapshot: numberValue(item.wholesale_price_snapshot),
  }));

  const { error: itemsError } = await supabase.from("invoice_items").insert(invoiceItems);

  if (itemsError) {
    return { ok: false, message: itemsError.message };
  }

  const { error: settingsError } = await supabase.rpc("advance_fiscal_invoice_number", {
    expected_invoice_number: invoiceNumber,
    next_invoice_number: fiscalValidation.nextInvoiceNumber,
  });

  if (settingsError) {
    await writeAuditLog({
      tableName: "invoices",
      recordId: invoice.id,
      action: "fiscal.invoice_number_advance_failed",
      oldData: {
        invoice_number: invoiceNumber,
        current_invoice_number: invoiceNumber,
      },
      newData: {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        order_id: order.id,
        order_number: order.order_number,
        attempted_next_invoice_number: fiscalValidation.nextInvoiceNumber,
        error: settingsError.message,
      },
    });
    return { ok: false, message: `Error fiscal: no se pudo avanzar el correlativo fiscal. ${settingsError.message}` };
  }

  await writeAuditLog({
    tableName: "invoices",
    recordId: invoice.id,
    action: "fiscal.invoice.created",
    newData: {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      order_id: order.id,
      order_number: order.order_number,
      customer_id: order.customer_id,
      customer_name: order.customer_name,
      customer_rtn: order.customers?.tax_id ?? null,
      cai: fiscalSettings.cai || null,
      company_rtn: fiscalSettings.rtn || null,
      fiscal_range_start: fiscalSettings.invoice_range_start,
      fiscal_range_end: fiscalSettings.invoice_range_end,
      previous_invoice_number: invoiceNumber,
      next_invoice_number: fiscalValidation.nextInvoiceNumber,
      subtotal: numberValue(order.subtotal),
      tax: numberValue(order.tax),
      total: numberValue(order.total),
      price_mode: order.price_mode,
      payment_method: order.payment_method,
      bank_reference: order.payments?.[0]?.bank_reference_number ?? order.payments?.[0]?.reference ?? null,
      items: invoiceItems.map((item) => ({
        order_item_id: item.order_item_id,
        product_id: item.product_id,
        sku: item.sku,
        product_name: item.product_name,
        quantity: item.quantity,
        unit_price: item.unit_price,
        line_total: item.line_total,
      })),
    },
  });

  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/facturas");
  revalidatePath("/admin/reportes");
  revalidatePath("/admin/configuracion-fiscal");

  return {
    ok: true,
    message: `Factura ${invoice.invoice_number} generada correctamente.`,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    bankReference: order.payments?.[0]?.bank_reference_number ?? order.payments?.[0]?.reference ?? null,
  };
}
