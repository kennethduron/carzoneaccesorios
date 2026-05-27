import Link from "next/link";
import { AdminShell } from "@/components/admin/admin-shell";
import { FiscalAlertsPanel } from "@/components/admin/fiscal-alerts-panel";
import { LogoutButton } from "@/components/auth";
import { requirePermission } from "@/lib/auth/session";
import { getAdminBusinessSettings } from "@/services/supabase/admin-business-settings.service";
import { getAdminDashboardOverview } from "@/services/supabase/admin-dashboard.service";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { getAdminInvoices } from "@/services/supabase/admin-invoices.service";
import type { Permission } from "@/types/auth";
import type { DashboardCardKey } from "@/types/settings";
import { getFiscalAlerts } from "@/utils/fiscal";
import { formatCurrency } from "@/utils/pricing";

export const dynamic = "force-dynamic";

const adminModules = [
  ["Productos", "/admin/productos", "Crear, editar, desactivar, eliminar, importar y exportar productos.", ["products:manage"]],
  ["Inventario", "/admin/inventario", "Entradas, salidas, ajustes, historial y alertas de bajo stock.", ["inventory:manage"]],
  ["Pedidos", "/admin/pedidos", "Seguimiento de pedidos, pagos y facturación.", ["orders:read", "orders:manage"]],
  ["Facturas", "/admin/facturas", "Facturas fiscales, referencias bancarias, PDF y anulación.", ["invoices:read", "invoices:manage"]],
  ["Clientes", "/admin/clientes", "CRM, notas y seguimiento comercial.", ["crm:manage", "customers:manage"]],
  ["Clientes Mayoristas", "/admin/clientes-mayoristas", "Aprobar, rechazar, suspender y reactivar acceso mayorista por cuenta.", ["customers:manage"]],
  ["Reportes", "/admin/reportes", "Reportes contables, filtros, Excel, CSV y PDF.", ["reports:read"]],
  ["Seguridad", "/admin/seguridad", "Usuarios, roles, permisos, auditoría y controles administrativos.", ["settings:manage", "audit:read", "users:manage"]],
  ["Uso y monitoreo", "/admin/uso", "Volumen de datos, logs antiguos, cron, backups y referencias externas.", ["system:monitoring"]],
  ["Configuración empresarial", "/admin/configuracion", "Notificaciones, CRM, mayoristas, pedidos, inventario, dashboard y contacto.", ["commercial_settings:manage", "settings:manage"]],
  ["Configuración fiscal", "/admin/configuracion-fiscal", "RTN, CAI, rango fiscal, fecha límite y datos legales.", ["fiscal:read", "settings:manage"]],
  ["Revisión BAC", "/admin/revision-bac", "Checklist de requisitos web para pasarela BAC Credomatic.", ["commercial_settings:manage", "settings:manage"]],
  ["Guía rápida", "/admin/guia", "Pasos diarios resumidos para operar productos, pedidos, CRM, facturas y BAC.", ["admin:access"]],
  ["Ayuda interna", "/admin/ayuda", "Manual operativo por rol para productos, pedidos, facturas, CRM y BAC.", ["admin:access"]],
  ["Banners festivos", "/admin/banners", "Flyers, promociones y mensajes por días festivos de Honduras.", ["settings:manage", "commercial_settings:manage"]],
] satisfies Array<[string, string, string, Permission[]]>;

function canAccessModule(role: string, permissions: Permission[], modulePermissions: Permission[]) {
  if (modulePermissions.includes("admin:access")) {
    return role === "admin" || permissions.includes("admin:access");
  }

  if (modulePermissions.includes("system:monitoring")) {
    return permissions.includes("system:monitoring");
  }

  return role === "admin" || modulePermissions.some((permission) => permissions.includes(permission));
}

function formatDate(value: string | null) {
  if (!value) {
    return "Sin registro";
  }

  return new Intl.DateTimeFormat("es-HN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusTone(status: string | null) {
  if (!status) {
    return "bg-[#f4f4f5] text-black/55";
  }

  if (["success", "ok", "active"].includes(status)) {
    return "bg-[#edf7ed] text-[#2f6f3e]";
  }

  if (["failed", "risk"].includes(status)) {
    return "bg-[#fdecec] text-[#a33a2d]";
  }

  return "bg-[#fff7ed] text-[#7c2d12]";
}

export default async function AdminPage() {
  const profile = await requirePermission("admin:access");
  const canViewTechnical = profile.permissions.includes("system:monitoring");
  const canViewFiscalAlerts =
    profile.role === "admin" ||
    profile.permissions.includes("fiscal:read") ||
    profile.permissions.includes("invoices:read") ||
    profile.permissions.includes("reports:read");
  const canReadInvoices = profile.role === "admin" || profile.permissions.includes("invoices:read");
  const [fiscalSettings, invoices] = canViewFiscalAlerts
    ? await Promise.all([getFiscalSettings(), canReadInvoices ? getAdminInvoices() : Promise.resolve([])])
    : [null, []];
  const [overview, businessSettings] = await Promise.all([getAdminDashboardOverview(), getAdminBusinessSettings()]);
  const visibleCards = businessSettings.dashboard_cards;
  const fiscalAlerts = fiscalSettings ? getFiscalAlerts(fiscalSettings, invoices) : [];

  const todayTaskOptions = [
    {
      label: "Revisar pedidos nuevos",
      value: overview.newOrders,
      href: "/admin/pedidos?task=new_orders",
      empty: "Todavía no hay pedidos. Cuando un cliente compre, aparecerán aquí.",
      permissions: ["orders:read", "orders:manage"],
      card: "pending_orders",
    },
    {
      label: "Preparar pedidos confirmados",
      value: overview.ordersToPrepare,
      href: "/admin/pedidos?task=to_prepare",
      empty: "No hay pedidos confirmados esperando preparación.",
      permissions: ["orders:read", "orders:manage"],
      card: "pending_orders",
    },
    {
      label: "Confirmar pagos pendientes",
      value: overview.pendingPayments,
      href: "/admin/pedidos?task=pending_payments",
      empty: "No hay pagos esperando revisión.",
      permissions: ["orders:manage"],
      card: "pending_payments",
    },
    {
      label: "Revisar inventario bajo",
      value: overview.lowStockProducts,
      href: "/admin/inventario?filter=low_stock",
      empty: "Inventario sin alertas críticas.",
      permissions: ["inventory:manage"],
      card: "low_inventory",
    },
    {
      label: "Atender CRM vencido",
      value: overview.pendingFollowups,
      href: "/admin/crm?task=overdue",
      empty: "No hay seguimientos vencidos.",
      permissions: ["crm:manage", "customers:manage"],
      card: "customers_attention",
    },
    {
      label: "Revisar solicitudes mayoristas",
      value: overview.pendingWholesaleRequests,
      href: "/admin/clientes-mayoristas?status=pending",
      empty: "No hay solicitudes mayoristas pendientes.",
      permissions: ["customers:manage"],
      card: "wholesale_requests",
    },
    {
      label: "Revisar facturas pendientes",
      value: overview.pendingInvoices,
      href: "/admin/facturas?task=pending_invoices",
      empty: "No hay facturas pendientes.",
      permissions: ["invoices:read", "invoices:manage"],
      card: "pending_invoices",
    },
  ] satisfies Array<{
    label: string;
    value: number;
    href: string;
    empty: string;
    permissions: Permission[];
    card: DashboardCardKey;
  }>;
  const todayTasks = todayTaskOptions.filter((task) => visibleCards[task.card] && canAccessModule(profile.role, profile.permissions, task.permissions));

  const ownerMetrics = [
    { label: "Ventas hoy", value: formatCurrency(overview.salesToday), visible: visibleCards.sales_today },
    { label: "Ventas del mes", value: formatCurrency(overview.salesMonth), visible: visibleCards.sales_today },
    { label: "Pedidos hoy", value: overview.ordersToday.toLocaleString("es-HN"), visible: visibleCards.pending_orders },
    { label: "Pedidos pendientes", value: overview.newOrders.toLocaleString("es-HN"), visible: visibleCards.pending_orders },
    { label: "Pagos pendientes", value: overview.pendingPayments.toLocaleString("es-HN"), visible: visibleCards.pending_payments },
    { label: "Por preparar", value: overview.ordersToPrepare.toLocaleString("es-HN"), visible: visibleCards.pending_orders },
    { label: "Facturas pendientes", value: overview.pendingInvoices.toLocaleString("es-HN"), visible: visibleCards.pending_invoices },
    { label: "Sin stock", value: overview.outOfStockProducts.toLocaleString("es-HN"), visible: visibleCards.low_inventory },
    { label: "Bajo mínimo", value: overview.lowStockProducts.toLocaleString("es-HN"), visible: visibleCards.low_inventory },
    { label: "Clientes nuevos hoy", value: overview.newCustomersToday.toLocaleString("es-HN"), visible: visibleCards.customers_attention },
    { label: "Clientes nuevos mes", value: overview.newCustomersMonth.toLocaleString("es-HN"), visible: visibleCards.customers_attention },
    { label: "Mayoristas pendientes", value: overview.pendingWholesaleRequests.toLocaleString("es-HN"), visible: visibleCards.wholesale_requests },
    { label: "CRM vencido", value: overview.pendingFollowups.toLocaleString("es-HN"), visible: visibleCards.customers_attention },
    { label: "Reservas activas", value: overview.activeReservations.toLocaleString("es-HN"), visible: canViewTechnical && visibleCards.backup_cron_status },
    { label: "Reservas vencidas", value: overview.expiredReservations.toLocaleString("es-HN"), visible: canViewTechnical && visibleCards.backup_cron_status },
  ].filter((metric) => metric.visible);

  return (
    <AdminShell title="Panel administrativo">
      <div className="mb-6 flex flex-col justify-between gap-3 rounded-lg border border-black/10 bg-white p-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-sm text-black/50">Sesión activa</p>
          <p className="font-semibold">{profile.full_name || profile.email}</p>
          <p className="text-sm capitalize text-black/55">Rol: {profile.role}</p>
        </div>
        <LogoutButton />
      </div>

      {fiscalAlerts.length > 0 ? (
        <div className="mb-6">
          <FiscalAlertsPanel alerts={fiscalAlerts} />
        </div>
      ) : null}

      <section className="mb-6 grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="rounded-lg border border-black/10 bg-white p-5">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm text-black/50">Operación diaria</p>
              <h2 className="text-2xl font-semibold">Qué hacer hoy</h2>
            </div>
            <p className="text-sm text-black/55">Prioridades simples para mantener la tienda bajo control.</p>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {todayTasks.map((task) => (
              <Link
                key={task.label}
                href={task.href}
                className="rounded-lg border border-black/10 bg-[#fafafa] p-4 transition-colors hover:border-[#e4252c]"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-semibold">{task.label}</p>
                  <span className="rounded-md bg-white px-2.5 py-1 text-sm font-semibold text-[#e4252c] shadow-sm">
                    {task.value.toLocaleString("es-HN")}
                  </span>
                </div>
                <p className="mt-2 text-sm text-black/55">{task.value > 0 ? "Requiere revisión operativa." : task.empty}</p>
              </Link>
            ))}
            {todayTasks.length === 0 ? (
              <div className="rounded-lg border border-dashed border-black/15 bg-[#fafafa] p-4 text-sm text-black/55 md:col-span-2">
                No hay tarjetas operativas habilitadas para tu rol.
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border border-black/10 bg-white p-5">
          <p className="text-sm text-black/50">Vista del dueño</p>
          <h2 className="mt-1 text-2xl font-semibold">Resumen operativo</h2>
          <p className="text-sm text-black/55">Agregado en base de datos, sin cargar listas completas.</p>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            {ownerMetrics.map((metric) => (
              <OwnerMetric key={metric.label} label={metric.label} value={metric.value} />
            ))}
          </div>
          {visibleCards.bac_alerts ? (
            <div className="mt-4 rounded-md border border-black/10 bg-[#f4f4f5] p-3 text-sm">
              <p className="font-semibold">BAC</p>
              <p className="mt-1 text-black/60">
                {businessSettings.bac_card_status === "active"
                  ? "Tarjeta BAC activa en configuración."
                  : businessSettings.bac_card_status === "pending"
                    ? "BAC pendiente de activación o revisión."
                    : "BAC oculto para clientes."}
              </p>
            </div>
          ) : null}
          {canViewTechnical && visibleCards.backup_cron_status ? (
            <div className="mt-3 grid gap-2 text-sm">
              <OperationalStatus
                label="Cron"
                status={overview.latestCronStatus}
                detail={overview.latestCronJob ? `${overview.latestCronJob} - ${formatDate(overview.latestCronAt)}` : "Sin ejecuciones registradas"}
              />
              <OperationalStatus label="Backups" status={overview.latestBackupStatus} detail={formatDate(overview.latestBackupAt)} />
            </div>
          ) : null}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {adminModules
          .filter(([, , , permissions]) => canAccessModule(profile.role, profile.permissions, permissions))
          .map(([title, href, description]) => (
            <Link
              key={title}
              href={href}
              className="rounded-lg border border-black/10 bg-white p-5 transition-colors hover:border-[#e4252c]"
            >
              <h2 className="font-semibold">{title}</h2>
              <p className="mt-2 text-sm text-black/55">{description}</p>
            </Link>
          ))}
      </div>
    </AdminShell>
  );
}

function OwnerMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-[#f4f4f5] p-3">
      <p className="text-xs font-medium uppercase text-black/45">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}

function OperationalStatus({ label, status, detail }: { label: string; status: string | null; detail: string }) {
  return (
    <div className="rounded-md border border-black/10 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold">{label}</p>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(status)}`}>
          {status ?? "Sin estado"}
        </span>
      </div>
      <p className="mt-2 text-xs text-black/55">{detail}</p>
    </div>
  );
}
