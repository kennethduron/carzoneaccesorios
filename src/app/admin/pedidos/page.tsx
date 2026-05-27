import Link from "next/link";
import nextDynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";
import { adminOrderTaskLabels, getAdminOrdersPage, normalizeAdminOrderTask } from "@/services/supabase/admin-orders.service";
import type { AdminOrderRow } from "@/types/orders";

export const dynamic = "force-dynamic";

const AdminOrdersManager = nextDynamic(
  () => import("@/components/admin/admin-orders-manager").then((module) => module.AdminOrdersManager),
  { loading: () => <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">Cargando pedidos...</div> },
);

function stripFinancialOrderData(order: AdminOrderRow): AdminOrderRow {
  return {
    ...order,
    subtotal: 0,
    tax: 0,
    shipping_fee: 0,
    shipping_total: 0,
    cash_on_delivery_fee: 0,
    small_order_fee: 0,
    discount_total: 0,
    additional_fees: [],
    total: 0,
    payment_status: null,
    bank_reference_number: null,
    transfer_receipt_url: null,
    transfer_receipt_public_id: null,
    invoice_id: null,
    invoice_number: null,
    invoice_issued_at: null,
    invoice_status: null,
    invoice_cancelled_at: null,
    invoice_cancellation_reason: null,
    fiscal_correction_history: [],
    customer_rtn: null,
    fiscal_customer_rtn: null,
    order_items: order.order_items.map((item) => ({
      ...item,
      unit_price: 0,
      line_total: 0,
      retail_price_snapshot: 0,
      wholesale_price_snapshot: 0,
    })),
  };
}

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; task?: string }>;
}) {
  const profile = await requirePermission("admin:access");
  const canReadOrders =
    profile.role === "admin" || profile.permissions.includes("orders:read") || profile.permissions.includes("orders:manage");

  if (!canReadOrders) {
    redirect("/sin-permiso");
  }

  const params = await searchParams;
  const task = normalizeAdminOrderTask(params.task);
  const canManagePayments = profile.role === "admin" || profile.permissions.includes("payments:manage");
  const canGenerateInvoices = profile.role === "admin" || profile.permissions.includes("invoices:create");
  const canCancelInvoices = profile.role === "admin" || profile.permissions.includes("invoices:manage");
  const canCorrectInvoices =
    ["technical_owner", "admin", "business_owner", "contadora"].includes(profile.role) ||
    profile.permissions.includes("invoices:correct");
  const canViewFinancialData =
    profile.role === "admin" ||
    profile.permissions.some((permission) =>
      ["payments:read", "payments:manage", "invoices:read", "invoices:create", "invoices:manage", "reports:read"].includes(permission),
    );
  const ordersPage = await getAdminOrdersPage({ page: Number(params.page ?? 1), pageSize: 50, task });
  const visibleOrders = canViewFinancialData ? ordersPage.orders : ordersPage.orders.map(stripFinancialOrderData);

  return (
    <AdminShell title="Pedidos">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <AdminOrdersManager
        orders={visibleOrders}
        total={ordersPage.total}
        page={ordersPage.page}
        pageSize={ordersPage.pageSize}
        canManagePayments={canManagePayments}
        canGenerateInvoices={canGenerateInvoices}
        canCancelInvoices={canCancelInvoices}
        canCorrectInvoices={canCorrectInvoices}
        canViewFinancialData={canViewFinancialData}
        activeTask={task ? { id: task, label: adminOrderTaskLabels[task] } : null}
      />
    </AdminShell>
  );
}
