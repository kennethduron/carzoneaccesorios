import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  FileText,
  Headphones,
  Package,
  Receipt,
  Settings,
  ShieldCheck,
  ShoppingCart,
  UserPlus,
  Users,
  Wrench,
} from "lucide-react";
import {
  AdminDashboardFrame,
  type AdminDashboardNavSection,
  type AdminDashboardNotificationItem,
  type AdminDashboardSearchModule,
} from "@/components/admin/admin-dashboard-frame";
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
    title: "Operacion",
    navLabel: "Operacion",
    description: "Pedidos, inventario y catalogo operativo.",
    defaultOpen: true,
    modules: [
      { title: "Pedidos", href: "/admin/pedidos", description: "Seguimiento de pedidos, preparacion y estados.", permissions: ["orders:read", "orders:manage"] },
      { title: "Reservas por revisar", href: "/admin/pedidos?task=expired_reservations", description: "Reservas vencidas que necesitan decision humana.", permissions: ["reservations:review"] },
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
    description: "Relacion comercial, mayoristas y CRM.",
    defaultOpen: true,
    modules: [
      { title: "Clientes", href: "/admin/clientes", description: "Clientes, notas y seguimiento comercial.", permissions: ["crm:manage", "customers:manage"] },
      { title: "Clientes mayoristas", href: "/admin/clientes-mayoristas", description: "Aprobar, rechazar, suspender y reactivar mayoristas.", permissions: ["wholesale:manage"] },
      { title: "CRM", href: "/admin/crm", description: "Seguimientos, oportunidades y atencion vencida.", permissions: ["crm:manage", "customers:manage"] },
    ],
  },
  {
    id: "inventario",
    title: "Inventario",
    navLabel: "Inventario",
    description: "Accesos directos para control de stock.",
    defaultOpen: true,
    modules: [
      { title: "Inventario bajo", href: "/admin/inventario?filter=low_stock", description: "Productos bajo minimo o sin stock.", permissions: ["inventory:manage"] },
      { title: "Movimientos", href: "/admin/inventario", description: "Entradas, salidas, devoluciones y ajustes.", permissions: ["inventory:manage"] },
      { title: "Catalogo", href: "/admin/productos", description: "Productos, precios y contenido del catalogo.", permissions: ["products:manage"] },
    ],
  },
  {
    id: "finanzas",
    title: "Finanzas",
    navLabel: "Finanzas",
    description: "Facturas, reportes y configuracion fiscal.",
    defaultOpen: true,
    modules: [
      { title: "Cuentas por cobrar", href: "/admin/cuentas-por-cobrar", description: "Creditos abiertos, proximos a vencer y vencidos.", permissions: ["receivables:read"] },
      { title: "Facturas", href: "/admin/facturas", description: "Facturas fiscales, PDF, referencias y anulacion.", permissions: ["invoices:read", "invoices:manage"] },
      { title: "Reportes fiscales", href: "/admin/reportes?scope=fiscal", description: "Ventas facturadas, impuestos, facturas anuladas y correlativos.", permissions: ["reports:read", "reports:fiscal_read"] },
      { title: "Configuracion fiscal", href: "/admin/configuracion-fiscal", description: "RTN, CAI, rango fiscal, fecha limite y datos legales.", permissions: ["settings:fiscal", "fiscal:read"] },
    ],
  },
  {
    id: "configuracion",
    title: "Administracion",
    navLabel: "Configuracion",
    description: "Ajustes empresariales y gobierno interno.",
    defaultOpen: true,
    modules: [
      { title: "Seguridad", href: "/admin/seguridad", description: "Usuarios, roles, permisos y auditoria.", permissions: ["security:read"] },
      { title: "Configuracion empresarial", href: "/admin/configuracion", description: "Notificaciones, CRM, mayoristas, pedidos, inventario y contacto.", permissions: ["commercial_settings:manage", "settings:manage"] },
      { title: "Banners festivos", href: "/admin/banners", description: "Flyers, promociones y mensajes por dias festivos de Honduras.", permissions: ["settings:manage", "commercial_settings:manage"] },
      { title: "Tarjeta mediante enlace", href: "/admin/revision-bac", description: "Referencia operativa; el flujo activo usa un enlace externo enviado por WhatsApp.", permissions: ["commercial_settings:manage", "settings:manage"] },
    ],
  },
  {
    id: "soporte",
    title: "Soporte / Guia",
    navLabel: "Soporte / Guia",
    description: "Material operativo para resolver dudas rapido.",
    defaultOpen: false,
    modules: [
      { title: "Guia rapida", href: "/admin/guia", description: "Pasos diarios para productos, pedidos, CRM, facturas y pagos mediante enlace.", permissions: ["admin:access"] },
      { title: "Ayuda interna", href: "/admin/ayuda", description: "Manual operativo por rol para productos, pedidos, facturas, CRM y pagos mediante enlace.", permissions: ["admin:access"] },
    ],
  },
  {
    id: "tecnico",
    title: "Tecnico",
    navLabel: "Tecnico",
    description: "Monitoreo, tareas programadas, copias de seguridad y alertas tecnicas.",
    defaultOpen: true,
    technicalOnly: true,
    modules: [
      { title: "Uso y monitoreo", href: "/admin/uso", description: "Volumen de datos, logs antiguos, cron y referencias externas.", permissions: ["technical:tools"] },
      { title: "Copias de seguridad", href: "/admin/uso", description: "Estado operativo y controles de respaldo.", permissions: ["system:backups"] },
      { title: "Alertas tecnicas", href: "/admin/uso", description: "Errores, notificaciones y monitoreo tecnico.", permissions: ["technical:tools"] },
    ],
  },
] satisfies AdminModuleGroup[];

const dashboardGroupIcons: Record<string, LucideIcon> = {
  operacion: ClipboardList,
  ventas: ShoppingCart,
  clientes: Users,
  inventario: Package,
  finanzas: CircleDollarSign,
  configuracion: ShieldCheck,
  soporte: Headphones,
  tecnico: Wrench,
};

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
            <p className="text-xs uppercase text-black/45">Sesion activa</p>
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
            <MetricCard label="Fecha limite CAI" value={fiscalSettings?.emission_deadline ? formatDate(fiscalSettings.emission_deadline) : "Sin fecha"} />
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
            <p className="text-xs uppercase text-black/45">Sesion activa</p>
            <p className="font-semibold">{profile.full_name || profile.email}</p>
            <p className="text-sm capitalize text-black/55">Rol: {profile.role}</p>
          </div>
          <LogoutButton />
        </div>

        <section className="mb-4 rounded-lg border border-black/10 bg-white p-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm text-black/50">Vista logistica</p>
              <h2 className="text-2xl font-semibold">Inventario y preparacion</h2>
            </div>
            <p className="text-sm text-black/55">Sin pagos, facturacion, CRM ni seguridad</p>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <MetricCard label="Por preparar" value={warehouse.ordersToPrepare.toLocaleString("es-HN")} />
            <MetricCard label="En preparacion" value={warehouse.preparingOrders.toLocaleString("es-HN")} />
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
      empty: "Todavia no hay pedidos. Cuando un cliente compre, apareceran aqui.",
      permissions: ["orders:read", "orders:manage"],
      card: "pending_orders",
    },
    {
      label: "Preparar pedidos confirmados",
      value: overview.ordersToPrepare,
      href: "/admin/pedidos?task=to_prepare",
      empty: "No hay pedidos confirmados esperando preparacion.",
      permissions: ["orders:read", "orders:manage"],
      card: "pending_orders",
    },
    {
      label: "Confirmar pagos pendientes",
      value: overview.pendingPayments,
      href: "/admin/pedidos?task=pending_payments",
      empty: "No hay pagos esperando revision.",
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
      empty: "Inventario sin alertas criticas.",
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
        { label: "Bajo minimo", value: overview.lowStockProducts.toLocaleString("es-HN"), visible: visibleCards.low_inventory },
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

  const allVisibleModules = visibleModuleGroups.flatMap((group) => group.modules.map((module) => ({ ...module, groupId: group.id })));
  const groupVisible = (id: string) => visibleModuleGroups.some((group) => group.id === id);
  const moduleHref = (title: string) => allVisibleModules.find((module) => module.title === title)?.href;
  const firstName = profile.full_name?.split(" ")[0] || "Kenneth";
  const roleText = String(profile.role).replace(/_/g, " ");

  const navSections: AdminDashboardNavSection[] = [
    {
      title: "MODULOS PRINCIPALES",
      items: [
        { label: "Operacion", href: "#operacion", icon: "operation", visible: groupVisible("operacion") },
        { label: "Ventas", href: "#ventas", icon: "sales", visible: groupVisible("ventas") },
        { label: "Clientes", href: "#clientes", icon: "crm", visible: groupVisible("clientes") },
        { label: "Inventario", href: "#inventario", icon: "inventory", visible: groupVisible("inventario") },
        { label: "Finanzas", href: "#finanzas", icon: "finance", visible: groupVisible("finanzas") },
        { label: "Administracion", href: "#configuracion", icon: "settings", visible: groupVisible("configuracion") },
      ],
    },
    {
      title: "HERRAMIENTAS",
      items: [
        { label: "Soporte / Guia", href: "#soporte", icon: "support", visible: groupVisible("soporte") },
        { label: "Tecnico", href: "#tecnico", icon: "technical", visible: groupVisible("tecnico") },
      ],
    },
    {
      title: "SISTEMA",
      items: [
        { label: "Configuracion", href: moduleHref("Configuracion empresarial") ?? "#configuracion", icon: "settings", visible: Boolean(moduleHref("Configuracion empresarial")) },
        { label: "Seguridad", href: moduleHref("Seguridad") ?? "#configuracion", icon: "security", visible: Boolean(moduleHref("Seguridad")) },
        { label: "Reportes", href: moduleHref("Reportes") ?? moduleHref("Reportes fiscales") ?? "#ventas", icon: "reports", visible: Boolean(moduleHref("Reportes") ?? moduleHref("Reportes fiscales")) },
      ],
    },
  ];

  const kpiCards = [
    { label: "Ventas hoy", value: formatCurrency(overview.salesToday), detail: "0% vs ayer", href: "/admin/reportes", icon: Receipt, tone: "bg-[#fdecec] text-[#e4252c]", visible: visibleCards.sales_today && canAccessModule(profile.role, profile.email, profile.permissions, ["reports:read"]) },
    { label: "Pedidos hoy", value: overview.ordersToday.toLocaleString("es-HN"), detail: "0% vs ayer", href: "/admin/pedidos", icon: ClipboardList, tone: "bg-[#eaf2ff] text-[#2563eb]", visible: visibleCards.pending_orders && canAccessModule(profile.role, profile.email, profile.permissions, ["orders:read", "orders:manage"]) },
    { label: "Clientes nuevos (mes)", value: overview.newCustomersMonth.toLocaleString("es-HN"), detail: `${overview.newCustomersToday.toLocaleString("es-HN")} hoy`, href: "/admin/clientes", icon: UserPlus, tone: "bg-[#edf7ed] text-[#2f6f3e]", visible: visibleCards.customers_attention && canAccessModule(profile.role, profile.email, profile.permissions, ["crm:manage", "customers:manage"]) },
    { label: "Productos activos", value: "Sin dato", detail: "Sin consulta nueva", href: "/admin/productos", icon: Package, tone: "bg-[#f3e8ff] text-[#7c3aed]", visible: canAccessModule(profile.role, profile.email, profile.permissions, ["products:manage"]) },
    { label: "Stock bajo", value: overview.lowStockProducts.toLocaleString("es-HN"), detail: "Requieren atencion", href: "/admin/inventario?filter=low_stock", icon: AlertTriangle, tone: "bg-[#fff7ed] text-[#ea580c]", visible: visibleCards.low_inventory && canAccessModule(profile.role, profile.email, profile.permissions, ["inventory:manage"]) },
  ].filter((card) => card.visible);

  const quickLinks = ["Pedidos", "Facturas", "Productos", "Clientes", "Reportes"]
    .map((title) => allVisibleModules.find((module) => module.title === title))
    .filter(Boolean) as Array<AdminModule & { groupId: string }>;

  const activityItems = [
    { label: "Pedidos nuevos", value: overview.newOrders, href: "/admin/pedidos?task=new_orders", icon: ShoppingCart },
    { label: "Cliente nuevo registrado", value: overview.newCustomersToday, href: "/admin/clientes", icon: UserPlus },
    { label: "Factura pendiente", value: overview.pendingInvoices, href: "/admin/facturas?task=pending_invoices", icon: FileText },
    { label: "Inventario bajo", value: overview.lowStockProducts, href: "/admin/inventario?filter=low_stock", icon: Boxes },
  ];

  const groupTitleById = new Map(visibleModuleGroups.map((group) => [group.id, group.title]));
  const searchModules: AdminDashboardSearchModule[] = allVisibleModules.map((module) => ({
    title: module.title,
    href: module.href,
    description: module.description,
    groupTitle: groupTitleById.get(module.groupId) ?? "Admin",
  }));

  const notificationItems: AdminDashboardNotificationItem[] = [];
  const fiscalHref = moduleHref("Configuracion fiscal") ?? "/admin/configuracion-fiscal";
  const technicalHref = moduleHref("Uso y monitoreo") ?? "/admin/uso";
  const addNotification = (condition: boolean, item: AdminDashboardNotificationItem) => {
    if (condition) notificationItems.push(item);
  };
  const isProblemStatus = (status: string | null) => Boolean(status && !["success", "ok", "active"].includes(status));

  fiscalAlerts.forEach((alert, index) => {
    notificationItems.push({
      id: `fiscal-${index}`,
      title: alert.type === "danger" ? "Alerta fiscal critica" : "Alerta fiscal",
      detail: alert.message,
      href: fiscalHref,
      tone: alert.type === "danger" ? "danger" : "warning",
    });
  });

  addNotification(overview.newOrders > 0, {
    id: "new-orders",
    title: "Pedidos nuevos",
    detail: `${overview.newOrders.toLocaleString("es-HN")} pedidos requieren revision.`,
    href: "/admin/pedidos?task=new_orders",
    tone: "info",
  });
  addNotification(overview.pendingPayments > 0, {
    id: "pending-payments",
    title: "Pagos pendientes",
    detail: `${overview.pendingPayments.toLocaleString("es-HN")} pagos esperan confirmacion.`,
    href: moduleHref("Pedidos por cobrar") ?? "/admin/pedidos?task=pending_payments",
    tone: "warning",
  });
  addNotification(overview.lowStockProducts > 0, {
    id: "low-stock",
    title: "Inventario bajo",
    detail: `${overview.lowStockProducts.toLocaleString("es-HN")} productos requieren atencion.`,
    href: "/admin/inventario?filter=low_stock",
    tone: "warning",
  });
  addNotification(overview.pendingFollowups > 0, {
    id: "crm-overdue",
    title: "CRM vencido",
    detail: `${overview.pendingFollowups.toLocaleString("es-HN")} seguimientos vencidos.`,
    href: "/admin/crm?task=overdue",
    tone: "warning",
  });
  addNotification(overview.pendingInvoices > 0, {
    id: "pending-invoices",
    title: "Facturas pendientes",
    detail: `${overview.pendingInvoices.toLocaleString("es-HN")} facturas pendientes de revision.`,
    href: "/admin/facturas?task=pending_invoices",
    tone: "warning",
  });
  addNotification(overview.failedEmails > 0, {
    id: "failed-emails",
    title: "Correos fallidos",
    detail: `${overview.failedEmails.toLocaleString("es-HN")} correos en estado failed.`,
    href: canViewTechnical ? technicalHref : moduleHref("Configuracion empresarial") ?? "/admin/configuracion",
    tone: "danger",
  });
  addNotification(canViewTechnical && visibleCards.backup_cron_status && isProblemStatus(overview.latestBackupStatus), {
    id: "backup-status",
    title: "Backups requieren revision",
    detail: `Ultimo estado: ${overview.latestBackupStatus ?? "sin registro"}.`,
    href: technicalHref,
    tone: "danger",
  });
  addNotification(canViewTechnical && visibleCards.backup_cron_status && isProblemStatus(overview.latestCronStatus), {
    id: "cron-status",
    title: "Tarea tecnica con alerta",
    detail: overview.latestCronJob ? `${overview.latestCronJob}: ${overview.latestCronStatus}` : `Estado: ${overview.latestCronStatus}`,
    href: technicalHref,
    tone: "danger",
  });

  return (
    <AdminShell title="Panel administrativo" variant="dashboard">
      <AdminDashboardFrame
        navSections={navSections}
        searchModules={searchModules}
        notifications={notificationItems}
        profileLabel={profile.email ?? profile.full_name ?? "Usuario"}
        roleText={roleText}
        avatarLetter={(profile.full_name || profile.email || "K").slice(0, 1).toUpperCase()}
        logoutSlot={<LogoutButton />}
      >
        <main className="mx-auto w-full max-w-[1680px] px-3 py-4 sm:px-5 lg:px-6">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm text-black/55">Este es el resumen general de tu sistema.</p>
              <h1 className="text-xl font-semibold tracking-normal sm:text-2xl">Bienvenido de vuelta, {firstName}!</h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link href="/admin/guia" className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold shadow-sm transition-colors hover:border-[#e4252c] hover:text-[#e4252c]">Accesos rapidos <ChevronDown size={15} /></Link>
              {moduleHref("Configuracion empresarial") ? <Link href={moduleHref("Configuracion empresarial") ?? "/admin/configuracion"} className="inline-flex size-10 items-center justify-center rounded-md border border-black/10 bg-white shadow-sm transition-colors hover:border-[#e4252c] hover:text-[#e4252c]" aria-label="Configuracion"><Settings size={17} /></Link> : null}
            </div>
          </div>

          {fiscalAlerts.length > 0 ? <div className="mb-4"><FiscalAlertsPanel alerts={fiscalAlerts} /></div> : null}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px] 2xl:grid-cols-[minmax(0,1fr)_340px]">
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:col-span-2 2xl:grid-cols-5" aria-label="Indicadores principales">
              {kpiCards.map((card) => <KpiCard key={card.label} {...card} />)}
            </section>

            <section className="rounded-lg border border-black/10 bg-white p-3 shadow-sm sm:p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div><h2 className="text-base font-semibold">Operacion diaria</h2><p className="text-xs text-black/50">{todayTasks.length.toLocaleString("es-HN")} accesos para tu rol</p></div>
                <a href="#modulos" className="text-xs font-semibold text-[#e4252c] hover:text-[#b91c25]">Ver todos</a>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 min-[1500px]:grid-cols-3 2xl:grid-cols-4">
                {todayTasks.map((task) => <TaskCard key={task.label} task={task} />)}
                {todayTasks.length === 0 ? <div className="rounded-md border border-dashed border-black/15 bg-[#fafafa] p-3 text-sm text-black/55 sm:col-span-2">No hay tarjetas operativas habilitadas para tu rol.</div> : null}
              </div>
            </section>

            <section className="rounded-lg border border-black/10 bg-white p-3 shadow-sm sm:p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div><h2 className="text-base font-semibold">Resumen operativo</h2><p className="text-xs text-black/50">Indicadores actuales</p></div>
                {visibleCards.bac_alerts ? <BacStatus status={businessSettings.bac_card_status} /> : null}
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                {metricGroups.map((group) => <MetricGroup key={group.title} title={group.title} metrics={group.metrics} />)}
              </div>
            </section>

            <aside className="space-y-4 xl:row-span-3">
              <section className="rounded-lg border border-black/10 bg-white p-3 shadow-sm sm:p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div><h2 className="text-base font-semibold">Estado del sistema</h2><p className="text-xs text-black/50">Ultima verificacion: hace 2 min</p></div>
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${statusTone(fiscalAlerts.length > 0 || overview.failedEmails > 0 ? "risk" : "success")}`}><CheckCircle2 size={14} />{fiscalAlerts.length > 0 || overview.failedEmails > 0 ? "Revisar" : "Todo bien"}</span>
                </div>
                <div className="space-y-2">
                  <StatusRow label="Fiscal" value={`${fiscalAlerts.length.toLocaleString("es-HN")} alertas`} status={fiscalAlerts.length > 0 ? "risk" : "success"} />
                  <StatusRow label="Correos" value={`${overview.failedEmails.toLocaleString("es-HN")} failed`} status={overview.failedEmails > 0 ? "failed" : "success"} />
                  {canViewTechnical && visibleCards.backup_cron_status ? <><StatusRow label="Cron" value={overview.latestCronJob ? `${overview.latestCronJob}` : "Sin registro"} status={overview.latestCronStatus} /><StatusRow label="Backups" value={formatDate(overview.latestBackupAt)} status={overview.latestBackupStatus} /></> : null}
                </div>
              </section>
              {canViewNotificationSummary ? <AdminNotificationStatusCard /> : null}
              <section className="rounded-lg border border-black/10 bg-white p-3 shadow-sm sm:p-4">
                <h2 className="text-base font-semibold">Accesos frecuentes</h2>
                <div className="mt-3 space-y-2">
                  {quickLinks.map((module) => <Link key={`${module.groupId}-${module.title}`} href={module.href} className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-[#fff1f2]"><span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-[#fff1f2] text-[#e4252c]"><ModuleIcon groupId={module.groupId} /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{module.title}</span><span className="block truncate text-xs text-black/50">{module.description}</span></span></Link>)}
                </div>
              </section>
              <section className="rounded-lg border border-black/10 bg-white p-3 shadow-sm sm:p-4">
                <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">Actividad reciente</h2><Link href="/admin/reportes" className="text-xs font-semibold text-[#e4252c]">Ver todos</Link></div>
                <div className="mt-3 space-y-2">{activityItems.map((item) => <ActivityItem key={item.label} {...item} />)}</div>
              </section>
            </aside>

            <section id="modulos" className="scroll-mt-24 rounded-lg border border-black/10 bg-white p-3 shadow-sm sm:p-4">
              <div className="mb-3 flex items-center justify-between gap-3"><div><h2 className="text-base font-semibold">Modulos del sistema</h2><p className="text-xs text-black/50">Todos los accesos visibles respetan tu rol.</p></div><span className="text-xs font-semibold text-[#e4252c]">{allVisibleModules.length.toLocaleString("es-HN")} accesos</span></div>
              <div className="grid gap-2 sm:grid-cols-2 min-[1500px]:grid-cols-3 2xl:grid-cols-4">{visibleModuleGroups.map((group) => <ModuleCategoryCard key={group.id} group={group} />)}</div>
            </section>
          </div>
        </main>

        <footer className="mx-auto flex w-full max-w-[1680px] flex-col gap-2 px-3 pb-5 pt-2 text-xs text-black/45 sm:px-5 lg:px-6 md:flex-row md:items-center md:justify-between"><span>© 2026 CarZone Accesorios. Todos los derechos reservados.</span><span>Version 2.0.0</span></footer>
      </AdminDashboardFrame>
    </AdminShell>
  );
}

function KpiCard({ label, value, detail, href, icon: Icon, tone }: { label: string; value: string; detail: string; href: string; icon: LucideIcon; tone: string }) {
  return (
    <Link href={href} className="group min-w-0 rounded-lg border border-black/10 bg-white p-3 shadow-sm transition-colors hover:border-[#e4252c]">
      <div className="flex items-start gap-3">
        <span className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full ${tone}`}><Icon size={18} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-black/65">{label}</span>
          <span className="mt-1 block break-words text-lg font-semibold leading-tight">{value}</span>
          <span className="mt-1 block truncate text-xs text-black/45">{detail}</span>
        </span>
      </div>
      <div className="mt-2 h-6 overflow-hidden text-[#e4252c] opacity-80">
        <svg viewBox="0 0 100 24" aria-hidden="true" className="h-6 w-full"><path d="M4 18 C 22 20, 25 9, 39 13 S 61 25, 73 9 S 87 3, 96 6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
      </div>
    </Link>
  );
}

function TaskCard({ task }: { task: { label: string; value: number; href: string; empty: string; icon?: LucideIcon } }) {
  const Icon = task.icon ?? ClipboardList;
  return (
    <Link href={task.href} className="group rounded-md border border-black/10 bg-[#fafafa] p-3 transition-colors hover:border-[#e4252c] hover:bg-white">
      <div className="flex items-start justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-2"><span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-white text-[#e4252c] shadow-sm"><Icon size={15} /></span><span className="line-clamp-2 text-xs font-semibold leading-4">{task.label}</span></span>
        <ChevronRight size={14} className="shrink-0 text-black/30 transition-transform group-hover:translate-x-0.5" />
      </div>
      <p className="mt-3 text-xl font-semibold leading-none">{task.value.toLocaleString("es-HN")}</p>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-black/55">{task.empty}</p>
    </Link>
  );
}

function StatusRow({ label, value, status }: { label: string; value: string; status: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-black/10 bg-[#fafafa] px-3 py-2">
      <span className="min-w-0 text-sm font-semibold">{label}</span>
      <span className={`min-w-0 truncate rounded-full px-2 py-1 text-xs font-semibold ${statusTone(status)}`}>{value}</span>
    </div>
  );
}

function ActivityItem({ label, value, href, icon: Icon }: { label: string; value: number; href: string; icon: LucideIcon }) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-[#fafafa]">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-[#fff1f2] text-[#e4252c]"><Icon size={16} /></span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{label}</span><span className="block text-xs text-black/50">{value.toLocaleString("es-HN")} pendientes</span></span>
    </Link>
  );
}

function ModuleCategoryCard({ group }: { group: AdminModuleGroup }) {
  const Icon = dashboardGroupIcons[group.id] ?? ClipboardList;
  return (
    <details id={group.id} open={group.defaultOpen} className="scroll-mt-24 rounded-md border border-black/10 bg-[#fafafa] p-3 open:bg-white">
      <summary className="cursor-pointer list-none">
        <div className="flex items-start gap-3">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-white text-[#e4252c] shadow-sm"><Icon size={17} /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{group.title}</span><span className="mt-1 line-clamp-2 text-xs leading-5 text-black/55">{group.description}</span><span className="mt-2 block text-xs font-semibold text-black/45">{group.modules.length.toLocaleString("es-HN")} modulos</span></span>
          <ChevronDown size={15} className="mt-1 shrink-0 text-black/35" />
        </div>
      </summary>
      <div className="mt-3 space-y-1 border-t border-black/10 pt-2">
        {group.modules.map((module) => <Link key={`${group.id}-${module.title}`} href={module.href} className="flex items-center justify-between gap-2 rounded-md px-2 py-2 text-xs font-semibold text-black/70 transition-colors hover:bg-[#fff1f2] hover:text-[#e4252c]"><span className="min-w-0 truncate">{module.title}</span><ChevronRight size={13} className="shrink-0" /></Link>)}
      </div>
    </details>
  );
}

function ModuleIcon({ groupId }: { groupId: string }) {
  const Icon = dashboardGroupIcons[groupId] ?? ChevronRight;
  return <Icon size={16} />;
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
        {value > 0 ? "Requiere revision logistica." : "Sin pendientes para este bloque."}
      </p>
    </Link>
  );
}

function BacStatus({ status }: { status: string }) {
  const label = status === "active" ? "Link activo" : status === "pending" ? "Link manual" : "Link oculto";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(status)}`}>{label}</span>;
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
          <span className="text-sm font-medium text-[#e4252c]">{group.modules.length.toLocaleString("es-HN")} modulos</span>
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
