import Link from "next/link";
import { AdminNotificationStatusCard } from "@/components/admin/admin-notification-status-card";
import { AdminShell } from "@/components/admin/admin-shell";
import { FiscalAlertsPanel } from "@/components/admin/fiscal-alerts-panel";
import { LogoutButton } from "@/components/auth";
import { hasEffectivePermission, isTechnicalOwner } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getAdminBusinessSettings } from "@/services/supabase/admin-business-settings.service";
import { getAdminDashboardOverview, getWarehouseDashboardOverview } from "@/services/supabase/admin-dashboard.service";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { getAdminInvoices } from "@/services/supabase/admin-invoices.service";
import type { AppRole, Permission } from "@/types/auth";
import type { DashboardCardKey } from "@/types/settings";
import { getFiscalAlerts, invoiceNumberValue } from "@/utils/fiscal";
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
      { title: "Pedidos", href: "/admin/pedidos", description: "Seguimiento de pedidos, preparación y estados.", permissions: ["orders:read", "orders:manage"] },
      { title: "Reservas por revisar", href: "/admin/pedidos?task=expired_reservations", description: "Reservas vencidas que necesitan decisión humana.", permissions: ["reservations:review"] },
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
      { title: "Pedidos por cobrar", href: "/admin/pedidos?task=pending_payments", description: "Pagos pendientes de confirmar.", permissions: ["payments:confirm", "payments:manage"] },
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
      { title: "Clientes mayoristas", href: "/admin/clientes-mayoristas", description: "Aprobar, rechazar, suspender y reactivar mayoristas.", permissions: ["wholesale:manage"] },
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
      { title: "Cuentas por cobrar", href: "/admin/cuentas-por-cobrar", description: "Créditos abiertos, próximos a vencer y vencidos.", permissions: ["receivables:read"] },
      { title: "Facturas", href: "/admin/facturas", description: "Facturas fiscales, PDF, referencias y anulación.", permissions: ["invoices:read", "invoices:manage"] },
      { title: "Reportes fiscales", href: "/admin/reportes?scope=fiscal", description: "Ventas facturadas, impuestos, facturas anuladas y correlativos.", permissions: ["reports:read", "reports:fiscal_read"] },
      { title: "Configuración fiscal", href: "/admin/configuracion-fiscal", description: "RTN, CAI, rango fiscal, fecha límite y datos legales.", permissions: ["settings:fiscal", "fiscal:read"] },
    ],
  },
  {
    id: "configuracion",
    title: "Administración",
    navLabel: "Configuración",
    description: "Ajustes empresariales y gobierno interno.",
    defaultOpen: true,
    modules: [
      { title: "Seguridad", href: "/admin/seguridad", description: "Usuarios, roles, permisos y auditoría.", permissions: ["security:read"] },
      { title: "Configuración empresarial", href: "/admin/configuracion", description: "Notificaciones, CRM, mayoristas, pedidos, inventario y contacto.", permissions: ["commercial_settings:manage", "settings:manage"] },
      { title: "Banners festivos", href: "/admin/banners", description: "Flyers, promociones y mensajes por días festivos de Honduras.", permissions: ["settings:manage", "commercial_settings:manage"] },
      { title: "Tarjeta mediante enlace", href: "/admin/revision-bac", description: "Referencia operativa; el flujo activo usa un enlace externo enviado por WhatsApp.", permissions: ["commercial_settings:manage", "settings:manage"] },
    ],
  },
  {
    id: "soporte",
    title: "Soporte / Guía",
    navLabel: "Soporte / Guía",
    description: "Material operativo para resolver dudas rápido.",
    defaultOpen: false,
    modules: [
      { title: "Guía rápida", href: "/admin/guia", description: "Pasos diarios para productos, pedidos, CRM, facturas y pagos mediante enlace.", permissions: ["admin:access"] },
      { title: "Ayuda interna", href: "/admin/ayuda", description: "Manual operativo por rol para productos, pedidos, facturas, CRM y pagos mediante enlace.", permissions: ["admin:access"] },
    ],
  },
  {
    id: "tecnico",
    title: "Técnico",
    navLabel: "Técnico",
    description: "Monitoreo, tareas programadas, copias de seguridad y alertas técnicas.",
    defaultOpen: true,
    technicalOnly: true,
    modules: [
      { title: "Uso y monitoreo", href: "/admin/uso", description: "Volumen de datos, logs antiguos, cron y referencias externas.", permissions: ["technical:tools"] },
      { title: "Copias de seguridad", href: "/admin/uso", description: "Estado operativo y controles de respaldo.", permissions: ["system:backups"] },
      { title: "Alertas técnicas", href: "/admin/uso", description: "Errores, notificaciones y monitoreo técnico.", permissions: ["technical:tools"] },
    ],
  },
] satisfies AdminModuleGroup[];

function canAccessModule(role: AppRole, email: string | null, permissions: Permission[], modulePermissions: Permission[]) {
  if (isTechnicalOwner(role, email)) {
    return true;
  }

  if (modulePermissions.includes("admin:access")) {
    return role === "admin" || permissions.includes("admin:access");
  }

  return modulePermissions.some((permission) => permissions.includes(permission));
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

function hnDateKey(value: string | Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(new Date(value));
}

function hnMonthKey(value: string | Date) {
  return hnDateKey(value).slice(0, 7);
}

export default async function AdminPage() {
  const profile = await requirePermission("admin:access");
  const isAccountant = profile.role === "contadora" && !isTechnicalOwner(profile.role, profile.email);
  const isWarehouse = profile.role === "bodega" && !isTechnicalOwner(profile.role, profile.email);
  const canViewNotificationSummary = ["technical_owner", "business_owner", "admin"].includes(profile.role);
  const canViewTechnical = hasEffectivePermission(profile.role, profile.permissions, "technical:tools", profile.email);
  const canViewFiscalAlerts =
    hasEffectivePermission(profile.role, profile.permissions, "fiscal:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "invoices:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "reports:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "reports:fiscal_read", profile.email);
  const canReadInvoices = hasEffectivePermission(profile.role, profile.permissions, "invoices:read", profile.email);
  const [fiscalSettings, invoices] = canViewFiscalAlerts
    ? await Promise.all([getFiscalSettings(), canReadInvoices ? getAdminInvoices() : Promise.resolve([])])
    : [null, []];
  const fiscalAlerts = fiscalSettings ? getFiscalAlerts(fiscalSettings, invoices) : [];

  if (isAccountant) {
    const todayKey = hnDateKey(new Date());
    const monthKey = hnMonthKey(new Date());
    const activeInvoices = invoices.filter((invoice) => !["anulada", "cancelled"].includes(String(invoice.status)));
    const cancelledInvoices = invoices.filter((invoice) => ["anulada", "cancelled"].includes(String(invoice.status)));
    const issuedToday = activeInvoices.filter((invoice) => hnDateKey(invoice.issued_at ?? invoice.created_at) === todayKey);
    const issuedMonth = activeInvoices.filter((invoice) => hnMonthKey(invoice.issued_at ?? invoice.created_at) === monthKey);
    const rangeEnd = invoiceNumberValue(fiscalSettings?.invoice_range_end ?? "");
    const currentNumber = invoiceNumberValue(fiscalSettings?.current_invoice_number ?? "");
    const availableInvoices = rangeEnd !== null && currentNumber !== null ? Math.max(rangeEnd - currentNumber + 1, 0) : null;
    const visibleModuleGroups = moduleGroups
      .filter((group) => group.id === "finanzas")
      .map((group) => ({
        ...group,
        modules: group.modules.filter((module) => canAccessModule(profile.role, profile.email, profile.permissions, module.permissions)),
      }))
      .filter((group) => group.modules.length > 0);

    return (
      <AdminShell title="Panel contable">
        <div className="mb-4 grid gap-3 rounded-lg border border-black/10 bg-white p-3 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <p className="text-xs uppercase text-black/45">Sesión activa</p>
            <p className="font-semibold">{profile.full_name || profile.email}</p>
            <p className="text-sm capitalize text-black/55">Rol: {profile.role}</p>
          </div>
          <LogoutButton />
        </div>

        {fiscalAlerts.length > 0 ? (
          <div className="mb-4">
            <FiscalAlertsPanel alerts={fiscalAlerts} />
          </div>
        ) : null}

        <section className="mb-4 rounded-lg border border-black/10 bg-white p-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm text-black/50">Vista fiscal</p>
              <h2 className="text-2xl font-semibold">Resumen contable</h2>
            </div>
            <p className="text-sm text-black/55">Facturas, CAI, rango fiscal y reportes</p>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Facturas emitidas hoy" value={issuedToday.length.toLocaleString("es-HN")} />
            <MetricCard label="Facturas anuladas" value={cancelledInvoices.length.toLocaleString("es-HN")} />
            <MetricCard label="Facturas del mes" value={issuedMonth.length.toLocaleString("es-HN")} />
            <MetricCard label="Facturas disponibles" value={availableInvoices === null ? "Sin rango" : availableInvoices.toLocaleString("es-HN")} />
            <MetricCard label="CAI vigente" value={fiscalSettings?.cai || "Sin CAI"} />
            <MetricCard label="Rango fiscal" value={fiscalSettings ? `${fiscalSettings.invoice_range_start} a ${fiscalSettings.invoice_range_end}` : "Sin rango"} />
            <MetricCard label="Correlativo actual" value={fiscalSettings?.current_invoice_number || "Sin correlativo"} />
            <MetricCard label="Fecha límite CAI" value={fiscalSettings?.emission_deadline ? formatDate(fiscalSettings.emission_deadline) : "Sin fecha"} />
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

  if (isWarehouse) {
    const warehouse = await getWarehouseDashboardOverview();
    const visibleModuleGroups = moduleGroups
      .filter((group) => ["operacion", "inventario"].includes(group.id))
      .map((group) => ({
        ...group,
        modules: group.modules.filter((module) => canAccessModule(profile.role, profile.email, profile.permissions, module.permissions)),
      }))
      .filter((group) => group.modules.length > 0);

    return (
      <AdminShell title="Panel de bodega">
        <div className="mb-4 grid gap-3 rounded-lg border border-black/10 bg-white p-3 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <p className="text-xs uppercase text-black/45">Sesión activa</p>
            <p className="font-semibold">{profile.full_name || profile.email}</p>
            <p className="text-sm capitalize text-black/55">Rol: {profile.role}</p>
          </div>
          <LogoutButton />
        </div>

        <section className="mb-4 rounded-lg border border-black/10 bg-white p-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm text-black/50">Vista logística</p>
              <h2 className="text-2xl font-semibold">Inventario y preparación</h2>
            </div>
            <p className="text-sm text-black/55">Sin pagos, facturación, CRM ni seguridad</p>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <MetricCard label="Por preparar" value={warehouse.ordersToPrepare.toLocaleString("es-HN")} />
            <MetricCard label="En preparación" value={warehouse.preparingOrders.toLocaleString("es-HN")} />
            <MetricCard label="Empacados" value={warehouse.packedOrders.toLocaleString("es-HN")} />
            <MetricCard label="Enviados" value={warehouse.shippedOrders.toLocaleString("es-HN")} />
            <MetricCard label="En ruta" value={warehouse.routeOrders.toLocaleString("es-HN")} />
            <MetricCard label="Stock bajo" value={warehouse.lowStockProducts.toLocaleString("es-HN")} />
            <MetricCard label="Agotados" value={warehouse.outOfStockProducts.toLocaleString("es-HN")} />
            <MetricCard label="Reservas activas" value={warehouse.activeReservations.toLocaleString("es-HN")} />
            <MetricCard label="Reservas por revisar" value={warehouse.expiredReservations.toLocaleString("es-HN")} />
            <MetricCard label="Movimientos 24h" value={warehouse.recentInventoryMovements.toLocaleString("es-HN")} />
          </div>
        </section>

        <section className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <WarehouseTask href="/admin/pedidos?task=to_prepare" label="Pedidos por preparar" value={warehouse.ordersToPrepare} />
          <WarehouseTask href="/admin/inventario?filter=low_stock" label="Stock bajo / agotado" value={warehouse.lowStockProducts + warehouse.outOfStockProducts} />
          <WarehouseTask href="/admin/pedidos?task=expired_reservations" label="Reservas a revisar" value={warehouse.expiredReservations} />
          <WarehouseTask href="/admin/inventario" label="Movimientos recientes" value={warehouse.recentInventoryMovements} />
        </section>

        <section className="space-y-3">
          {visibleModuleGroups.map((group) => (
            <ModuleGroup key={group.id} group={group} />
          ))}
        </section>
      </AdminShell>
    );
  }

  const [overview, businessSettings] = await Promise.all([getAdminDashboardOverview(), getAdminBusinessSettings()]);
  const visibleCards = businessSettings.dashboard_cards;

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
      permissions: ["payments:confirm", "payments:manage"],
      card: "pending_payments",
    },
    {
      label: "Revisar reservas vencidas",
      value: overview.expiredReservations,
      href: "/admin/pedidos?task=expired_reservations",
      empty: "No hay reservas vencidas por revisar.",
      permissions: ["reservations:review"],
      card: "pending_orders",
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
      permissions: ["wholesale:manage"],
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
  const todayTasks = todayTaskOptions.filter((task) => visibleCards[task.card] && canAccessModule(profile.role, profile.email, profile.permissions, task.permissions));

  const metricPermissions: Record<string, Permission[]> = {
    Ventas: ["reports:read"],
    Pedidos: ["orders:read", "orders:manage"],
    Clientes: ["crm:manage", "customers:read"],
    Inventario: ["inventory:manage"],
    CRM: ["crm:manage"],
    Fiscal: ["invoices:read", "payments:read", "payments:manage"],
  };
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
        {
          label: "Mayoristas",
          value: overview.pendingWholesaleRequests.toLocaleString("es-HN"),
          visible:
            visibleCards.wholesale_requests &&
            hasEffectivePermission(profile.role, profile.permissions, "wholesale:manage", profile.email),
        },
      ],
    },
    {
      title: "Inventario",
      metrics: [
        { label: "Sin stock", value: overview.outOfStockProducts.toLocaleString("es-HN"), visible: visibleCards.low_inventory },
        { label: "Bajo mínimo", value: overview.lowStockProducts.toLocaleString("es-HN"), visible: visibleCards.low_inventory },
        { label: "Reservas vencidas", value: overview.expiredReservations.toLocaleString("es-HN"), visible: visibleCards.low_inventory },
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
    .map((group) => ({
      ...group,
      metrics: group.metrics.filter((metric) =>
        metric.visible && canAccessModule(profile.role, profile.email, profile.permissions, metricPermissions[group.title] ?? [])),
    }))
    .filter((group) => group.metrics.length > 0);

  const visibleModuleGroups = moduleGroups
    .map((group) => ({
      ...group,
      modules: group.technicalOnly && !canViewTechnical
        ? []
        : group.modules.filter((module) => canAccessModule(profile.role, profile.email, profile.permissions, module.permissions)),
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

      {canViewNotificationSummary ? <AdminNotificationStatusCard /> : null}

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
              <OperationalStatus
                label="Correos electrónicos fallidos"
                status={overview.failedEmails > 0 ? "failed" : "success"}
                detail={`${overview.failedEmails.toLocaleString("es-HN")} correos en estado failed`}
              />
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

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-black/10 bg-[#fafafa] p-3">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 break-words text-xl font-semibold">{value}</p>
    </div>
  );
}

function WarehouseTask({ href, label, value }: { href: string; label: string; value: number }) {
  return (
    <Link href={href} className="rounded-md border border-black/10 bg-white p-3 transition-colors hover:border-[#e4252c]">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold">{label}</p>
        <span className="rounded-md bg-[#fff1f2] px-2 py-0.5 text-sm font-semibold text-[#e4252c]">
          {value.toLocaleString("es-HN")}
        </span>
      </div>
      <p className="mt-1 text-xs leading-5 text-black/55">
        {value > 0 ? "Requiere revisión logística." : "Sin pendientes para este bloque."}
      </p>
    </Link>
  );
}

function BacStatus({ status }: { status: string }) {
  const label = status === "active" ? "Link activo" : status === "pending" ? "Link manual" : "Link oculto";
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
