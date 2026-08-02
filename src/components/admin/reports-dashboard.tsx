"use client";

import { useMemo, useState } from "react";
import { Download, FileSpreadsheet, FileText, Filter, Printer, Search } from "lucide-react";
import { PaginationControls } from "@/components/admin/pagination-controls";
import {
  buildReceivablePaymentReportRow,
  reportRowMatchesSearch,
} from "@/components/admin/report-receivable-payment";
import { Button, Input } from "@/components/ui";
import type { FiscalSettings } from "@/types/fiscal";
import type { InvoiceStatus } from "@/types/invoices";
import type { AdminReportsData, ReportAccessMode, ReportOrder } from "@/types/reports";
import { invoiceNumberValue } from "@/utils/fiscal";
import { additionalFeesTotal } from "@/utils/financial-summary";
import { formatHnDate, formatHnMonth } from "@/utils/format";
import { detailedPaymentMethodLabels, paymentMethodLabel } from "@/utils/payment-labels";
import { formatCurrency } from "@/utils/pricing";

type ReportKey =
  | "daily"
  | "range"
  | "monthly"
  | "issuedInvoices"
  | "cancelledInvoices"
  | "fiscalCorrelatives"
  | "missingCorrelatives"
  | "paymentMethods"
  | "creditReceivablePayments"
  | "bankTransfers"
  | "soldProductsDetail"
  | "customerSales"
  | "invoiceDetails"
  | "wholesaleSales"
  | "productRanking"
  | "inventoryStatus"
  | "paymentMethodDetails"
  | "topProducts"
  | "inventory"
  | "lowStock"
  | "orderFinancialStatus"
  | "expiredReservations";

type ReportRow = Record<string, string | number>;

type ReportDefinition = {
  key: ReportKey;
  label: string;
  description: string;
  columns: string[];
  rows: ReportRow[];
  financial?: boolean;
};

type ReportsDashboardProps = {
  data: AdminReportsData;
  fiscalSettings: FiscalSettings | null;
  accessMode: ReportAccessMode;
  canUseTechnicalExports: boolean;
};

const paymentLabels: Record<string, string> = {
  ...detailedPaymentMethodLabels,
  bank_transfer: "Transferencia",
  card: "Tarjeta mediante enlace",
};

const receivableStatusLabels: Record<string, string> = {
  open: "Abierto",
  partial: "Pago parcial",
  paid: "Pagado",
  overdue: "Vencido",
  cancelled: "Cancelado",
};

function reportPaymentLabel(method: string | null | undefined) {
  if (!method) return "-";
  return paymentLabels[method] ?? paymentMethodLabel(method, { detailedCard: true });
}

const priceModeLabels: Record<string, string> = {
  retail: "Detalle",
  wholesale: "Mayorista",
};

const invoiceStatusLabels: Record<string, string> = {
  emitida: "Emitida",
  issued: "Emitida",
  paid: "Emitida",
  anulada: "Anulada",
  cancelled: "Anulada",
  pendiente: "Pendiente",
  draft: "Pendiente",
};

const orderStatusLabels: Record<string, string> = {
  recibido: "Recibido",
  confirmado: "Confirmado",
  preparacion: "Preparación",
  empacado: "Empacado",
  enviado: "Enviado",
  en_ruta: "En ruta",
  entregado: "Entregado",
  cancelado: "Cancelado",
  pending: "Recibido",
  confirmed: "Confirmado",
  paid: "Pagado",
  preparing: "Preparación",
  shipped: "Enviado",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

const paymentStatusLabels: Record<string, string> = {
  pending: "Pendiente",
  review: "En revisión",
  under_review: "En revisión",
  approved: "Confirmado",
  confirmed: "Confirmado",
  paid: "Pagado",
  rejected: "Rechazado",
  refunded: "Reembolsado",
};

const reservationStatusLabels: Record<string, string> = {
  not_required: "No aplica",
  reserved: "Activa",
  confirmed: "Convertida en venta",
  released: "Liberada",
  expired: "Vencida",
  canceled: "Cancelada",
};

function formatDate(value: string | null) {
  return formatHnDate(value);
}

function normalizeDay(value: string) {
  return value.slice(0, 10);
}

function normalizeMonth(value: string) {
  return value.slice(0, 7);
}

function isRevenueOrder(order: ReportOrder) {
  return !["cancelado", "cancelled"].includes(order.status) && ["approved", "confirmed", "paid"].includes(String(order.payment_status ?? ""));
}

function safeProductName(name: string, sku: string) {
  const trimmed = name.trim();
  return trimmed && trimmed !== sku ? trimmed : `Producto sin nombre registrado (${sku})`;
}

function primaryInvoice(order: ReportOrder) {
  return order.invoices.find((invoice) => !["anulada", "cancelled"].includes(String(invoice.status ?? ""))) ?? order.invoices[0] ?? null;
}

function downloadBlob(content: string, fileName: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function buildCsv(columns: string[], rows: ReportRow[]) {
  return [columns.map(csvEscape).join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column] ?? "")).join(","))].join("\n");
}

function htmlEscape(value: string | number) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildExcelTable(title: string, columns: string[], rows: ReportRow[]) {
  const header = columns.map((column) => `<th>${htmlEscape(column)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${columns.map((column) => `<td>${htmlEscape(row[column] ?? "")}</td>`).join("")}</tr>`)
    .join("");

  return `
    <html>
      <head><meta charset="utf-8" /></head>
      <body>
        <h1>${htmlEscape(title)}</h1>
        <table border="1">
          <thead><tr>${header}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </body>
    </html>
  `;
}

function reportParams(filters: AdminReportsData["filters"]) {
  return {
    startDate: filters.startDate,
    endDate: filters.endDate,
    customer: filters.customer,
    product: filters.product,
    sku: filters.sku,
    invoice: filters.invoice,
    paymentMethod: filters.paymentMethod,
    priceMode: filters.priceMode,
    invoiceStatus: filters.invoiceStatus,
    orderStatus: filters.orderStatus,
  };
}

export function ReportsDashboard({ data, fiscalSettings, accessMode, canUseTechnicalExports }: ReportsDashboardProps) {
  const [activeReport, setActiveReport] = useState<ReportKey>(accessMode === "fiscal" ? "invoiceDetails" : accessMode === "full" ? "soldProductsDetail" : "topProducts");
  const [exportingPdf, setExportingPdf] = useState(false);
  const [reportSearch, setReportSearch] = useState("");
  const canExport = accessMode === "full" || accessMode === "fiscal";

  const paymentByOrder = useMemo(() => {
    const map = new Map<string, AdminReportsData["payments"][number]>();
    data.payments.forEach((payment) => {
      if (!map.has(payment.order_id)) {
        map.set(payment.order_id, payment);
      }
    });
    return map;
  }, [data.payments]);

  const invoiceByOrder = useMemo(() => {
    const map = new Map<string, AdminReportsData["invoices"][number]>();
    data.invoices.forEach((invoice) => {
      if (!map.has(invoice.order_id) || !["anulada", "cancelled"].includes(invoice.status)) {
        map.set(invoice.order_id, invoice);
      }
    });
    return map;
  }, [data.invoices]);

  const revenueOrders = useMemo(() => data.orders.filter(isRevenueOrder), [data.orders]);
  const totalSold = revenueOrders.reduce((sum, order) => sum + order.total, 0);
  const totalIsv = revenueOrders.reduce((sum, order) => sum + order.tax, 0);
  const totalNet = revenueOrders.reduce((sum, order) => sum + order.subtotal, 0);
  const totalShipping = revenueOrders.reduce((sum, order) => sum + (order.shipping_fee || order.shipping_total), 0);
  const totalCashOnDelivery = revenueOrders.reduce((sum, order) => sum + order.cash_on_delivery_fee, 0);
  const totalSmallOrderFees = revenueOrders.reduce((sum, order) => sum + order.small_order_fee, 0);
  const totalDiscounts = revenueOrders.reduce((sum, order) => sum + order.discount_total, 0);
  const totalOtherFees = revenueOrders.reduce((sum, order) => sum + additionalFeesTotal(order.additional_fees), 0);
  const totalSurcharges = totalShipping + totalCashOnDelivery + totalSmallOrderFees + totalOtherFees;
  const totalItems = revenueOrders.reduce(
    (sum, order) => sum + order.order_items.reduce((itemSum, item) => itemSum + item.quantity, 0),
    0,
  );
  const lowStockCount = data.products.filter((product) => product.available_stock <= product.min_stock).length;
  const pendingPaymentCount = data.orders.filter((order) => ["pending", "review", "under_review"].includes(String(order.payment_status ?? ""))).length;
  const expiredReservationCount = data.orders.filter((order) => order.reservation_review_required).length;
  const issuedInvoiceCount = data.invoices.filter((invoice) => !["anulada", "cancelled"].includes(String(invoice.status))).length;
  const cancelledInvoiceCount = data.invoices.filter((invoice) => ["anulada", "cancelled"].includes(String(invoice.status))).length;
  const fiscalInvoiceTotal = data.invoices
    .filter((invoice) => !["anulada", "cancelled"].includes(String(invoice.status)))
    .reduce((sum, invoice) => sum + invoice.total, 0);
  const fiscalTaxTotal = data.invoices
    .filter((invoice) => !["anulada", "cancelled"].includes(String(invoice.status)))
    .reduce((sum, invoice) => sum + invoice.tax, 0);

  const reportDefinitions = useMemo<ReportDefinition[]>(() => {
    const dailySales = new Map<string, { orders: number; units: number; subtotal: number; tax: number; shipping: number; cod: number; fees: number; discounts: number; total: number }>();
    const monthlySales = new Map<string, { orders: number; units: number; subtotal: number; tax: number; shipping: number; cod: number; fees: number; discounts: number; total: number }>();
    const paymentSales = new Map<string, { orders: Set<string>; subtotal: number; tax: number; shipping: number; cod: number; fees: number; discounts: number; total: number; invoiced: number }>();
    const productSales = new Map<string, { sku: string; product: string; units: number; total: number; lastSale: string }>();
    const customerSales = new Map<
      string,
      {
        customer: string;
        company: string;
        rtn: string;
        email: string;
        phone: string;
        orders: Set<string>;
        invoices: Set<string>;
        total: number;
        lastSale: string;
        type: string;
      }
    >();

    const rangeStart = invoiceNumberValue(fiscalSettings?.invoice_range_start ?? "");
    const rangeEnd = invoiceNumberValue(fiscalSettings?.invoice_range_end ?? "");
    const usedInvoiceValues = new Map<number, AdminReportsData["invoices"][number]>();

    data.invoices.forEach((invoice) => {
      const value = invoiceNumberValue(invoice.invoice_number);
      if (value !== null) {
        usedInvoiceValues.set(value, invoice);
      }
    });

    const missingCorrelatives =
      rangeStart !== null && rangeEnd !== null && rangeStart <= rangeEnd && rangeEnd - rangeStart <= 5000
        ? Array.from({ length: rangeEnd - rangeStart + 1 }, (_, index) => rangeStart + index).filter((value) => !usedInvoiceValues.has(value))
        : [];

    revenueOrders.forEach((order) => {
      const dayKey = normalizeDay(order.created_at);
      const monthKey = normalizeMonth(order.created_at);
      const units = order.order_items.reduce((sum, item) => sum + item.quantity, 0);
      const shipping = order.shipping_fee || order.shipping_total;
      const fees = order.small_order_fee + additionalFeesTotal(order.additional_fees);
      const daily = dailySales.get(dayKey) ?? { orders: 0, units: 0, subtotal: 0, tax: 0, shipping: 0, cod: 0, fees: 0, discounts: 0, total: 0 };
      const monthly = monthlySales.get(monthKey) ?? { orders: 0, units: 0, subtotal: 0, tax: 0, shipping: 0, cod: 0, fees: 0, discounts: 0, total: 0 };
      const payment = paymentSales.get(order.payment_method) ?? { orders: new Set<string>(), subtotal: 0, tax: 0, shipping: 0, cod: 0, fees: 0, discounts: 0, total: 0, invoiced: 0 };
      const invoice = invoiceByOrder.get(order.id);

      dailySales.set(dayKey, {
        orders: daily.orders + 1,
        units: daily.units + units,
        subtotal: daily.subtotal + order.subtotal,
        tax: daily.tax + order.tax,
        shipping: daily.shipping + shipping,
        cod: daily.cod + order.cash_on_delivery_fee,
        fees: daily.fees + fees,
        discounts: daily.discounts + order.discount_total,
        total: daily.total + order.total,
      });
      monthlySales.set(monthKey, {
        orders: monthly.orders + 1,
        units: monthly.units + units,
        subtotal: monthly.subtotal + order.subtotal,
        tax: monthly.tax + order.tax,
        shipping: monthly.shipping + shipping,
        cod: monthly.cod + order.cash_on_delivery_fee,
        fees: monthly.fees + fees,
        discounts: monthly.discounts + order.discount_total,
        total: monthly.total + order.total,
      });
      payment.orders.add(order.id);
      paymentSales.set(order.payment_method, {
        orders: payment.orders,
        subtotal: payment.subtotal + order.subtotal,
        tax: payment.tax + order.tax,
        shipping: payment.shipping + shipping,
        cod: payment.cod + order.cash_on_delivery_fee,
        fees: payment.fees + fees,
        discounts: payment.discounts + order.discount_total,
        total: payment.total + order.total,
        invoiced: payment.invoiced + (invoice ? invoice.total : 0),
      });

      const customerKey = order.customer_id ?? `${order.customer_name}-${order.phone}`;
      const customer = customerSales.get(customerKey) ?? {
        customer: order.customer_name,
        company: order.customer_business_name ?? "-",
        rtn: order.customer_rtn ?? "-",
        email: order.email ?? "-",
        phone: order.phone,
        orders: new Set<string>(),
        invoices: new Set<string>(),
        total: 0,
        lastSale: order.created_at,
        type: priceModeLabels[order.price_mode] ?? order.price_mode,
      };
      customer.orders.add(order.id);
      if (invoice) {
        customer.invoices.add(invoice.id);
      }
      customer.total += order.total;
      customer.lastSale = order.created_at > customer.lastSale ? order.created_at : customer.lastSale;
      if (order.price_mode === "wholesale") {
        customer.type = "Mayorista";
      }
      customerSales.set(customerKey, customer);

      order.order_items.forEach((item) => {
        const productKey = `${item.product_id ?? item.sku}-${item.sku}`;
        const current = productSales.get(productKey) ?? {
          sku: item.sku,
          product: safeProductName(item.product_name, item.sku),
          units: 0,
          total: 0,
          lastSale: order.created_at,
        };
        productSales.set(productKey, {
          ...current,
          units: current.units + item.quantity,
          total: current.total + item.line_total,
          lastSale: order.created_at > current.lastSale ? order.created_at : current.lastSale,
        });
      });
    });

    const soldProductRows = revenueOrders.flatMap((order) => {
      const invoice = invoiceByOrder.get(order.id) ?? null;
      const payment = paymentByOrder.get(order.id);
      return order.order_items.map((item) => ({
        Fecha: formatDate(order.created_at),
        Pedido: order.order_number,
        Factura: invoice?.invoice_number ?? primaryInvoice(order)?.invoice_number ?? "-",
        Cliente: order.customer_name,
        Empresa: order.customer_business_name ?? "-",
        RTN: order.customer_rtn ?? "-",
        Producto: safeProductName(item.product_name, item.sku),
        SKU: item.sku,
        Cantidad: item.quantity,
        "Precio unitario": formatCurrency(item.unit_price),
        Subtotal: formatCurrency(item.line_total),
        "Tipo de precio": priceModeLabels[item.applied_price_mode] ?? priceModeLabels[order.price_mode] ?? order.price_mode,
        "Método de pago": reportPaymentLabel(payment?.payment_method ?? order.payment_method),
        Estado: orderStatusLabels[order.status] ?? order.status,
      }));
    });

    const invoiceDetailRows = data.invoices.map((invoice) => ({
      Factura: invoice.invoice_number,
      Fecha: formatDate(invoice.invoice_date ?? invoice.issued_at ?? invoice.created_at),
      Cliente: invoice.customer_name ?? "-",
      RTN: invoice.customer_rtn ?? invoice.rtn ?? "-",
      Pedido: invoice.order_number ?? "-",
      Subtotal: formatCurrency(invoice.subtotal),
      ISV: formatCurrency(invoice.tax),
      Envío: formatCurrency(invoice.shipping_fee),
      "Contra entrega": formatCurrency(invoice.cash_on_delivery_fee),
      "Recargo mínimo": formatCurrency(invoice.small_order_fee),
      Descuentos: invoice.discount_total > 0 ? `-${formatCurrency(invoice.discount_total)}` : formatCurrency(0),
      "Otros cargos": formatCurrency(additionalFeesTotal(invoice.additional_fees)),
      Total: formatCurrency(invoice.total),
      Estado: invoiceStatusLabels[invoice.status] ?? invoice.status,
    }));

    const invoiceRows = (targetStatus: InvoiceStatus) =>
      data.invoices
        .filter((invoice) => invoice.status === targetStatus)
        .map((invoice) => ({
          Factura: invoice.invoice_number,
          Fecha: formatDate(invoice.invoice_date ?? invoice.issued_at ?? invoice.created_at),
          Cliente: invoice.customer_name ?? "-",
          RTN: invoice.customer_rtn ?? invoice.rtn ?? "-",
          Pedido: invoice.order_number ?? "-",
          "Método de pago": reportPaymentLabel(invoice.payment_method),
          "Referencia bancaria": invoice.bank_reference_number ?? invoice.reference ?? "-",
          Estado: invoiceStatusLabels[invoice.status] ?? invoice.status,
          Subtotal: formatCurrency(invoice.subtotal),
          ISV: formatCurrency(invoice.tax),
          Envío: formatCurrency(invoice.shipping_fee),
          "Contra entrega": formatCurrency(invoice.cash_on_delivery_fee),
          Recargos: formatCurrency(invoice.small_order_fee + additionalFeesTotal(invoice.additional_fees)),
          Descuentos: invoice.discount_total > 0 ? `-${formatCurrency(invoice.discount_total)}` : formatCurrency(0),
          Total: formatCurrency(invoice.total),
        }));

    const wholesaleRows = revenueOrders
      .filter((order) => order.price_mode === "wholesale" || order.order_items.some((item) => item.applied_price_mode === "wholesale"))
      .flatMap((order) =>
        order.order_items.map((item) => ({
          Cliente: order.customer_name,
          Empresa: order.customer_business_name ?? "-",
          RTN: order.customer_rtn ?? "-",
          Pedido: order.order_number,
          Producto: safeProductName(item.product_name, item.sku),
          SKU: item.sku,
          Cantidad: item.quantity,
          "Precio mayorista": formatCurrency(item.wholesale_price_snapshot || item.unit_price),
          Total: formatCurrency(item.line_total),
          Fecha: formatDate(order.created_at),
        })),
      );

    const inventoryRows = data.products.map((product) => ({
      Producto: product.name,
      SKU: product.sku,
      "Stock actual": product.stock,
      Reservado: product.reserved_stock,
      Disponible: product.available_stock,
      "Stock mínimo": product.min_stock,
      Estado: product.available_stock <= 0 ? "Sin stock" : product.available_stock <= product.min_stock ? "Bajo stock" : "Normal",
    }));

    const definitions: ReportDefinition[] = [
      {
        key: "orderFinancialStatus",
        label: "Estado financiero de pedidos",
        description: "Pedidos creados con estado logístico, pago y reserva separados. Solo un pago confirmado cuenta como venta real.",
        columns: ["Pedido", "Fecha", "Cliente", "Estado pedido", "Estado pago", "Reserva", "Requiere revisión", "Método de pago", "Total", "Venta real"],
        rows: data.orders.map((order) => ({
          Pedido: order.order_number,
          Fecha: formatDate(order.created_at),
          Cliente: order.customer_name,
          "Estado pedido": orderStatusLabels[order.status] ?? order.status,
          "Estado pago": paymentStatusLabels[String(order.payment_status ?? "")] ?? order.payment_status ?? "Sin estado",
          Reserva: reservationStatusLabels[order.order_reservation_status] ?? order.order_reservation_status,
          "Requiere revisión": order.reservation_review_required ? "Sí" : "No",
          "Método de pago": reportPaymentLabel(order.payment_method),
          Total: formatCurrency(order.total),
          "Venta real": isRevenueOrder(order) ? "Sí" : "No",
        })),
        financial: true,
      },
      {
        key: "expiredReservations",
        label: "Reservas vencidas",
        description: "Reservas que conservan el stock retenido y requieren una decisión humana.",
        columns: ["Pedido", "Fecha", "Cliente", "Estado pedido", "Estado pago", "Reserva", "Total"],
        rows: data.orders
          .filter((order) => order.reservation_review_required)
          .map((order) => ({
            Pedido: order.order_number,
            Fecha: formatDate(order.created_at),
            Cliente: order.customer_name,
            "Estado pedido": orderStatusLabels[order.status] ?? order.status,
            "Estado pago": paymentStatusLabels[String(order.payment_status ?? "")] ?? order.payment_status ?? "Sin estado",
            Reserva: "Vencida: requiere revisión",
            Total: formatCurrency(order.total),
          })),
        financial: true,
      },
      {
        key: "daily",
        label: "Ventas del día",
        description: "Ventas agrupadas por día dentro del rango seleccionado.",
        columns: ["Fecha", "Pedidos", "Unidades", "Subtotal", "ISV", "Envío", "Contra entrega", "Recargos", "Descuentos", "Total"],
        rows: Array.from(dailySales.entries())
          .sort(([left], [right]) => right.localeCompare(left))
          .map(([date, value]) => ({
            Fecha: formatDate(date),
            Pedidos: value.orders,
            Unidades: value.units,
            Subtotal: formatCurrency(value.subtotal),
            ISV: formatCurrency(value.tax),
            Envío: formatCurrency(value.shipping),
            "Contra entrega": formatCurrency(value.cod),
            Recargos: formatCurrency(value.fees),
            Descuentos: value.discounts > 0 ? `-${formatCurrency(value.discounts)}` : formatCurrency(0),
            Total: formatCurrency(value.total),
          })),
        financial: true,
      },
      {
        key: "range",
        label: "Ventas por rango",
        description: "Resumen de ventas filtrado por fecha inicial, fecha final, cliente, producto y método de pago.",
        columns: ["Concepto", "Valor"],
        rows: [
          { Concepto: "Total vendido", Valor: formatCurrency(totalSold) },
          { Concepto: "Total ISV", Valor: formatCurrency(totalIsv) },
          { Concepto: "Total neto", Valor: formatCurrency(totalNet) },
          { Concepto: "Costo de envío", Valor: formatCurrency(totalShipping) },
          { Concepto: "Cargo contra entrega", Valor: formatCurrency(totalCashOnDelivery) },
          { Concepto: "Recargo pedido mínimo", Valor: formatCurrency(totalSmallOrderFees) },
          { Concepto: "Otros cargos", Valor: formatCurrency(totalOtherFees) },
          { Concepto: "Ingresos por recargos", Valor: formatCurrency(totalSurcharges) },
          { Concepto: "Descuentos", Valor: totalDiscounts > 0 ? `-${formatCurrency(totalDiscounts)}` : formatCurrency(0) },
          { Concepto: "Pedidos", Valor: revenueOrders.length },
          { Concepto: "Unidades vendidas", Valor: totalItems },
        ],
        financial: true,
      },
      {
        key: "monthly",
        label: "Ventas por mes",
        description: "Ventas agrupadas por mes para revisar tendencia contable.",
        columns: ["Mes", "Pedidos", "Unidades", "Subtotal", "ISV", "Envío", "Contra entrega", "Recargos", "Descuentos", "Total"],
        rows: Array.from(monthlySales.entries())
          .sort(([left], [right]) => right.localeCompare(left))
          .map(([month, value]) => ({
            Mes: formatHnMonth(`${month}-01`),
            Pedidos: value.orders,
            Unidades: value.units,
            Subtotal: formatCurrency(value.subtotal),
            ISV: formatCurrency(value.tax),
            Envío: formatCurrency(value.shipping),
            "Contra entrega": formatCurrency(value.cod),
            Recargos: formatCurrency(value.fees),
            Descuentos: value.discounts > 0 ? `-${formatCurrency(value.discounts)}` : formatCurrency(0),
            Total: formatCurrency(value.total),
          })),
        financial: true,
      },
      {
        key: "issuedInvoices",
        label: "Facturas emitidas",
        description: "Facturas fiscales emitidas dentro de los filtros seleccionados.",
        columns: ["Factura", "Fecha", "Cliente", "RTN", "Pedido", "Método de pago", "Referencia bancaria", "Estado", "Subtotal", "ISV", "Envío", "Contra entrega", "Recargos", "Descuentos", "Total"],
        rows: invoiceRows("emitida"),
        financial: true,
      },
      {
        key: "cancelledInvoices",
        label: "Facturas anuladas",
        description: "Facturas anuladas dentro de los filtros seleccionados.",
        columns: ["Factura", "Fecha", "Cliente", "RTN", "Pedido", "Método de pago", "Referencia bancaria", "Estado", "Subtotal", "ISV", "Envío", "Contra entrega", "Recargos", "Descuentos", "Total"],
        rows: invoiceRows("anulada"),
        financial: true,
      },
      {
        key: "fiscalCorrelatives",
        label: "Correlativos usados",
        description: "Números fiscales utilizados, con estado, CAI, ISV y total para revisión fiscal.",
        columns: ["Correlativo", "Factura", "Fecha", "CAI", "Estado", "ISV", "Total"],
        rows: data.invoices
          .map((invoice) => ({
            Correlativo: invoiceNumberValue(invoice.invoice_number) ?? "-",
            Factura: invoice.invoice_number,
            Fecha: formatDate(invoice.invoice_date ?? invoice.issued_at ?? invoice.created_at),
            CAI: invoice.cai ?? fiscalSettings?.cai ?? "-",
            Estado: invoiceStatusLabels[invoice.status] ?? invoice.status,
            ISV: formatCurrency(invoice.tax),
            Total: formatCurrency(invoice.total),
          }))
          .sort((left, right) => String(left.Correlativo).localeCompare(String(right.Correlativo), "es-HN", { numeric: true })),
        financial: true,
      },
      {
        key: "missingCorrelatives",
        label: "Correlativos faltantes",
        description:
          rangeStart !== null && rangeEnd !== null && rangeEnd - rangeStart > 5000
            ? "El rango autorizado es demasiado amplio para listar faltantes en pantalla. Filtra por períodos más pequeños."
            : "Números dentro del rango autorizado que todavía no tienen factura emitida o anulada en el sistema.",
        columns: ["Correlativo faltante", "Rango autorizado", "CAI"],
        rows: missingCorrelatives.map((value) => ({
          "Correlativo faltante": value,
          "Rango autorizado": `${fiscalSettings?.invoice_range_start || "-"} a ${fiscalSettings?.invoice_range_end || "-"}`,
          CAI: fiscalSettings?.cai || "-",
        })),
        financial: true,
      },
      {
        key: "paymentMethods",
        label: "Ventas por método de pago",
        description: "Totales de venta agrupados por método de pago.",
        columns: ["Método de pago", "Pedidos", "Subtotal", "ISV", "Envío", "Contra entrega", "Recargos", "Descuentos", "Total"],
        rows: Array.from(paymentSales.entries()).map(([method, value]) => ({
          "Método de pago": reportPaymentLabel(method),
          Pedidos: value.orders.size,
          Subtotal: formatCurrency(value.subtotal),
          ISV: formatCurrency(value.tax),
          Envío: formatCurrency(value.shipping),
          "Contra entrega": formatCurrency(value.cod),
          Recargos: formatCurrency(value.fees),
          Descuentos: value.discounts > 0 ? `-${formatCurrency(value.discounts)}` : formatCurrency(0),
          Total: formatCurrency(value.total),
        })),
        financial: true,
      },
      {
        key: "bankTransfers",
        label: "Transferencias bancarias",
        description: "Transferencias con número de referencia para conciliación contable.",
        columns: ["Pedido", "Fecha", "Cliente", "Factura", "Referencia bancaria", "Monto"],
        rows: revenueOrders
          .filter((order) => order.payment_method === "bank_transfer")
          .map((order) => {
            const payment = paymentByOrder.get(order.id);
            const invoice = invoiceByOrder.get(order.id);
            return {
              Pedido: order.order_number,
              Fecha: formatDate(order.created_at),
              Cliente: order.customer_name,
              Factura: invoice?.invoice_number ?? "-",
              "Referencia bancaria": payment?.bank_reference_number ?? payment?.reference ?? "-",
              Monto: formatCurrency(order.total),
            };
          }),
        financial: true,
      },
      {
        key: "soldProductsDetail",
        label: "Detalle de productos vendidos",
        description: "Línea por línea de productos vendidos con cliente, factura, pedido, precio y método de pago.",
        columns: [
          "Fecha",
          "Pedido",
          "Factura",
          "Cliente",
          "Empresa",
          "RTN",
          "Producto",
          "SKU",
          "Cantidad",
          "Precio unitario",
          "Subtotal",
          "Tipo de precio",
          "Método de pago",
          "Estado",
        ],
        rows: soldProductRows,
        financial: true,
      },
      {
        key: "customerSales",
        label: "Ventas por cliente",
        description: "Consolidado por cliente con facturas, pedidos, total comprado y tipo de cliente.",
        columns: ["Cliente", "Empresa", "RTN", "Correo electrónico", "Teléfono", "Pedidos realizados", "Facturas emitidas", "Total comprado", "Última compra", "Tipo cliente"],
        rows: Array.from(customerSales.values())
          .sort((left, right) => right.total - left.total)
          .map((customer) => ({
            Cliente: customer.customer,
            Empresa: customer.company,
            RTN: customer.rtn,
            "Correo electrónico": customer.email,
            Teléfono: customer.phone,
            "Pedidos realizados": customer.orders.size,
            "Facturas emitidas": customer.invoices.size,
            "Total comprado": formatCurrency(customer.total),
            "Ultima compra": formatDate(customer.lastSale),
            "Tipo cliente": customer.type,
          })),
        financial: true,
      },
      {
        key: "invoiceDetails",
        label: "Detalle de facturas",
        description: "Detalle fiscal de facturas emitidas y anuladas.",
        columns: ["Factura", "Fecha", "Cliente", "RTN", "Pedido", "Subtotal", "ISV", "Envío", "Contra entrega", "Recargo mínimo", "Descuentos", "Otros cargos", "Total", "Estado"],
        rows: invoiceDetailRows,
        financial: true,
      },
      {
        key: "wholesaleSales",
        label: "Ventas mayoristas",
        description: "Detalle de ventas con precio mayorista histórico por producto.",
        columns: ["Cliente", "Empresa", "RTN", "Pedido", "Producto", "SKU", "Cantidad", "Precio mayorista", "Total", "Fecha"],
        rows: wholesaleRows,
        financial: true,
      },
      {
        key: "productRanking",
        label: "Ranking de productos",
        description: "Productos ordenados por mayor cantidad vendida.",
        columns: ["Producto", "SKU", "Unidades vendidas", "Ingresos generados", "Ultima venta"],
        rows: Array.from(productSales.values())
          .sort((left, right) => right.units - left.units)
          .map((item) => ({
            Producto: item.product,
            SKU: item.sku,
            "Unidades vendidas": item.units,
            "Ingresos generados": formatCurrency(item.total),
            "Ultima venta": formatDate(item.lastSale),
          })),
        financial: true,
      },
      {
        key: "inventoryStatus",
        label: "Estado del inventario",
        description: "Stock actual, reservado y disponible con estado operativo.",
        columns: ["Producto", "SKU", "Stock actual", "Reservado", "Disponible", "Stock mínimo", "Estado"],
        rows: inventoryRows,
      },
      {
        key: "paymentMethodDetails",
        label: "Detalle por método de pago",
        description: "Pedidos, total vendido y total facturado por método: efectivo, transferencia, tarjeta mediante enlace, crédito comercial y otros.",
        columns: ["Método", "Pedidos", "Envío", "Contra entrega", "Recargos", "Descuentos", "Total vendido", "Total facturado"],
        rows: Array.from(paymentSales.entries()).map(([method, value]) => ({
          Método: reportPaymentLabel(method),
          Pedidos: value.orders.size,
          Envío: formatCurrency(value.shipping),
          "Contra entrega": formatCurrency(value.cod),
          Recargos: formatCurrency(value.fees),
          Descuentos: value.discounts > 0 ? `-${formatCurrency(value.discounts)}` : formatCurrency(0),
          "Total vendido": formatCurrency(value.total),
          "Total facturado": formatCurrency(value.invoiced),
        })),
        financial: true,
      },
      {
        key: "creditReceivablePayments",
        label: "Cobranza de crédito comercial",
        description: "Abonos registrados por pedido a crédito; separado de facturación fiscal.",
        columns: ["Cliente", "Pedido", "Total original", "Total abonado", "Saldo pendiente", "Estado", "Fecha de vencimiento", "Método de abono", "Referencia", "Fecha de abono", "Monto de abono"],
        rows: data.receivablePayments
          .filter((payment) => !payment.voided_at)
          .map((payment) =>
            buildReceivablePaymentReportRow(payment, {
              currency: formatCurrency,
              date: formatDate,
              paymentMethod: reportPaymentLabel,
              status: (status) => receivableStatusLabels[status] ?? "Abierto",
            }),
          ),
        financial: true,
      },
      {
        key: "topProducts",
        label: "Productos más vendidos",
        description: "Ranking operativo por cantidad vendida e ingresos generados.",
        columns: ["Producto", "SKU", "Cantidad vendida", "Total vendido"],
        rows: Array.from(productSales.values())
          .sort((left, right) => right.units - left.units)
          .slice(0, 100)
          .map((item) => ({
            Producto: item.product,
            SKU: item.sku,
            "Cantidad vendida": item.units,
            "Total vendido": formatCurrency(item.total),
          })),
        financial: true,
      },
      {
        key: "inventory",
        label: "Inventario actual",
        description: "Existencias actuales y valor de inventario por costo.",
        columns: ["Producto", "SKU", "Código interno", "Marca", "Stock", "Reservado", "Disponible", "Stock mínimo", "Costo", "Valor inventario"],
        rows: data.products.map((product) => ({
          Producto: product.name,
          SKU: product.sku,
          "Código interno": product.internal_code ?? "-",
          Marca: product.brand,
          Stock: product.stock,
          Reservado: product.reserved_stock,
          Disponible: product.available_stock,
          "Stock mínimo": product.min_stock,
          Costo: formatCurrency(product.cost_price),
          "Valor inventario": formatCurrency(product.cost_price * product.stock),
        })),
      },
      {
        key: "lowStock",
        label: "Productos con bajo stock",
        description: "Productos que llegaron al stock mínimo o están por debajo.",
        columns: ["Producto", "SKU", "Código interno", "Marca", "Stock", "Reservado", "Disponible", "Stock mínimo", "Estado"],
        rows: data.products
          .filter((product) => product.available_stock <= product.min_stock)
          .sort((left, right) => left.available_stock - right.available_stock)
          .map((product) => ({
            Producto: product.name,
            SKU: product.sku,
            "Código interno": product.internal_code ?? "-",
            Marca: product.brand,
            Stock: product.stock,
            Reservado: product.reserved_stock,
            Disponible: product.available_stock,
            "Stock mínimo": product.min_stock,
            Estado: product.available_stock <= 0 ? "Sin stock" : "Bajo stock",
          })),
      },
    ];

    if (accessMode === "fiscal") {
      return definitions.filter((report) =>
        ["issuedInvoices", "cancelledInvoices", "fiscalCorrelatives", "missingCorrelatives", "invoiceDetails"].includes(report.key),
      );
    }

    return accessMode === "full" ? definitions : definitions.filter((report) => !report.financial || ["topProducts", "inventoryStatus", "inventory", "lowStock"].includes(report.key));
  }, [
    accessMode,
    data.invoices,
    data.orders,
    data.products,
    data.receivablePayments,
    fiscalSettings,
    invoiceByOrder,
    paymentByOrder,
    revenueOrders,
    totalCashOnDelivery,
    totalDiscounts,
    totalIsv,
    totalItems,
    totalNet,
    totalOtherFees,
    totalShipping,
    totalSmallOrderFees,
    totalSold,
    totalSurcharges,
  ]);

  const currentReport = reportDefinitions.find((report) => report.key === activeReport) ?? reportDefinitions[0];
  const visibleReportRows = useMemo(
    () => currentReport.rows.filter((row) => reportRowMatchesSearch(row, reportSearch)),
    [currentReport.rows, reportSearch],
  );

  function exportCsv() {
    if (!canExport || !canUseTechnicalExports) {
      return;
    }

    downloadBlob(
      buildCsv(currentReport.columns, visibleReportRows),
      `car-zone-${currentReport.key}.csv`,
      "text/csv;charset=utf-8",
    );
  }

  function exportExcel() {
    if (!canExport) {
      return;
    }

    downloadBlob(
      buildExcelTable(currentReport.label, currentReport.columns, visibleReportRows),
      `car-zone-${currentReport.key}.xls`,
      "application/vnd.ms-excel;charset=utf-8",
    );
  }

  async function exportPdf() {
    if (!canExport) {
      return;
    }

    setExportingPdf(true);
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
      ]);
      const doc = new jsPDF({ orientation: currentReport.columns.length > 5 ? "landscape" : "portrait" });
      doc.setFontSize(16);
      doc.text(`Car Zone Accesorios - ${currentReport.label}`, 14, 16);
      doc.setFontSize(9);
      doc.text(`Rango: ${data.filters.startDate || "inicio"} a ${data.filters.endDate || "hoy"}`, 14, 23);
      autoTable(doc, {
        startY: 30,
        head: [currentReport.columns],
        body: visibleReportRows.map((row) => currentReport.columns.map((column) => String(row[column] ?? ""))),
        styles: { fontSize: currentReport.columns.length > 8 ? 6 : 8, cellWidth: "wrap" },
        headStyles: { fillColor: [36, 106, 115] },
      });
      doc.save(`car-zone-${currentReport.key}.pdf`);
    } finally {
      setExportingPdf(false);
    }
  }

  return (
    <div className="space-y-5">
      <PaginationControls
        basePath="/admin/reportes"
        page={data.page}
        pageSize={data.pageSize}
        total={data.totalRecords}
        label="registros filtrados"
        params={reportParams(data.filters)}
      />

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        {accessMode === "fiscal" ? (
          <>
            <Metric label="Total facturado" value={formatCurrency(fiscalInvoiceTotal)} />
            <Metric label="ISV facturado" value={formatCurrency(fiscalTaxTotal)} />
            <Metric label="Facturas emitidas" value={issuedInvoiceCount.toLocaleString("es-HN")} />
            <Metric label="Facturas anuladas" value={cancelledInvoiceCount.toLocaleString("es-HN")} />
          </>
        ) : (
          <>
            <Metric label="Total vendido" value={formatCurrency(totalSold)} />
            <Metric label="Total ISV" value={formatCurrency(totalIsv)} />
            <Metric label="Unidades vendidas" value={totalItems.toLocaleString("es-HN")} />
            <Metric label="Pagos pendientes" value={pendingPaymentCount.toLocaleString("es-HN")} />
            <Metric label="Reservas vencidas" value={expiredReservationCount.toLocaleString("es-HN")} />
            <Metric label="Bajo stock" value={lowStockCount.toLocaleString("es-HN")} />
          </>
        )}
      </div>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="mb-4 flex items-center gap-2">
          <Filter size={18} />
          <h2 className="font-semibold">Filtros globales</h2>
        </div>
        <form className="grid gap-3 lg:grid-cols-4">
          <Field label="Fecha inicial">
            <Input name="startDate" type="date" defaultValue={data.filters.startDate} />
          </Field>
          <Field label="Fecha final">
            <Input name="endDate" type="date" defaultValue={data.filters.endDate} />
          </Field>
          <Field label="Cliente">
            <Input name="customer" defaultValue={data.filters.customer} placeholder="Nombre, correo, RTN o teléfono" />
          </Field>
          {accessMode !== "fiscal" ? (
            <>
              <Field label="Producto">
                <Input name="product" defaultValue={data.filters.product} placeholder="Nombre completo del producto" />
              </Field>
              <Field label="SKU">
                <Input name="sku" defaultValue={data.filters.sku} placeholder="ACCU088053" />
              </Field>
            </>
          ) : null}
          {accessMode === "full" || accessMode === "fiscal" ? (
            <Field label="Factura">
              <Input name="invoice" defaultValue={data.filters.invoice} placeholder="000-001-01-00000001" />
            </Field>
          ) : null}
          {accessMode !== "fiscal" ? (
            <SelectField label="Método de pago" name="paymentMethod" defaultValue={data.filters.paymentMethod}>
              <option value="all">Todos</option>
              <option value="cash">Efectivo</option>
              <option value="bank_transfer">Transferencia</option>
              <option value="card">Tarjeta mediante enlace</option>
              <option value="commercial_credit">Crédito comercial</option>
            </SelectField>
          ) : null}
          <SelectField label="Tipo cliente" name="priceMode" defaultValue={data.filters.priceMode}>
            <option value="all">Todos</option>
            <option value="retail">Detalle</option>
            <option value="wholesale">Mayorista</option>
          </SelectField>
          {accessMode === "full" || accessMode === "fiscal" ? (
            <SelectField label="Estado factura" name="invoiceStatus" defaultValue={data.filters.invoiceStatus}>
              <option value="all">Todos</option>
              <option value="emitida">Emitida</option>
              <option value="anulada">Anulada</option>
              <option value="pendiente">Pendiente</option>
              <option value="draft">Borrador</option>
            </SelectField>
          ) : null}
          {accessMode !== "fiscal" ? (
            <SelectField label="Estado pedido" name="orderStatus" defaultValue={data.filters.orderStatus}>
              <option value="all">Todos</option>
              {Object.entries(orderStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </SelectField>
          ) : null}
          <div className="grid gap-2 sm:flex sm:items-end">
            <Button type="submit" variant="dark" className="w-full sm:w-auto">
              <Search size={16} />
              Filtrar
            </Button>
            <a href="/admin/reportes" className="inline-flex w-full items-center justify-center rounded-md border border-black/10 bg-white px-4 py-2 text-sm font-semibold text-[#080808] sm:w-auto">
              Limpiar
            </a>
          </div>
        </form>
      </section>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
          <div>
            <p className="text-sm font-semibold">Exportaciones</p>
            <p className="mt-1 text-sm text-black/55">
              Excel y PDF exportan las columnas visibles del reporte activo con encabezados claros, fechas legibles y moneda en lempiras.
              La exportación CSV técnica solo está disponible para el Technical Owner.
            </p>
          </div>
          <div className="grid gap-2 sm:flex sm:flex-wrap">
            <Button variant="ghost" onClick={exportExcel} disabled={!canExport} className="w-full sm:w-auto">
              <FileSpreadsheet size={16} />
              Excel
            </Button>
            <Button variant="dark" onClick={() => void exportPdf()} disabled={!canExport || exportingPdf} className="w-full sm:w-auto">
              <Printer size={16} />
              {exportingPdf ? "Generando..." : "PDF"}
            </Button>
            {canUseTechnicalExports ? (
              <Button variant="ghost" onClick={exportCsv} disabled={!canExport} title="Exportación técnica disponible solo para el Technical Owner">
                <Download size={16} />
                CSV técnico
              </Button>
            ) : null}
          </div>
        </div>
        {!canExport ? <p className="mt-3 text-sm text-[#7c2d12]">Tu rol puede revisar reportes operativos, pero no exportar reportes financieros.</p> : null}
      </section>

      <label className="block md:hidden">
        <span className="mb-1 block text-xs font-medium uppercase text-black/50">Reporte</span>
        <select
          value={currentReport.key}
          onChange={(event) => setActiveReport(event.target.value as ReportKey)}
          className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
        >
          {reportDefinitions.map((report) => (
            <option key={report.key} value={report.key}>
              {report.label}
            </option>
          ))}
        </select>
      </label>

      <div className="hidden gap-2 overflow-x-auto pb-1 md:flex">
        {reportDefinitions.map((report) => (
          <button
            key={report.key}
            type="button"
            onClick={() => setActiveReport(report.key)}
            className={`shrink-0 rounded-md border px-3 py-2 text-sm font-medium ${
              currentReport.key === report.key
                ? "border-[#e4252c] bg-[#e4252c] text-white"
                : "border-black/10 bg-white text-[#080808]"
            }`}
          >
            {report.label}
          </button>
        ))}
      </div>

      <label className="block rounded-lg border border-black/10 bg-white p-4">
        <span className="mb-1 block text-xs font-medium uppercase text-black/50">Buscar en el reporte activo</span>
        <Input
          type="search"
          value={reportSearch}
          onChange={(event) => setReportSearch(event.target.value)}
          placeholder="Cliente, pedido, Cuenta histórica, referencia, fecha, monto o método"
        />
      </label>

      <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
        <div className="flex flex-col justify-between gap-3 border-b border-black/10 p-5 sm:flex-row sm:items-center">
          <div>
            <div className="flex items-center gap-2">
              <FileText size={18} />
              <h2 className="font-semibold">{currentReport.label}</h2>
            </div>
            <p className="mt-1 text-sm text-black/55">{currentReport.description}</p>
          </div>
          <p className="text-sm font-medium text-black/50">{visibleReportRows.length.toLocaleString("es-HN")} filas</p>
        </div>
        <div className="grid gap-3 p-3 md:hidden">
          {visibleReportRows.length === 0 ? (
            <p className="rounded-md bg-[#f4f4f5] p-4 text-center text-sm text-black/50">No hay datos para este reporte.</p>
          ) : (
            visibleReportRows.map((row, index) => {
              const [titleColumn, ...detailColumns] = currentReport.columns;
              const visibleDetails = detailColumns.slice(0, 8);

              return (
                <article key={`${currentReport.key}-mobile-${index}`} className="rounded-md border border-black/10 bg-white p-4 shadow-sm">
                  <h3 className="break-words font-semibold [overflow-wrap:anywhere]">{row[titleColumn] ?? "-"}</h3>
                  <dl className="mt-3 grid gap-2 text-sm">
                    {visibleDetails.map((column) => (
                      <div key={column} className="grid grid-cols-[minmax(0,0.45fr)_minmax(0,0.55fr)] gap-2 rounded-md bg-[#f8fafc] p-2">
                        <dt className="text-xs uppercase text-black/45">{column}</dt>
                        <dd className="break-words font-medium [overflow-wrap:anywhere]">{row[column] ?? "-"}</dd>
                      </div>
                    ))}
                  </dl>
                  {detailColumns.length > visibleDetails.length ? (
                    <p className="mt-3 text-xs text-black/45">{detailColumns.length - visibleDetails.length} columnas adicionales disponibles en escritorio.</p>
                  ) : null}
                </article>
              );
            })
          )}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                {currentReport.columns.map((column) => (
                  <th key={column} className="px-4 py-3">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {visibleReportRows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-center text-black/50" colSpan={currentReport.columns.length}>
                    No hay datos para este reporte.
                  </td>
                </tr>
              ) : (
                visibleReportRows.map((row, index) => (
                  <tr key={`${currentReport.key}-${index}`}>
                    {currentReport.columns.map((column) => (
                      <td key={column} className="whitespace-pre-line px-4 py-3 align-top">
                        {row[column] ?? "-"}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase text-black/50">{label}</span>
      {children}
    </label>
  );
}

function SelectField({
  label,
  name,
  defaultValue,
  children,
}: {
  label: string;
  name: string;
  defaultValue: string;
  children: React.ReactNode;
}) {
  return (
    <Field label={label}>
      <select name={name} defaultValue={defaultValue} className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none">
        {children}
      </select>
    </Field>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}
