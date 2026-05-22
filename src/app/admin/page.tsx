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
  {
    title: "Productos",
    href: "/admin/productos",
    description: "Crear, editar, desactivar, eliminar, importar y exportar productos.",
    permissions: ["products:manage"] satisfies Permission[],
  },
  {
    title: "Inventario",
    href: "/admin/inventario",
    description: "Entradas, salidas, ajustes, historial y alertas de bajo stock.",
    permissions: ["inventory:manage"] satisfies Permission[],
  },
  {
    title: "Pedidos",
    href: "/admin/pedidos",
    description: "Seguimiento de pedidos, pagos y facturación.",
    permissions: ["orders:read", "orders:manage"] satisfies Permission[],
  },
  {
    title: "Facturas",
    href: "/admin/facturas",
    description: "Facturas fiscales, referencias bancarias, PDF y anulación.",
    permissions: ["invoices:read", "invoices:manage"] satisfies Permission[],
  },
  {
    title: "Clientes",
    href: "/admin/clientes",
    description: "CRM, notas y seguimiento comercial.",
    permissions: ["crm:manage", "customers:manage"] satisfies Permission[],
  },
  {
    title: "Clientes Mayoristas",
    href: "/admin/clientes-mayoristas",
    description: "Aprobar, rechazar, suspender y reactivar acceso mayorista por estado de cuenta.",
    permissions: ["customers:manage"] satisfies Permission[],
  },
  {
    title: "Reportes",
    href: "/admin/reportes",
    description: "Reportes contables, filtros, Excel, CSV y PDF.",
    permissions: ["reports:read"] satisfies Permission[],
  },
  {
    title: "Seguridad",
    href: "/admin/seguridad",
    description: "Usuarios, roles, permisos, auditoria y controles administrativos.",
    permissions: ["settings:manage", "audit:read", "users:manage"] satisfies Permission[],
  },
  {
    title: "Uso y monitoreo",
    href: "/admin/uso",
    description: "Volumen de datos, logs antiguos y referencias a archivos externos.",
    permissions: ["system:monitoring"] satisfies Permission[],
  },
  {
    title: "Configuración empresarial",
    href: "/admin/configuracion",
    description: "Notificaciones, CRM, mayoristas, pedidos, inventario, dashboard y contacto.",
    permissions: ["commercial_settings:manage", "settings:manage"] satisfies Permission[],
  },
  {
    title: "Configuración fiscal",
    href: "/admin/configuracion-fiscal",
    description: "RTN, CAI, rango fiscal, fecha límite y datos legales.",
    permissions: ["fiscal:read", "settings:manage"] satisfies Permission[],
  },
  {
    title: "Revisión BAC",
    href: "/admin/revision-bac",
    description: "Checklist de requisitos web para pasarela BAC Credomatic.",
    permissions: ["commercial_settings:manage", "settings:manage"] satisfies Permission[],
  },
  {
    title: "Guía rápida",
    href: "/admin/guia",
    description: "Pasos diarios por rol para operar productos, pedidos, CRM, facturas y BAC.",
    permissions: ["admin:access"] satisfies Permission[],
  },
  {
    title: "Banners festivos",
    href: "/admin/banners",
    description: "Flyers, promociones y mensajes por dias festivos de Honduras.",
    permissions: ["settings:manage", "commercial_settings:manage"] satisfies Permission[],
  },
];

function canAccessModule(role: string, permissions: Permission[], modulePermissions: Permission[]) {
  if (modulePermissions.includes("admin:access")) {
    return role === "admin" || permissions.includes("admin:access");
  }

  if (modulePermissions.includes("system:monitoring")) {
    return permissions.includes("system:monitoring");
  }

  return role === "admin" || modulePermissions.some((permission) => permissions.includes(permission));
}

export default async function AdminPage() {
  const profile = await requirePermission("admin:access");
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
  const todayTasks: Array<{
    label: string;
    value: number;
    href: string;
    empty: string;
    permissions: Permission[];
    card: DashboardCardKey;
  }> = [
    {
      label: "Revisar pedidos nuevos",
      value: overview.newOrders,
      href: "/admin/pedidos",
      empty: "Todavía no hay pedidos. Cuando un cliente compre, aparecerán aquí.",
      permissions: ["orders:read", "orders:manage"] satisfies Permission[],
      card: "pending_orders" as DashboardCardKey,
    },
    {
      label: "Confirmar pagos pendientes",
      value: overview.pendingPayments,
      href: "/admin/pedidos",
      empty: "No hay pagos esperando revisión.",
      permissions: ["orders:manage"] satisfies Permission[],
      card: "pending_payments" as DashboardCardKey,
    },
    {
      label: "Revisar inventario bajo",
      value: overview.lowStockProducts,
      href: "/admin/inventario",
      empty: "Inventario sin alertas críticas.",
      permissions: ["inventory:manage"] satisfies Permission[],
      card: "low_inventory" as DashboardCardKey,
    },
    {
      label: "Revisar seguimientos CRM pendientes",
      value: overview.pendingFollowups,
      href: "/admin/clientes",
      empty: "No hay seguimientos vencidos o para hoy.",
      permissions: ["crm:manage", "customers:manage"] satisfies Permission[],
      card: "customers_attention" as DashboardCardKey,
    },
    {
      label: "Revisar solicitudes mayoristas",
      value: overview.pendingWholesaleRequests,
      href: "/admin/clientes-mayoristas",
      empty: "No hay solicitudes mayoristas pendientes.",
      permissions: ["customers:manage"] satisfies Permission[],
      card: "wholesale_requests" as DashboardCardKey,
    },
    {
      label: "Revisar facturas pendientes",
      value: overview.pendingInvoices,
      href: "/admin/facturas",
      empty: "No hay facturas pendientes.",
      permissions: ["invoices:read", "invoices:manage"] satisfies Permission[],
      card: "pending_invoices" as DashboardCardKey,
    },
  ].filter((task) => visibleCards[task.card] && canAccessModule(profile.role, profile.permissions, task.permissions));

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

      <section className="mb-6 grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="rounded-lg border border-black/10 bg-white p-5">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm text-black/50">Operación diaria</p>
              <h2 className="text-2xl font-semibold">Qué hacer hoy</h2>
            </div>
            <p className="text-sm text-black/55">Prioridades simples para mantener la tienda bajo control.</p>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {todayTasks.map((task) => (
              <Link
                key={task.label}
                href={task.href}
                className="rounded-lg border border-black/10 bg-[#fafafa] p-4 transition-colors hover:border-[#e4252c]"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-semibold">{task.label}</p>
                  <span className="rounded-md bg-white px-2.5 py-1 text-sm font-semibold text-[#e4252c] shadow-sm">
                    {task.value}
                  </span>
                </div>
                <p className="mt-2 text-sm text-black/55">
                  {task.value > 0 ? "Requiere revisión operativa." : task.empty}
                </p>
              </Link>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-black/10 bg-white p-5">
          <p className="text-sm text-black/50">Vista del dueño</p>
          {visibleCards.sales_today ? (
            <>
              <h2 className="mt-1 text-2xl font-semibold">{formatCurrency(overview.salesToday)}</h2>
              <p className="text-sm text-black/55">Vendido hoy según facturas emitidas.</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-black/55">Resumen operativo según tarjetas habilitadas.</p>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            {visibleCards.sales_today ? <OwnerMetric label="Pedidos hoy" value={overview.ordersToday} /> : null}
            {visibleCards.pending_orders ? <OwnerMetric label="Pedidos pendientes" value={overview.newOrders} /> : null}
            {visibleCards.customers_attention ? <OwnerMetric label="Clientes por atender" value={overview.pendingFollowups} /> : null}
            {visibleCards.low_inventory ? <OwnerMetric label="Productos sin stock" value={overview.outOfStockProducts} /> : null}
            {visibleCards.wholesale_requests ? <OwnerMetric label="Mayoristas pendientes" value={overview.pendingWholesaleRequests} /> : null}
            {visibleCards.pending_invoices ? <OwnerMetric label="Facturas pendientes" value={overview.pendingInvoices} /> : null}
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {adminModules
          .filter((module) => canAccessModule(profile.role, profile.permissions, module.permissions))
          .map((module) => (
            <Link
              key={module.title}
              href={module.href}
              className="rounded-lg border border-black/10 bg-white p-5 transition-colors hover:border-[#e4252c]"
            >
              <h2 className="font-semibold">{module.title}</h2>
              <p className="mt-2 text-sm text-black/55">{module.description}</p>
            </Link>
          ))}
      </div>
    </AdminShell>
  );
}

function OwnerMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-[#f4f4f5] p-3">
      <p className="text-xs font-medium uppercase text-black/45">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value.toLocaleString("es-HN")}</p>
    </div>
  );
}


