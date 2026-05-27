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

type AdminModule = {
  title: string;
  href: string;
  description: string;
  permissions: Permission[];
};

type AdminModuleGroup = {
  id: string;
  title: string;
  navLabel: string;
  description: string;
  defaultOpen: boolean;
  technicalOnly?: boolean;
  modules: AdminModule[];
};

const moduleGroups = [
  {
    id: "operacion",
    title: "Operación",
    navLabel: "Operación",
    description: "Pedidos, inventario y catálogo operativo.",
    defaultOpen: true,
    modules: [
      { title: "Pedidos", href: "/admin/pedidos", description: "Seguimiento de pedidos, pagos y facturación.", permissions: ["orders:read", "orders:manage"] },
      { title: "Inventario", href: "/admin/inventario", description: "Entradas, salidas, ajustes e inventario bajo.", permissions: ["inventory:manage"] },
      { title: "Productos", href: "/admin/productos", description: "Crear, editar, desactivar, importar y exportar productos.", permissions: ["products:manage"] },
    ],
  },
  {
    id: "ventas",
    title: "Ventas",
    navLabel: "Ventas",
    description: "Seguimiento de cobros, facturas y reportes.",
    defaultOpen: true,
    modules: [
      { title: "Pedidos por cobrar", href: "/admin/pedidos?task=pending_payments", description: "Pagos pendientes de confirmar.", permissions: ["orders:manage"] },
      { title: "Facturas pendientes", href: "/admin/facturas?task=pending_invoices", description: "Facturas listas para revisar o emitir.", permissions: ["invoices:read", "invoices:manage"] },
      { title: "Reportes", href: "/admin/reportes", description: "Reportes contables, filtros, Excel, CSV y PDF.", permissions: ["reports:read"] },
    ],
  },
  {
    id: "clientes",
    title: "Clientes",
    navLabel: "Clientes",
    description: "Relación comercial, mayoristas y CRM.",
    defaultOpen: true,
    modules: [
      { title: "Clientes", href: "/admin/clientes", description: "Clientes, notas y seguimiento comercial.", permissions: ["crm:manage", "customers:manage"] },
      { title: "Clientes mayoristas", href: "/admin/clientes-mayoristas", description: "Aprobar, rechazar, suspender y reactivar mayoristas.", permissions: ["customers:manage"] },
      { title: "CRM", href: "/admin/crm", description: "Seguimientos, oportunidades y atención vencida.", permissions: ["crm:manage", "customers:manage"] },
    ],
  },
  {
    id: "inventario",
    title: "Inventario",
    navLabel: "Inventario",
    description: "Accesos directos para control de stock.",
    defaultOpen: true,
    modules: [
      { title: "Inventario bajo", href: "/admin/inventario?filter=low_stock", description: "Productos bajo mínimo o sin stock.", permissions: ["inventory:manage"] },
      { title: "Movimientos", href: "/admin/inventario", description: "Entradas, salidas, devoluciones y ajustes.", permissions: ["inventory:manage"] },
      { title: "Catálogo", href: "/admin/productos", description: "Productos, precios y contenido del catálogo.", permissions: ["products:manage"] },
    ],
  },
  {
    id: "finanzas",
    title: "Finanzas",
    navLabel: "Finanzas",
    description: "Facturas, reportes y configuración fiscal.",
    defaultOpen: true,
    modules: [
      { title: "Facturas", href: "/admin/facturas", description: "Facturas fiscales, PDF, referencias y anulación.", permissions: ["invoices:read", "invoices:manage"] },
      { title: "Reportes", href: "/admin/reportes", description: "Reportes contables y exportaciones.", permissions: ["reports:read"] },
      { title: "Configuración fiscal", href: "/admin/configuracion-fiscal", description: "RTN, CAI, rango fiscal, fecha límite y datos legales.", permissions: ["fiscal:read", "settings:manage"] },
    ],
  },
  {
    id: "configuracion",
    title: "Administración",
    navLabel: "Configuración",
    description: "Ajustes empresariales y gobierno interno.",
    defaultOpen: false,
    modules: [
      { title: "Seguridad", href: "/admin/seguridad", description: "Usuarios, roles, permisos y auditoría.", permissions: ["settings:manage", "audit:read", "users:manage"] },
      { title: "Configuración empresarial", href: "/admin/configuracion", description: "Notificaciones, CRM, mayoristas, pedidos, inventario y contacto.", permissions: ["commercial_settings:manage", "settings:manage"] },
      { title: "Banners festivos", href: "/admin/banners", description: "Flyers, promociones y mensajes por días festivos de Honduras.", permissions: ["settings:manage", "commercial_settings:manage"] },
      { title: "Revisión BAC", href: "/admin/revision-bac", description: "Checklist web para pasarela BAC Credomatic.", permissions: ["commercial_settings:manage", "settings:manage"] },
    ],
  },
  {
    id: "soporte",
    title: "Soporte / Guía",
    navLabel: "Soporte / Guía",
    description: "Material operativo para resolver dudas rápido.",
    defaultOpen: false,
    modules: [
      { title: "Guía rápida", href: "/admin/guia", description: "Pasos diarios para productos, pedidos, CRM, facturas y BAC.", permissions: ["admin:access"] },
      { title: "Ayuda interna", href: "/admin/ayuda", description: "Manual operativo por rol para productos, pedidos, facturas, CRM y BAC.", permissions: ["admin:access"] },
    ],
  },
  {
    id: "tecnico",
    title: "Técnico",
    navLabel: "Técnico",
    description: "Monitoreo, cron, backups y alertas técnicas.",
    defaultOpen: false,
    technicalOnly: true,
    modules: [
      { title: "Uso y monitoreo", href: "/admin/uso", description: "Volumen de datos, logs antiguos, cron y referencias externas.", permissions: ["system:monitoring"] },
      { title: "Backups", href: "/admin/uso", description: "Estado operativo y controles de respaldo.", permissions: ["system:monitoring"] },
      { title: "Alertas técnicas", href: "/admin/uso", description: "Errores, notificaciones y monitoreo técnico.", permissions: ["system:monitoring"] },
    ],
  },
] satisfies AdminModuleGroup[];

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

  const metricGroups = [
    {
      title: "Ventas",
      metrics: [
        { label: "Hoy", value: formatCurrency(overview.salesToday), visible: visibleCards.sales_today },
        { label: "Mes", value: formatCurrency(overview.salesMonth), visible: visibleCards.sales_today },
      ],
    },
    {
      title: "Pedidos",
      metrics: [
        { label: "Hoy", value: overview.ordersToday.toLocaleString("es-HN"), visible: visibleCards.pending_orders },
        { label: "Nuevos", value: overview.newOrders.toLocaleString("es-HN"), visible: visibleCards.pending_orders },
        { label: "Por preparar", value: overview.ordersToPrepare.toLocaleString("es-HN"), visible: visibleCards.pending_orders },
      ],
    },
    {
      title: "Clientes",
      metrics: [
        { label: "Nuevos hoy", value: overview.newCustomersToday.toLocaleString("es-HN"), visible: visibleCards.customers_attention },
        { label: "Nuevos mes", value: overview.newCustomersMonth.toLocaleString("es-HN"), visible: visibleCards.customers_attention },
        { label: "Mayoristas", value: overview.pendingWholesaleRequests.toLocaleString("es-HN"), visible: visibleCards.wholesale_requests },
      ],
    },
    {
      title: "Inventario",
      metrics: [
        { label: "Sin stock", value: overview.outOfStockProducts.toLocaleString("es-HN"), visible: visibleCards.low_inventory },
        { label: "Bajo mínimo", value: overview.lowStockProducts.toLocaleString("es-HN"), visible: visibleCards.low_inventory },
      ],
    },
    {
      title: "CRM",
      metrics: [
        { label: "Vencido", value: overview.pendingFollowups.toLocaleString("es-HN"), visible: visibleCards.customers_attention },
      ],
    },
    {
      title: "Fiscal",
      metrics: [
        { label: "Facturas", value: overview.pendingInvoices.toLocaleString("es-HN"), visible: visibleCards.pending_invoices },
        { label: "Pagos", value: overview.pendingPayments.toLocaleString("es-HN"), visible: visibleCards.pending_payments },
      ],
    },
  ]
    .map((group) => ({ ...group, metrics: group.metrics.filter((metric) => metric.visible) }))
    .filter((group) => group.metrics.length > 0);

  const visibleModuleGroups = moduleGroups
    .map((group) => ({
      ...group,
      modules: group.technicalOnly && !canViewTechnical
        ? []
        : group.modules.filter((module) => canAccessModule(profile.role, profile.permissions, module.permissions)),
    }))
    .filter((group) => group.modules.length > 0);

  return (
    <AdminShell title="Panel administrativo">
      <div className="mb-4 grid gap-3 rounded-lg border border-black/10 bg-white p-3 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <p className="text-xs uppercase text-black/45">Sesión activa</p>
          <p className="font-semibold">{profile.full_name || profile.email}</p>
          <p className="text-sm capitalize text-black/55">Rol: {profile.role}</p>
        </div>
        <LogoutButton />
      </div>

      <nav className="sticky top-2 z-10 mb-4 overflow-x-auto rounded-lg border border-black/10 bg-white/95 p-2 shadow-sm backdrop-blur">
        <div className="flex min-w-max gap-2">
          {visibleModuleGroups.map((group) => (
            <a
              key={group.id}
              href={`#${group.id}`}
              className="rounded-md border border-black/10 px-3 py-2 text-sm font-semibold transition-colors hover:border-[#e4252c] hover:bg-[#fff1f2]"
            >
              {group.navLabel}
            </a>
          ))}
        </div>
      </nav>

      {fiscalAlerts.length > 0 ? (
        <div className="mb-4">
          <FiscalAlertsPanel alerts={fiscalAlerts} />
        </div>
      ) : null}

      <section className="mb-4 grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <div className="rounded-lg border border-black/10 bg-white p-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm text-black/50">Operación diaria</p>
              <h2 className="text-2xl font-semibold">Qué hacer hoy</h2>
            </div>
            <p className="text-sm text-black/55">{todayTasks.length.toLocaleString("es-HN")} accesos para tu rol</p>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
            {todayTasks.map((task) => (
              <Link
                key={task.label}
                href={task.href}
                className="rounded-md border border-black/10 bg-[#fafafa] p-3 transition-colors hover:border-[#e4252c]"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-semibold">{task.label}</p>
                  <span className="rounded-md bg-white px-2 py-0.5 text-sm font-semibold text-[#e4252c] shadow-sm">
                    {task.value.toLocaleString("es-HN")}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-black/55">{task.value > 0 ? "Requiere revisión operativa." : task.empty}</p>
              </Link>
            ))}
            {todayTasks.length === 0 ? (
              <div className="rounded-md border border-dashed border-black/15 bg-[#fafafa] p-3 text-sm text-black/55 md:col-span-2">
                No hay tarjetas operativas habilitadas para tu rol.
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border border-black/10 bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-black/50">Vista ejecutiva</p>
              <h2 className="text-2xl font-semibold">Resumen operativo</h2>
            </div>
            {visibleCards.bac_alerts ? <BacStatus status={businessSettings.bac_card_status} /> : null}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {metricGroups.map((group) => (
              <MetricGroup key={group.title} title={group.title} metrics={group.metrics} />
            ))}
          </div>
          {canViewTechnical && visibleCards.backup_cron_status ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
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

      <section className="space-y-3">
        {visibleModuleGroups.map((group) => (
          <ModuleGroup key={group.id} group={group} />
        ))}
      </section>
    </AdminShell>
  );
}

function MetricGroup({
  title,
  metrics,
}: {
  title: string;
  metrics: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="rounded-md border border-black/10 bg-[#fafafa] p-3">
      <p className="text-sm font-semibold">{title}</p>
      <div className="mt-2 grid gap-1">
        {metrics.map((metric) => (
          <div key={metric.label} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-black/55">{metric.label}</span>
            <span className="font-semibold">{metric.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BacStatus({ status }: { status: string }) {
  const label = status === "active" ? "BAC activo" : status === "pending" ? "BAC pendiente" : "BAC oculto";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(status)}`}>{label}</span>;
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
      <p className="mt-1 text-xs text-black/55">{detail}</p>
    </div>
  );
}

function ModuleGroup({ group }: { group: AdminModuleGroup }) {
  return (
    <details
      id={group.id}
      open={group.defaultOpen}
      className="scroll-mt-20 rounded-lg border border-black/10 bg-white p-4 open:shadow-sm"
    >
      <summary className="cursor-pointer list-none">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{group.title}</h2>
            <p className="text-sm text-black/55">{group.description}</p>
          </div>
          <span className="text-sm font-medium text-[#e4252c]">{group.modules.length.toLocaleString("es-HN")} módulos</span>
        </div>
      </summary>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {group.modules.map((module) => (
          <Link
            key={`${group.id}-${module.title}`}
            href={module.href}
            className="rounded-md border border-black/10 bg-[#fafafa] p-3 transition-colors hover:border-[#e4252c] hover:bg-[#fff1f2]"
          >
            <h3 className="font-semibold">{module.title}</h3>
            <p className="mt-1 text-sm leading-5 text-black/55">{module.description}</p>
          </Link>
        ))}
      </div>
    </details>
  );
}
