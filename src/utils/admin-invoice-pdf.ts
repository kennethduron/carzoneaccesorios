"use client";

import type { AdminInvoiceDetail } from "@/types/invoices";
import { downloadFiscalInvoicePdf } from "@/utils/fiscal-invoice-pdf";

export async function exportAdminInvoicePdf(invoice: AdminInvoiceDetail) {
  await downloadFiscalInvoicePdf({
    invoiceNumber: invoice.invoice_number,
    orderNumber: invoice.order_number,
    status: invoice.status,
    issuedAt: invoice.issued_at,
    dueAt: invoice.due_at,
    createdAt: invoice.created_at,
    companyLegalName: invoice.company_legal_name,
    companyRtn: invoice.company_rtn ?? invoice.rtn,
    companyAddress: invoice.company_address,
    companyPhone: invoice.company_phone,
    companyEmail: invoice.company_email,
    companyLogoUrl: invoice.company_logo_url,
    cai: invoice.cai,
    fiscalRangeStart: invoice.fiscal_range_start,
    fiscalRangeEnd: invoice.fiscal_range_end,
    fiscalDeadline: invoice.due_at,
    customerName: invoice.customer_name,
    customerRtn: invoice.customer_rtn,
    customerEmail: invoice.customer_email,
    customerPhone: invoice.customer_phone,
    customerAddress: invoice.customer_address,
    paymentMethod: invoice.payment_method,
    paymentStatus: invoice.payment_status,
    paymentReference: invoice.bank_reference_number,
    transferReceiptUrl: invoice.transfer_receipt_url,
    subtotal: invoice.subtotal,
    tax: invoice.tax,
    shippingFee: invoice.shipping_fee,
    cashOnDeliveryFee: invoice.cash_on_delivery_fee,
    smallOrderFee: invoice.small_order_fee,
    discountTotal: invoice.discount_total,
    additionalFees: invoice.additional_fees,
    total: invoice.total,
    items: invoice.items.map((item) => ({
      sku: item.sku,
      name: item.product_name,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      lineTotal: item.line_total,
    })),
  });
}
