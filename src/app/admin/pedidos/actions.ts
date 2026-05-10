"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { getFiscalAlerts } from "@/utils/fiscal";

function numberValue(value: unknown) {
  return Number(value ?? 0);
}

function invoiceNumberValue(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

function incrementInvoiceNumber(value: string) {
  const match = value.match(/(\d+)(?!.*\d)/);
  if (!match) {
    return value;
  }

  const current = match[1];
  const next = String(Number(current) + 1).padStart(current.length, "0");
  return `${value.slice(0, match.index)}${next}${value.slice((match.index ?? 0) + current.length)}`;
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

export async function generateInvoiceFromOrderAction(orderId: string) {
  await requirePermission("invoices:create");
  const supabase = await getSupabaseServerClient();
  const fiscalSettings = await getFiscalSettings();
  const fiscalAlerts = getFiscalAlerts(fiscalSettings);

  if (fiscalAlerts.some((alert) => alert.message === "La fecha límite de emisión está vencida.")) {
    return { ok: false, message: "La fecha límite de emisión está vencida." };
  }

  const invoiceNumber = fiscalSettings.current_invoice_number.trim();
  const current = invoiceNumberValue(invoiceNumber);
  const rangeStart = invoiceNumberValue(fiscalSettings.invoice_range_start);
  const rangeEnd = invoiceNumberValue(fiscalSettings.invoice_range_end);

  if (!invoiceNumber || current === null || rangeStart === null || rangeEnd === null) {
    return { ok: false, message: "Configura el número actual y el rango fiscal antes de generar facturas." };
  }

  if (current < rangeStart || current > rangeEnd) {
    return { ok: false, message: "No se puede emitir factura fuera del rango autorizado." };
  }

  const { data: existingInvoice, error: existingInvoiceError } = await supabase
    .from("invoices")
    .select("id, invoice_number")
    .eq("order_id", orderId)
    .maybeSingle<{ id: string; invoice_number: string }>();

  if (existingInvoiceError) {
    return { ok: false, message: existingInvoiceError.message };
  }

  if (existingInvoice) {
    return { ok: false, message: `Este pedido ya tiene la factura ${existingInvoice.invoice_number}.` };
  }

  const { data: duplicatedNumber, error: duplicatedNumberError } = await supabase
    .from("invoices")
    .select("id")
    .eq("invoice_number", invoiceNumber)
    .maybeSingle<{ id: string }>();

  if (duplicatedNumberError) {
    return { ok: false, message: duplicatedNumberError.message };
  }

  if (duplicatedNumber) {
    return { ok: false, message: "No se puede repetir un número de factura." };
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
    return { ok: false, message: invoiceError.message };
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
    next_invoice_number: incrementInvoiceNumber(invoiceNumber),
  });

  if (settingsError) {
    return { ok: false, message: settingsError.message };
  }

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
