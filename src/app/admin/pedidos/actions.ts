"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";

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
    bankReference: null,
  };
}
