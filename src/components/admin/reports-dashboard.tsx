"use client";

import { useMemo, useState } from "react";
import { Download, FileSpreadsheet, FileText, Filter, Printer } from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { Button, Input } from "@/components/ui";
import type { AdminReportsData, ReportOrder } from "@/types/reports";
import { formatCurrency } from "@/utils/pricing";

type ReportKey = "daily" | "monthly" | "products" | "stock" | "invoices" | "orders" | "customers";

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
};

const paymentLabels: Record<string, string> = {
  bank_transfer: "Transferencia",
  card: "Tarjeta",
  cash: "Efectivo",
};

const reportLabels: Record<ReportKey, string> = {
  daily: "Ventas diarias",
  monthly: "Ventas mensuales",
  products: "Mas vendidos",
  stock: "Bajo stock",
  invoices: "Facturas",
  orders: "Pedidos",
  customers: "Clientes frecuentes",
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("es-HN");
}

function formatMonth(value: string) {
  return new Intl.DateTimeFormat("es-HN", { month: "long", year: "numeric" }).format(new Date(value));
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
  const text = String(value);
  return `"${text.replaceAll('"', '""')}"`;
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

export function ReportsDashboard({ data }: ReportsDashboardProps) {
  const [activeReport, setActiveReport] = useState<ReportKey>("daily");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const filteredOrders = useMemo(
    () => data.orders.filter((order) => isInsideRange(order.created_at, startDate, endDate)),
    [data.orders, endDate, startDate],
  );

  const filteredInvoices = useMemo(
    () => data.invoices.filter((invoice) => isInsideRange(invoice.issued_at ?? invoice.created_at, startDate, endDate)),
    [data.invoices, endDate, startDate],
  );

  const revenueOrders = useMemo(() => filteredOrders.filter(isRevenueOrder), [filteredOrders]);
  const totalSales = revenueOrders.reduce((sum, order) => sum + order.total, 0);
  const totalItems = revenueOrders.reduce(
    (sum, order) => sum + order.order_items.reduce((itemSum, item) => itemSum + item.quantity, 0),
    0,
  );
  const lowStockCount = data.products.filter((product) => product.stock <= product.min_stock).length;

  const reportDefinitions = useMemo<ReportDefinition[]>(() => {
    const dailySales = new Map<string, { orders: number; units: number; total: number }>();
    const monthlySales = new Map<string, { orders: number; units: number; total: number }>();
    const productSales = new Map<string, { sku: string; product: string; units: number; total: number }>();
    const customerSales = new Map<string, { customer: string; phone: string; orders: number; total: number }>();

    revenueOrders.forEach((order) => {
      const dayKey = normalizeDay(order.created_at);
      const monthKey = normalizeMonth(order.created_at);
      const units = order.order_items.reduce((sum, item) => sum + item.quantity, 0);
      const daily = dailySales.get(dayKey) ?? { orders: 0, units: 0, total: 0 };
      const monthly = monthlySales.get(monthKey) ?? { orders: 0, units: 0, total: 0 };
      const customerKey = order.customer_id ?? `${order.customer_name}-${order.phone}`;
      const customer = customerSales.get(customerKey) ?? {
        customer: order.customer_name,
        phone: order.phone,
        orders: 0,
        total: 0,
      };

      dailySales.set(dayKey, { orders: daily.orders + 1, units: daily.units + units, total: daily.total + order.total });
      monthlySales.set(monthKey, {
        orders: monthly.orders + 1,
        units: monthly.units + units,
        total: monthly.total + order.total,
      });
      customerSales.set(customerKey, {
        ...customer,
        orders: customer.orders + 1,
        total: customer.total + order.total,
      });

      order.order_items.forEach((item) => {
        const productKey = item.product_id ?? item.sku;
        const current = productSales.get(productKey) ?? {
          sku: item.sku,
          product: item.product_name,
          units: 0,
          total: 0,
        };
        productSales.set(productKey, {
          ...current,
          units: current.units + item.quantity,
          total: current.total + item.line_total,
        });
      });
    });

    return [
      {
        key: "daily",
        label: reportLabels.daily,
        description: "Ventas agrupadas por dia dentro del rango seleccionado.",
        columns: ["Fecha", "Pedidos", "Unidades", "Total"],
        rows: Array.from(dailySales.entries())
          .sort(([left], [right]) => right.localeCompare(left))
          .map(([date, value]) => ({
            Fecha: formatDate(date),
            Pedidos: value.orders,
            Unidades: value.units,
            Total: formatCurrency(value.total),
          })),
      },
      {
        key: "monthly",
        label: reportLabels.monthly,
        description: "Ventas agrupadas por mes para ver tendencia comercial.",
        columns: ["Mes", "Pedidos", "Unidades", "Total"],
        rows: Array.from(monthlySales.entries())
          .sort(([left], [right]) => right.localeCompare(left))
          .map(([month, value]) => ({
            Mes: formatMonth(`${month}-01`),
            Pedidos: value.orders,
            Unidades: value.units,
            Total: formatCurrency(value.total),
          })),
      },
      {
        key: "products",
        label: reportLabels.products,
        description: "Ranking por unidades vendidas y venta acumulada.",
        columns: ["SKU", "Producto", "Unidades", "Total"],
        rows: Array.from(productSales.values())
          .sort((left, right) => right.units - left.units)
          .slice(0, 50)
          .map((item) => ({
            SKU: item.sku,
            Producto: item.product,
            Unidades: item.units,
            Total: formatCurrency(item.total),
          })),
      },
      {
        key: "stock",
        label: reportLabels.stock,
        description: "Productos que llegaron al minimo o estan por debajo.",
        columns: ["SKU", "Producto", "Marca", "Stock", "Minimo", "Estado"],
        rows: data.products
          .filter((product) => product.stock <= product.min_stock)
          .sort((left, right) => left.stock - right.stock)
          .map((product) => ({
            SKU: product.sku,
            Producto: product.name,
            Marca: product.brand,
            Stock: product.stock,
            Minimo: product.min_stock,
            Estado: product.status,
          })),
      },
      {
        key: "invoices",
        label: reportLabels.invoices,
        description: "Facturas emitidas o anuladas en el rango seleccionado.",
        columns: ["Factura", "Fecha", "RTN", "CAI", "Tipo precio", "Estado", "Total"],
        rows: filteredInvoices.map((invoice) => ({
          Factura: invoice.invoice_number,
          Fecha: formatDate(invoice.issued_at ?? invoice.created_at),
          RTN: invoice.rtn ?? "-",
          CAI: invoice.cai ?? "-",
          "Tipo precio": invoice.price_mode === "wholesale" ? "wholesale_price" : "retail_price",
          Estado: invoice.status,
          Total: formatCurrency(invoice.total),
        })),
      },
      {
        key: "orders",
        label: reportLabels.orders,
        description: "Pedidos con estado, metodo de pago y tipo de precio usado.",
        columns: ["Pedido", "Fecha", "Cliente", "Pago", "Tipo precio", "Estado", "Total"],
        rows: filteredOrders.map((order) => ({
          Pedido: order.order_number,
          Fecha: formatDate(order.created_at),
          Cliente: order.customer_name,
          Pago: paymentLabels[order.payment_method] ?? order.payment_method,
          "Tipo precio": order.price_mode === "wholesale" ? "wholesale_price" : "retail_price",
          Estado: order.status,
          Total: formatCurrency(order.total),
        })),
      },
      {
        key: "customers",
        label: reportLabels.customers,
        description: "Clientes ordenados por frecuencia de compra.",
        columns: ["Cliente", "Telefono", "Pedidos", "Total comprado"],
        rows: Array.from(customerSales.values())
          .sort((left, right) => right.orders - left.orders || right.total - left.total)
          .map((customer) => ({
            Cliente: customer.customer,
            Telefono: customer.phone,
            Pedidos: customer.orders,
            "Total comprado": formatCurrency(customer.total),
          })),
      },
    ];
  }, [data.products, filteredInvoices, filteredOrders, revenueOrders]);

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

  function exportPdf() {
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
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Ventas del rango" value={formatCurrency(totalSales)} />
        <Metric label="Pedidos" value={filteredOrders.length.toLocaleString("es-HN")} />
        <Metric label="Unidades vendidas" value={totalItems.toLocaleString("es-HN")} />
        <Metric label="Bajo stock" value={lowStockCount.toLocaleString("es-HN")} />
      </div>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="mb-4 flex items-center gap-2">
          <Filter size={18} />
          <h2 className="font-semibold">Filtros y exportacion</h2>
        </div>
        <div className="grid gap-3 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-black/50">Desde</span>
            <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-black/50">Hasta</span>
            <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
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
            <Button variant="dark" onClick={exportPdf}>
              <Printer size={16} />
              PDF
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
          <table className="w-full min-w-[760px] text-left text-sm">
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
