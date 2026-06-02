import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";
import type { AppRole, AuthProfile, Permission } from "@/types/auth";

export const dynamic = "force-dynamic";

type ScopedSection = {
  role: string;
  roles: AppRole[];
  focus: string;
  items: string[];
};

type ScopedWorkflow = {
  title: string;
  href: string;
  permissions: Permission[];
  steps: string[];
};

const roleSections: ScopedSection[] = [
  {
    role: "Dueno / Administracion",
    roles: ["technical_owner", "business_owner", "admin"],
    focus: "Ver salud diaria del negocio y tomar decisiones segun permisos.",
    items: [
      "Revisar ventas de hoy y del mes en el panel principal.",
      "Entrar a Pedidos para pendientes, pagos y preparacion.",
      "Revisar Reportes para comportamiento de ventas e inventario.",
      "Aprobar o rechazar solicitudes mayoristas con criterio comercial.",
    ],
  },
  {
    role: "Vendedor / Soporte",
    roles: ["vendedor", "soporte"],
    focus: "Atender clientes, dar seguimiento y ordenar el CRM.",
    items: [
      "Crear o actualizar clientes desde Clientes.",
      "Agregar notas con acuerdos, dudas, llamadas o informacion importante.",
      "Crear seguimientos con fecha y prioridad.",
      "Cerrar seguimientos cuando el contacto ya se realizo.",
    ],
  },
  {
    role: "Bodega",
    roles: ["bodega"],
    focus: "Mantener inventario confiable y preparar pedidos.",
    items: [
      "Buscar producto por SKU, codigo o nombre antes de cargar movimiento.",
      "Registrar entradas cuando se recibe mercaderia fisica.",
      "Usar ajustes solo para correcciones reales despues de conteo.",
      "Revisar productos sin stock, bajo minimo y reservas activas.",
      "Actualizar estado logistico cuando el pedido este preparado o despachado.",
    ],
  },
  {
    role: "Contadora",
    roles: ["contadora"],
    focus: "Revisar facturas, CAI, correlativos y reportes fiscales.",
    items: [
      "Revisar facturas fiscales emitidas y anuladas.",
      "Exportar reportes fiscales y contables permitidos.",
      "Vigilar CAI, rango fiscal, correlativo actual y vencimiento.",
      "Atender alertas de factura anulada, error fiscal o rango bajo.",
    ],
  },
];

const workflows: ScopedWorkflow[] = [
  {
    title: "Crear productos",
    href: "/admin/productos",
    permissions: ["products:manage"],
    steps: ["Completa SKU y nombre.", "Asigna categoria y precios.", "Agrega compatibilidad si aplica.", "Activa solo productos listos para vender."],
  },
  {
    title: "Cargar inventario",
    href: "/admin/inventario",
    permissions: ["inventory:manage"],
    steps: ["Busca el producto.", "Elige entrada, salida, devolucion o ajuste.", "Registra cantidad.", "Agrega nota cuando sea una correccion."],
  },
  {
    title: "Preparar pedidos",
    href: "/admin/pedidos?task=to_prepare",
    permissions: ["orders:manage_logistics"],
    steps: ["Filtra pedidos listos.", "Revisa productos y stock reservado.", "Avanza a preparacion.", "Actualiza empaque, envio o ruta segun el caso."],
  },
  {
    title: "Revisar reservas",
    href: "/admin/pedidos?task=expired_reservations",
    permissions: ["reservations:review"],
    steps: ["Filtra reservas vencidas.", "Revisa producto y cantidad.", "Agrega nota interna.", "Escala si requiere decision comercial o pago."],
  },
  {
    title: "Confirmar pagos",
    href: "/admin/pedidos?task=pending_payments",
    permissions: ["payments:confirm"],
    steps: ["Abre el pedido.", "Revisa referencia o comprobante.", "Confirma solo si coincide.", "Rechaza con cuidado si hay inconsistencia."],
  },
  {
    title: "Emitir facturas",
    href: "/admin/facturas",
    permissions: ["invoices:create"],
    steps: ["Verifica pago aprobado.", "Confirma datos fiscales.", "Emite factura.", "Descarga o comparte PDF cuando corresponda."],
  },
  {
    title: "Revisar facturas fiscales",
    href: "/admin/facturas",
    permissions: ["invoices:read"],
    steps: ["Filtra facturas.", "Revisa emitidas y anuladas.", "Descarga PDF si aplica.", "Exporta informacion fiscal permitida."],
  },
  {
    title: "Reportes fiscales",
    href: "/admin/reportes?scope=fiscal",
    permissions: ["reports:fiscal_read"],
    steps: ["Filtra por fecha.", "Revisa impuestos y totales facturados.", "Consulta correlativos.", "Exporta solo lo necesario."],
  },
  {
    title: "Usar CRM",
    href: "/admin/clientes",
    permissions: ["crm:manage"],
    steps: ["Busca cliente.", "Abre perfil.", "Revisa notas y seguimientos.", "Agenda proxima accion si falta atencion."],
  },
  {
    title: "Aprobar mayoristas",
    href: "/admin/clientes-mayoristas",
    permissions: ["wholesale:manage"],
    steps: ["Revisa solicitud.", "Valida negocio y contacto.", "Aprueba solo cuentas reales.", "Suspende acceso si deja de cumplir politica."],
  },
  {
    title: "Crear usuarios del equipo",
    href: "/admin/seguridad",
    permissions: ["security:manage"],
    steps: ["Crea usuario.", "Asigna rol minimo necesario.", "Verifica correo.", "Suspende cuentas que ya no deben operar."],
  },
  {
    title: "Revisar backups y cron",
    href: "/admin/uso",
    permissions: ["technical:tools"],
    steps: ["Revisa ultimas ejecuciones cron.", "Registra revision manual de backup.", "Limpia logs antiguos cuando aplique.", "Escala antes de saturar base."],
  },
];

function hasAnyPermission(profile: AuthProfile, permissions: Permission[]) {
  return permissions.some((permission) => profile.permissions.includes(permission));
}

export default async function AdminHelpPage() {
  const profile = await requirePermission("admin:access");
  const visibleRoleSections = roleSections.filter((section) => section.roles.includes(profile.role));
  const visibleWorkflows = workflows.filter((workflow) => hasAnyPermission(profile, workflow.permissions));

  return (
    <AdminShell title="Ayuda interna">
      <div className="mb-5">
        <Link href="/admin" className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm">
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>

      <section className="rounded-lg border border-black/10 bg-white p-5">
        <p className="text-sm text-black/50">Manual operativo</p>
        <h2 className="mt-1 text-2xl font-semibold">Como trabajar sin perder control</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-black/60">
          Esta ayuda muestra solo responsabilidades y flujos habilitados para tu rol.
        </p>
      </section>

      <section className="mt-5 grid gap-4 lg:grid-cols-2">
        {visibleRoleSections.map((section) => (
          <article key={section.role} className="rounded-lg border border-black/10 bg-white p-5">
            <p className="text-sm font-semibold uppercase text-[#e4252c]">{section.role}</p>
            <p className="mt-1 text-sm text-black/60">{section.focus}</p>
            <ul className="mt-4 space-y-2 text-sm text-black/65">
              {section.items.map((item) => (
                <li key={item} className="rounded-md bg-[#f4f4f5] px-3 py-2">
                  {item}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className="mt-5 rounded-lg border border-black/10 bg-white p-5">
        <h2 className="text-xl font-semibold">Flujos de trabajo</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibleWorkflows.map((workflow) => (
            <Link key={workflow.title} href={workflow.href} className="rounded-lg border border-black/10 p-4 transition-colors hover:border-[#e4252c]">
              <p className="font-semibold">{workflow.title}</p>
              <ol className="mt-3 space-y-2 text-sm text-black/60">
                {workflow.steps.map((step, index) => (
                  <li key={step}>
                    <span className="font-semibold text-black">{index + 1}. </span>
                    {step}
                  </li>
                ))}
              </ol>
            </Link>
          ))}
        </div>
      </section>
    </AdminShell>
  );
}
