import { getSupabaseAdminClient } from "@/lib/supabase";

export type AdminDashboardOverview = {
  salesToday: number;
  salesMonth: number;
  ordersToday: number;
  newOrders: number;
  pendingPayments: number;
  ordersToPrepare: number;
  lowStockProducts: number;
  outOfStockProducts: number;
  activeReservations: number;
  expiredReservations: number;
  pendingFollowups: number;
  pendingWholesaleRequests: number;
  pendingInvoices: number;
  newCustomersToday: number;
  newCustomersMonth: number;
  latestCronJob: string | null;
  latestCronStatus: string | null;
  latestCronAt: string | null;
  latestBackupStatus: string | null;
  latestBackupAt: string | null;
};

type DashboardSummaryRow = {
  sales_today: unknown;
  sales_month: unknown;
  orders_today: number | null;
  pending_orders: number | null;
  pending_payments: number | null;
  orders_to_prepare: number | null;
  pending_invoices: number | null;
  out_of_stock_products: number | null;
  low_stock_products: number | null;
  new_customers_today: number | null;
  new_customers_month: number | null;
  pending_wholesale_requests: number | null;
  overdue_followups: number | null;
  active_reservations: number | null;
  expired_reservations: number | null;
  latest_cron_job: string | null;
  latest_cron_status: string | null;
  latest_cron_at: string | null;
  latest_backup_status: string | null;
  latest_backup_at: string | null;
};

const emptyOverview: AdminDashboardOverview = {
  salesToday: 0,
  salesMonth: 0,
  ordersToday: 0,
  newOrders: 0,
  pendingPayments: 0,
  ordersToPrepare: 0,
  lowStockProducts: 0,
  outOfStockProducts: 0,
  activeReservations: 0,
  expiredReservations: 0,
  pendingFollowups: 0,
  pendingWholesaleRequests: 0,
  pendingInvoices: 0,
  newCustomersToday: 0,
  newCustomersMonth: 0,
  latestCronJob: null,
  latestCronStatus: null,
  latestCronAt: null,
  latestBackupStatus: null,
  latestBackupAt: null,
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function normalizeOverview(row: DashboardSummaryRow | null | undefined): AdminDashboardOverview {
  if (!row) {
    return emptyOverview;
  }

  return {
    salesToday: toNumber(row.sales_today),
    salesMonth: toNumber(row.sales_month),
    ordersToday: toNumber(row.orders_today),
    newOrders: toNumber(row.pending_orders),
    pendingPayments: toNumber(row.pending_payments),
    ordersToPrepare: toNumber(row.orders_to_prepare),
    pendingInvoices: toNumber(row.pending_invoices),
    outOfStockProducts: toNumber(row.out_of_stock_products),
    lowStockProducts: toNumber(row.low_stock_products),
    newCustomersToday: toNumber(row.new_customers_today),
    newCustomersMonth: toNumber(row.new_customers_month),
    pendingWholesaleRequests: toNumber(row.pending_wholesale_requests),
    pendingFollowups: toNumber(row.overdue_followups),
    activeReservations: toNumber(row.active_reservations),
    expiredReservations: toNumber(row.expired_reservations),
    latestCronJob: row.latest_cron_job,
    latestCronStatus: row.latest_cron_status,
    latestCronAt: row.latest_cron_at,
    latestBackupStatus: row.latest_backup_status,
    latestBackupAt: row.latest_backup_at,
  };
}

export async function getAdminDashboardOverview(): Promise<AdminDashboardOverview> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("get_admin_dashboard_operational_summary").returns<DashboardSummaryRow[]>();

  if (error) {
    console.warn("Admin dashboard summary failed", error.message);
    return emptyOverview;
  }

  return normalizeOverview(Array.isArray(data) ? data[0] : null);
}
