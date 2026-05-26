"use client";

import type { StoreInvoice } from "@/types/invoices";
import { downloadFiscalInvoicePdf, generateFiscalInvoicePdf } from "@/utils/fiscal-invoice-pdf";

function toFiscalInvoice(invoice: StoreInvoice) {
  return {
    invoiceNumber: invoice.invoiceNumber,
    orderNumber: invoice.orderNumber,
    status: invoice.status,
    issuedAt: invoice.issuedAt,
    dueAt: invoice.fiscalDeadline,
    createdAt: invoice.issuedAt,
    companyLegalName: invoice.companyLegalName,
    companyRtn: invoice.companyRtn ?? invoice.rtn,
    companyAddress: invoice.companyAddress,
    companyPhone: invoice.companyPhone,
    companyEmail: invoice.companyEmail,
    companyLogoUrl: invoice.companyLogoUrl,
    cai: invoice.cai,
    fiscalRangeStart: invoice.fiscalRangeStart,
    fiscalRangeEnd: invoice.fiscalRangeEnd,
    fiscalDeadline: invoice.fiscalDeadline,
    customerName: invoice.customerName,
    customerRtn: invoice.customerRtn,
    customerEmail: invoice.customerEmail,
    customerPhone: invoice.customerPhone,
    customerAddress: invoice.customerAddress,
    paymentMethod: invoice.paymentMethod,
    paymentStatus: null,
    paymentReference: invoice.paymentReference,
    subtotal: invoice.subtotal,
    tax: invoice.isv,
    shippingFee: invoice.shippingFee,
    cashOnDeliveryFee: invoice.cashOnDeliveryFee,
    total: invoice.total,
    items: invoice.items.map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
    })),
  };
}

export async function generateInvoicePdf(invoice: StoreInvoice) {
  return generateFiscalInvoicePdf(toFiscalInvoice(invoice));
}

export async function downloadInvoicePdf(invoice: StoreInvoice) {
  await downloadFiscalInvoicePdf(toFiscalInvoice(invoice));
}
