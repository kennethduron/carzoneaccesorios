import type { CommercialDashboardData, CommercialReportType } from "@/types/commercial-reporting";

export const reportTypeLabels: Record<CommercialReportType, string> = {
  SELLER_SALES: "Ventas por vendedor",
  COMMISSIONS: "Comisiones",
  SPECIAL_PRICES: "Precios especiales",
  OUTSTANDING_SALES: "Ventas pendientes de cobro",
  CUSTOMER_TYPES: "Ventas minoristas y mayoristas",
  PAYMENT_METHODS: "Métodos de pago",
  COMMERCIAL_SUMMARY: "Resumen comercial",
};

export function money(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

export function percentage(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 10_000) / 100 : 0;
}

export function safeFilename(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 80) || "reporte";
}

export function reportRows(type: CommercialReportType, data: CommercialDashboardData): Array<Record<string, string | number | boolean>> {
  if (type === "SELLER_SALES") return data.sellers.map((row) => ({ Vendedor: row.sellerName, Ventas: row.sales, Vendido: money(row.sold), Cobrado: money(row.collected), Pendiente: money(row.outstanding), "Ticket promedio": money(row.averageTicket), "Comisión ganada": money(row.earned) }));
  if (type === "COMMISSIONS") return data.sellers.map((row) => ({ Vendedor: row.sellerName, Potencial: money(row.potential), Ganada: money(row.earned), "Por ganar": money(row.remaining), Revertida: money(row.reversed) }));
  if (type === "SPECIAL_PRICES") return data.priceRequests.map((row) => ({ Fecha: row.requestedAt, Vendedor: row.sellerName, Producto: row.productName, SKU: row.sku, Estado: row.status, "Precio base": money(row.baseUnitPrice), "Precio solicitado": money(row.requestedUnitPrice), Diferencia: money(row.difference) }));
  if (type === "OUTSTANDING_SALES") return data.sales.filter((row) => row.outstanding > 0).map((row) => ({ Fecha: row.date, Venta: row.orderNumber, Vendedor: row.sellerName, Cliente: row.customerName, Total: money(row.total), Cobrado: money(row.collected), Pendiente: money(row.outstanding) }));
  if (type === "CUSTOMER_TYPES") return data.customerTypes.map((row) => ({ Tipo: row.label, Ventas: row.count, Monto: money(row.amount), Porcentaje: percentage(row.amount, data.kpis.sold) }));
  if (type === "PAYMENT_METHODS") return data.paymentMethods.map((row) => ({ Método: row.label, Ventas: row.count, Monto: money(row.amount), Porcentaje: percentage(row.amount, data.kpis.sold) }));
  return data.sales.map((row) => ({ Fecha: row.date, Venta: row.orderNumber, Vendedor: row.sellerName, Cliente: row.customerName, Canal: row.channel, Tipo: row.customerType === "wholesale" ? "Mayorista" : "Minorista", Método: row.paymentMethod, Estado: row.status, Total: money(row.total), Cobrado: money(row.collected), Pendiente: money(row.outstanding), "Precio especial": row.specialPrice ? "Sí" : "No", "Comisión ganada": money(row.earned) }));
}
