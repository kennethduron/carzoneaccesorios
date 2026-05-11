"use client";

import { useMemo, useState } from "react";
import { Download, FileSpreadsheet, FileText, Filter, Printer } from "lucide-react";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { Button, Input } from "@/components/ui";
import type { FiscalSettings } from "@/types/fiscal";
import type { AdminReportsData, ReportOrder, ReportPaymentMethod } from "@/types/reports";
import type { InvoiceStatus } from "@/types/invoices";
import { invoiceNumberValue } from "@/utils/fiscal";
import { formatHnDate, formatHnMonth } from "@/utils/format";
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
  | "bankTransfers"
  | "topProducts"
  | "inventory"
  | "lowStock";

type ReportRow = Record<string, string | number>;

type ReportDefinition = {
  key: ReportKey;
  label: string;
  description: string;
  columns: string[];
  rows: ReportRow[];
};

type ReportsDashboardProps = {
  data: AdminReportsData;
  fiscalSettings: FiscalSettings;
};

const paymentLabels: Record<string, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta",
  cash: "Efectivo",
};

const invoiceStatusLabels: Record<string, string> = {
  emitida: "Emitida",
  anulada: "Anulada",
  pendiente: "Pendiente",
  draft: "Pendiente",
};

function formatDate(value: string) {
  return formatHnDate(value);
}

function formatMonth(value: string) {
  return formatHnMonth(value);
}

function normalizeDay(value: string) {
  return value.slice(0, 10);
}

function normalizeMonth(value: string) {
  return value.slice(0, 7);
}

function isRevenueOrder(order: ReportOrder) {
  return !["cancelado", "cancelled"].includes(order.status);
}

function isInsideRange(value: string, startDate: string, endDate: string) {
  const day = normalizeDay(value);
  return (!startDate || day >= startDate) && (!endDate || day <= endDate);
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

function buildExcelTable(title: string, columns: string[], rows: ReportRow[]) {
  const header = columns.map((column) => `<th>${column}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${columns.map((column) => `<td>${row[column] ?? ""}</td>`).join("")}</tr>`)
    .join("");

  return `
    <html>
      <head><meta charset="utf-8" /></head>
      <body>
        <h1>${title}</h1>
        <table border="1">
          <thead><tr>${header}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </body>
    </html>
  `;
}

export function ReportsDashboard({ data, fiscalSettings }: ReportsDashboardProps) {
  const [activeReport, setActiveReport] = useState<ReportKey>("daily");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<ReportPaymentMethod | "all">("all");
  const [invoiceStatus, setInvoiceStatus] = useState<InvoiceStatus | "all">("all");
  const [exportingPdf, setExportingPdf] = useState(false);

  const paymentByOrder = useMemo(() => {
    const map = new Map<string, AdminReportsData["payments"][number]>();
    data.payments.forEach((payment) => {
      if (!map.has(payment.order_id)) {
        map.set(payment.order_id, payment);
      }
    });
    return map;
  }, [data.payments]);

  const filteredOrders = useMemo(
    () =>
      data.orders.filter((order) => {
        const matchesDate = isInsideRange(order.created_at, startDate, endDate);
        const matchesPayment = paymentMethod === "all" || order.payment_method === paymentMethod;
        return matchesDate && matchesPayment;
      }),
    [data.orders, endDate, paymentMethod, startDate],
  );

  const filteredInvoices = useMemo(
    () =>
      data.invoices.filter((invoice) => {
        const matchesDate = isInsideRange(invoice.issued_at ?? invoice.created_at, startDate, endDate);
        const matchesStatus = invoiceStatus === "all" || invoice.status === invoiceStatus;
        const order = data.orders.find((item) => item.id === invoice.order_id);
        const matchesPayment = paymentMethod === "all" || invoice.payment_method === paymentMethod || order?.payment_method === paymentMethod;
        return matchesDate && matchesStatus && matchesPayment;
      }),
    [data.invoices, data.orders, endDate, invoiceStatus, paymentMethod, startDate],
  );

  const revenueOrders = useMemo(() => filteredOrders.filter(isRevenueOrder), [filteredOrders]);
  const totalSold = revenueOrders.reduce((sum, order) => sum + order.total, 0);
  const totalIsv = revenueOrders.reduce((sum, order) => sum + order.tax, 0);
  const totalNet = revenueOrders.reduce((sum, order) => sum + order.subtotal, 0);
  const totalItems = revenueOrders.reduce(
    (sum, order) => sum + order.order_items.reduce((itemSum, item) => itemSum + item.quantity, 0),
    0,
  );
  const lowStockCount = data.products.filter((product) => product.stock <= product.min_stock).length;

  const reportDefinitions = useMemo<ReportDefinition[]>(() => {
    const dailySales = new Map<string, { orders: number; units: number; subtotal: number; tax: number; total: number }>();
    const monthlySales = new Map<string, { orders: number; units: number; subtotal: number; tax: number; total: number }>();
    const paymentSales = new Map<string, { orders: number; subtotal: number; tax: number; total: number }>();
    const productSales = new Map<string, { sku: string; internalCode: string; product: string; units: number; total: number; stock: number }>();

    const productById = new Map(data.products.map((product) => [product.id, product]));
    const rangeStart = invoiceNumberValue(fiscalSettings.invoice_range_start);
    const rangeEnd = invoiceNumberValue(fiscalSettings.invoice_range_end);
    const usedInvoiceValues = new Map<number, AdminReportsData["invoices"][number]>();

    filteredInvoices.forEach((invoice) => {
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
      const daily = dailySales.get(dayKey) ?? { orders: 0, units: 0, subtotal: 0, tax: 0, total: 0 };
      const monthly = monthlySales.get(monthKey) ?? { orders: 0, units: 0, subtotal: 0, tax: 0, total: 0 };
      const payment = paymentSales.get(order.payment_method) ?? { orders: 0, subtotal: 0, tax: 0, total: 0 };

      dailySales.set(dayKey, {
        orders: daily.orders + 1,
        units: daily.units + units,
        subtotal: daily.subtotal + order.subtotal,
        tax: daily.tax + order.tax,
        total: daily.total + order.total,
      });
      monthlySales.set(monthKey, {
        orders: monthly.orders + 1,
        units: monthly.units + units,
        subtotal: monthly.subtotal + order.subtotal,
        tax: monthly.tax + order.tax,
        total: monthly.total + order.total,
      });
      paymentSales.set(order.payment_method, {
        orders: payment.orders + 1,
        subtotal: payment.subtotal + order.subtotal,
        tax: payment.tax + order.tax,
        total: payment.total + order.total,
      });

      order.order_items.forEach((item) => {
        const product = item.product_id ? productById.get(item.product_id) : undefined;
        const productKey = item.product_id ?? item.sku;
        const current = productSales.get(productKey) ?? {
          sku: item.sku,
          internalCode: product?.internal_code ?? "-",
          product: item.product_name,
          units: 0,
          total: 0,
          stock: product?.stock ?? 0,
        };
        productSales.set(productKey, {
          ...current,
          units: current.units + item.quantity,
          total: current.total + item.line_total,
          stock: product?.stock ?? current.stock,
        });
      });
    });

    const invoiceRows = (targetStatus: InvoiceStatus) =>
      filteredInvoices
        .filter((invoice) => invoice.status === targetStatus)
        .map((invoice) => {
          const order = data.orders.find((item) => item.id === invoice.order_id);
          const payment = paymentByOrder.get(invoice.order_id);
          const paymentMethod = invoice.payment_method ?? order?.payment_method ?? null;
          const bankReference =
            invoice.bank_reference_number ?? invoice.reference ?? payment?.bank_reference_number ?? payment?.reference ?? null;
          return {
            Factura: invoice.invoice_number,
            Fecha: formatDate(invoice.issued_at ?? invoice.created_at),
            Cliente: invoice.customer_name ?? order?.customer_name ?? "-",
            RTN: invoice.customer_rtn ?? invoice.rtn ?? "-",
            "Método de pago": paymentMethod ? paymentLabels[paymentMethod] ?? paymentMethod : "-",
            "Referencia bancaria": bankReference ?? "-",
            Estado: invoiceStatusLabels[invoice.status] ?? invoice.status,
            Total: formatCurrency(invoice.total),
          };
        });

    return [
      {
        key: "daily",
        label: "Ventas del día",
        description: "Ventas agrupadas por día dentro del rango seleccionado.",
        columns: ["Fecha", "Pedidos", "Unidades", "Subtotal", "ISV", "Total"],
        rows: Array.from(dailySales.entries())
          .sort(([left], [right]) => right.localeCompare(left))
          .map(([date, value]) => ({
            Fecha: formatDate(date),
            Pedidos: value.orders,
            Unidades: value.units,
            Subtotal: formatCurrency(value.subtotal),
            ISV: formatCurrency(value.tax),
            Total: formatCurrency(value.total),
          })),
      },
      {
        key: "range",
        label: "Ventas por rango",
        description: "Resumen de ventas filtrado por fecha inicial, fecha final y método de pago.",
        columns: ["Concepto", "Valor"],
        rows: [
          { Concepto: "Total vendido", Valor: formatCurrency(totalSold) },
          { Concepto: "Total ISV", Valor: formatCurrency(totalIsv) },
          { Concepto: "Total neto", Valor: formatCurrency(totalNet) },
          { Concepto: "Pedidos", Valor: revenueOrders.length },
          { Concepto: "Unidades vendidas", Valor: totalItems },
        ],
      },
      {
        key: "monthly",
        label: "Ventas por mes",
        description: "Ventas agrupadas por mes para revisar tendencia contable.",
        columns: ["Mes", "Pedidos", "Unidades", "Subtotal", "ISV", "Total"],
        rows: Array.from(monthlySales.entries())
          .sort(([left], [right]) => right.localeCompare(left))
          .map(([month, value]) => ({
            Mes: formatMonth(`${month}-01`),
            Pedidos: value.orders,
            Unidades: value.units,
            Subtotal: formatCurrency(value.subtotal),
            ISV: formatCurrency(value.tax),
            Total: formatCurrency(value.total),
          })),
      },
      {
        key: "issuedInvoices",
        label: "Facturas emitidas",
        description: "Facturas fiscales emitidas dentro del rango seleccionado.",
        columns: ["Factura", "Fecha", "Cliente", "RTN", "Método de pago", "Referencia bancaria", "Estado", "Total"],
        rows: invoiceRows("emitida"),
      },
      {
        key: "cancelledInvoices",
        label: "Facturas anuladas",
        description: "Facturas anuladas dentro del rango seleccionado.",
        columns: ["Factura", "Fecha", "Cliente", "RTN", "Método de pago", "Referencia bancaria", "Estado", "Total"],
        rows: invoiceRows("anulada"),
      },
      {
        key: "fiscalCorrelatives",
        label: "Correlativos usados",
        description: "Numeros fiscales utilizados, con estado, CAI, ISV y total para revision fiscal.",
        columns: ["Correlativo", "Factura", "Fecha", "CAI", "Estado", "ISV", "Total"],
        rows: filteredInvoices
          .map((invoice) => ({
            Correlativo: invoiceNumberValue(invoice.invoice_number) ?? "-",
            Factura: invoice.invoice_number,
            Fecha: formatDate(invoice.issued_at ?? invoice.created_at),
            CAI: invoice.cai ?? fiscalSettings.cai ?? "-",
            Estado: invoiceStatusLabels[invoice.status] ?? invoice.status,
            ISV: formatCurrency(invoice.tax),
            Total: formatCurrency(invoice.total),
          }))
          .sort((left, right) => String(left.Correlativo).localeCompare(String(right.Correlativo), "es-HN", { numeric: true })),
      },
      {
        key: "missingCorrelatives",
        label: "Correlativos faltantes",
        description:
          rangeStart !== null && rangeEnd !== null && rangeEnd - rangeStart > 5000
            ? "El rango autorizado es demasiado amplio para listar faltantes en pantalla. Exporta por periodos mas pequenos."
            : "Numeros dentro del rango autorizado que todavia no tienen factura emitida o anulada en el sistema.",
        columns: ["Correlativo faltante", "Rango autorizado", "CAI"],
        rows: missingCorrelatives.map((value) => ({
          "Correlativo faltante": value,
          "Rango autorizado": `${fiscalSettings.invoice_range_start || "-"} a ${fiscalSettings.invoice_range_end || "-"}`,
          CAI: fiscalSettings.cai || "-",
        })),
      },
      {
        key: "paymentMethods",
        label: "Ventas por método de pago",
        description: "Totales de venta agrupados por método de pago.",
        columns: ["Método de pago", "Pedidos", "Subtotal", "ISV", "Total"],
        rows: Array.from(paymentSales.entries()).map(([method, value]) => ({
          "Método de pago": paymentLabels[method] ?? method,
          Pedidos: value.orders,
          Subtotal: formatCurrency(value.subtotal),
          ISV: formatCurrency(value.tax),
          Total: formatCurrency(value.total),
        })),
      },
      {
        key: "bankTransfers",
        label: "Transferencias bancarias",
        description: "Transferencias con número de referencia para conciliación contable.",
        columns: ["Pedido", "Fecha", "Cliente", "Referencia bancaria", "Monto"],
        rows: revenueOrders
          .filter((order) => order.payment_method === "bank_transfer")
          .map((order) => {
            const payment = paymentByOrder.get(order.id);
            return {
              Pedido: order.order_number,
              Fecha: formatDate(order.created_at),
              Cliente: order.customer_name,
              "Referencia bancaria": payment?.bank_reference_number ?? payment?.reference ?? "-",
              Monto: formatCurrency(order.total),
            };
          }),
      },
      {
        key: "topProducts",
        label: "Productos más vendidos",
        description: "Ranking por cantidad vendida, total vendido y stock actual.",
        columns: ["Producto", "SKU", "Código interno", "Cantidad vendida", "Total vendido", "Stock actual"],
        rows: Array.from(productSales.values())
          .sort((left, right) => right.units - left.units)
          .slice(0, 100)
          .map((item) => ({
            Producto: item.product,
            SKU: item.sku,
            "Código interno": item.internalCode,
            "Cantidad vendida": item.units,
            "Total vendido": formatCurrency(item.total),
            "Stock actual": item.stock,
          })),
      },
      {
        key: "inventory",
        label: "Inventario actual",
        description: "Existencias actuales y valor de inventario por costo.",
        columns: ["SKU", "Código interno", "Producto", "Marca", "Stock", "Stock mínimo", "Costo", "Valor inventario"],
        rows: data.products.map((product) => ({
          SKU: product.sku,
          "Código interno": product.internal_code ?? "-",
          Producto: product.name,
          Marca: product.brand,
          Stock: product.stock,
          "Stock mínimo": product.min_stock,
          Costo: formatCurrency(product.cost_price),
          "Valor inventario": formatCurrency(product.cost_price * product.stock),
        })),
      },
      {
        key: "lowStock",
        label: "Productos con bajo stock",
        description: "Productos que llegaron al stock mínimo o están por debajo.",
        columns: ["SKU", "Código interno", "Producto", "Marca", "Stock", "Stock mínimo", "Estado"],
        rows: data.products
          .filter((product) => product.stock <= product.min_stock)
          .sort((left, right) => left.stock - right.stock)
          .map((product) => ({
            SKU: product.sku,
            "Código interno": product.internal_code ?? "-",
            Producto: product.name,
            Marca: product.brand,
            Stock: product.stock,
            "Stock mínimo": product.min_stock,
            Estado: product.status,
          })),
      },
    ];
  }, [data.orders, data.products, filteredInvoices, fiscalSettings, paymentByOrder, revenueOrders, totalIsv, totalItems, totalNet, totalSold]);

  const currentReport = reportDefinitions.find((report) => report.key === activeReport) ?? reportDefinitions[0];

  function exportCsv() {
    downloadBlob(
      buildCsv(currentReport.columns, currentReport.rows),
      `car-zone-${currentReport.key}.csv`,
      "text/csv;charset=utf-8",
    );
  }

  function exportExcel() {
    downloadBlob(
      buildExcelTable(currentReport.label, currentReport.columns, currentReport.rows),
      `car-zone-${currentReport.key}.xls`,
      "application/vnd.ms-excel;charset=utf-8",
    );
  }

  async function exportPdf() {
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
      doc.text(`Rango: ${startDate || "inicio"} a ${endDate || "hoy"}`, 14, 23);
      autoTable(doc, {
        startY: 30,
        head: [currentReport.columns],
        body: currentReport.rows.map((row) => currentReport.columns.map((column) => String(row[column] ?? ""))),
        styles: { fontSize: 8 },
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
        page={data.page ?? 1}
        pageSize={data.pageSize ?? 50}
        total={data.totalRecords ?? data.orders.length}
        label="registros por tabla"
      />

      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Total vendido" value={formatCurrency(totalSold)} />
        <Metric label="Total ISV" value={formatCurrency(totalIsv)} />
        <Metric label="Total neto" value={formatCurrency(totalNet)} />
        <Metric label="Bajo stock" value={lowStockCount.toLocaleString("es-HN")} />
      </div>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="mb-4 flex items-center gap-2">
          <Filter size={18} />
          <h2 className="font-semibold">Filtros y exportación</h2>
        </div>
        <div className="grid gap-3 lg:grid-cols-[1fr_1fr_220px_220px_auto] lg:items-end">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-black/50">Fecha inicial</span>
            <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-black/50">Fecha final</span>
            <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium uppercase text-black/50">Método de pago</span>
            <select
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value as ReportPaymentMethod | "all")}
              className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
            >
              <option value="all">Todos</option>
              <option value="bank_transfer">Transferencia bancaria</option>
              <option value="card">Tarjeta</option>
              <option value="cash">Efectivo</option>
            </select>
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium uppercase text-black/50">Estado de factura</span>
            <select
              value={invoiceStatus}
              onChange={(event) => setInvoiceStatus(event.target.value as InvoiceStatus | "all")}
              className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
            >
              <option value="all">Todos</option>
              <option value="emitida">Emitida</option>
              <option value="anulada">Anulada</option>
              <option value="pendiente">Pendiente</option>
              <option value="draft">Borrador</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={exportCsv}>
              <Download size={16} />
              CSV
            </Button>
            <Button variant="ghost" onClick={exportExcel}>
              <FileSpreadsheet size={16} />
              Excel
            </Button>
            <Button variant="dark" onClick={() => void exportPdf()} disabled={exportingPdf}>
              <Printer size={16} />
              {exportingPdf ? "Generando..." : "PDF"}
            </Button>
          </div>
        </div>
      </section>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {reportDefinitions.map((report) => (
          <button
            key={report.key}
            type="button"
            onClick={() => setActiveReport(report.key)}
            className={`shrink-0 rounded-md border px-3 py-2 text-sm font-medium ${
              activeReport === report.key
                ? "border-[#246a73] bg-[#246a73] text-white"
                : "border-black/10 bg-white text-[#1c1d1b]"
            }`}
          >
            {report.label}
          </button>
        ))}
      </div>

      <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
        <div className="flex flex-col justify-between gap-3 border-b border-black/10 p-5 sm:flex-row sm:items-center">
          <div>
            <div className="flex items-center gap-2">
              <FileText size={18} />
              <h2 className="font-semibold">{currentReport.label}</h2>
            </div>
            <p className="mt-1 text-sm text-black/55">{currentReport.description}</p>
          </div>
          <p className="text-sm font-medium text-black/50">{currentReport.rows.length.toLocaleString("es-HN")} filas</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-[#f0ede2] text-xs uppercase text-black/55">
              <tr>
                {currentReport.columns.map((column) => (
                  <th key={column} className="px-4 py-3">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {currentReport.rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-center text-black/50" colSpan={currentReport.columns.length}>
                    No hay datos para este reporte.
                  </td>
                </tr>
              ) : (
                currentReport.rows.map((row, index) => (
                  <tr key={`${currentReport.key}-${index}`}>
                    {currentReport.columns.map((column) => (
                      <td key={column} className="px-4 py-3">
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}
