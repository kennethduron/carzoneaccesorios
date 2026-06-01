import Link from "next/link";
import nextDynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { hasEffectivePermission } from "@/lib/auth/permissions";
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
    hasEffectivePermission(profile.role, profile.permissions, "orders:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "orders:manage", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "orders:manage_logistics", profile.email);

  if (!canReadOrders) {
    redirect("/sin-permiso");
  }

  const params = await searchParams;
  const task = normalizeAdminOrderTask(params.task);
  const canManagePayments = hasEffectivePermission(profile.role, profile.permissions, "payments:manage", profile.email);
  const canConfirmPayments =
    canManagePayments || hasEffectivePermission(profile.role, profile.permissions, "payments:confirm", profile.email);
  const canRejectPayments =
    canManagePayments || hasEffectivePermission(profile.role, profile.permissions, "payments:reject", profile.email);
  const canExtendReservations = hasEffectivePermission(profile.role, profile.permissions, "orders:extend_reservation", profile.email);
  const canReviewReservations = hasEffectivePermission(profile.role, profile.permissions, "reservations:review", profile.email);
  const canManageOrders = hasEffectivePermission(profile.role, profile.permissions, "orders:manage", profile.email);
  const canCancelOrders =
    canManageOrders || hasEffectivePermission(profile.role, profile.permissions, "orders:cancel", profile.email);
  const canManageLogistics =
    canManageOrders || hasEffectivePermission(profile.role, profile.permissions, "orders:manage_logistics", profile.email);
  const canGenerateInvoices = hasEffectivePermission(profile.role, profile.permissions, "invoices:create", profile.email);
  const canCancelInvoices = hasEffectivePermission(profile.role, profile.permissions, "invoices:manage", profile.email);
  const canCorrectInvoices =
    ["technical_owner", "admin", "business_owner", "contadora"].includes(profile.role) ||
    profile.permissions.includes("invoices:correct");
  const canViewFinancialData =
    profile.permissions.some((permission) =>
      ["payments:read", "payments:manage", "payments:confirm", "payments:reject", "invoices:read", "invoices:create", "invoices:manage", "reports:read"].includes(permission),
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
        canConfirmPayments={canConfirmPayments}
        canRejectPayments={canRejectPayments}
        canExtendReservations={canExtendReservations}
        canReviewReservations={canReviewReservations}
        canManageOrders={canManageOrders}
        canCancelOrders={canCancelOrders}
        canManageLogistics={canManageLogistics}
        canGenerateInvoices={canGenerateInvoices}
        canCancelInvoices={canCancelInvoices}
        canCorrectInvoices={canCorrectInvoices}
        canViewFinancialData={canViewFinancialData}
        activeTask={task ? { id: task, label: adminOrderTaskLabels[task] } : null}
      />
    </AdminShell>
  );
}
