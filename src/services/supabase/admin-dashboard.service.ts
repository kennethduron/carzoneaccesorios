import { getSupabaseServerClient } from "@/lib/supabase-server";

type CountResult = {
  count: number | null;
  error: { message: string } | null;
};

type ProductStockRow = {
  id: string;
  stock: number | null;
  reserved_stock: number | null;
  available_stock: number | null;
  min_stock: number | null;
};

type InvoiceTotalRow = {
  total: unknown;
};

export type AdminDashboardOverview = {
  salesToday: number;
  ordersToday: number;
  newOrders: number;
  pendingPayments: number;
  lowStockProducts: number;
  outOfStockProducts: number;
  activeReservations: number;
  pendingFollowups: number;
  pendingWholesaleRequests: number;
  pendingInvoices: number;
};

function todayStartIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function todayEndIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
}

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function safeCount(result: CountResult, label: string) {
  if (result.error) {
    console.warn(`Admin dashboard count failed: ${label}`, result.error.message);
    return 0;
  }

  return result.count ?? 0;
}

export async function getAdminDashboardOverview(): Promise<AdminDashboardOverview> {
  const supabase = await getSupabaseServerClient();
  const start = todayStartIso();
  const end = todayEndIso();

  const [
    ordersToday,
    newOrders,
    pendingPayments,
    activeReservations,
    pendingFollowups,
    pendingWholesaleRequests,
    pendingInvoices,
    productsResult,
    invoicesToday,
  ] = await Promise.all([
    supabase.from("orders").select("id", { count: "exact", head: true }).gte("created_at", start).lt("created_at", end),
    supabase.from("orders").select("id", { count: "exact", head: true }).in("status", ["pending", "recibido"]),
    supabase.from("payments").select("id", { count: "exact", head: true }).in("payment_status", ["pending"]),
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("order_reservation_status", "reserved"),
    supabase.from("crm_followups").select("id", { count: "exact", head: true }).eq("status", "pending").lt("due_at", end),
    supabase.from("customers").select("id", { count: "exact", head: true }).eq("wholesale_status", "pending"),
    supabase.from("invoices").select("id", { count: "exact", head: true }).in("status", ["pendiente", "draft"]),
    supabase
      .from("products")
      .select("id, stock, reserved_stock, available_stock, min_stock")
      .eq("active", true)
      .returns<ProductStockRow[]>(),
    supabase
      .from("invoices")
      .select("total")
      .gte("created_at", start)
      .lt("created_at", end)
      .in("status", ["emitida", "issued", "paid"])
      .returns<InvoiceTotalRow[]>(),
  ]);

  if (productsResult.error) {
    console.warn("Admin dashboard stock summary failed", productsResult.error.message);
  }

  if (invoicesToday.error) {
    console.warn("Admin dashboard sales summary failed", invoicesToday.error.message);
  }

  const stockRows = productsResult.data ?? [];
  const lowStockProducts = stockRows.filter((product) => {
    const available = toNumber(product.available_stock ?? toNumber(product.stock) - toNumber(product.reserved_stock));
    return available <= toNumber(product.min_stock);
  });

  return {
    salesToday: (invoicesToday.data ?? []).reduce((sum, invoice) => sum + toNumber(invoice.total), 0),
    ordersToday: safeCount(ordersToday, "ordersToday"),
    newOrders: safeCount(newOrders, "newOrders"),
    pendingPayments: safeCount(pendingPayments, "pendingPayments"),
    activeReservations: safeCount(activeReservations, "activeReservations"),
    pendingFollowups: safeCount(pendingFollowups, "pendingFollowups"),
    pendingWholesaleRequests: safeCount(pendingWholesaleRequests, "pendingWholesaleRequests"),
    pendingInvoices: safeCount(pendingInvoices, "pendingInvoices"),
    lowStockProducts: lowStockProducts.length,
    outOfStockProducts: lowStockProducts.filter((product) => {
      const available = toNumber(product.available_stock ?? toNumber(product.stock) - toNumber(product.reserved_stock));
      return available <= 0;
    }).length,
  };
}
