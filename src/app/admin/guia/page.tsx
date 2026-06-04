import Link from "next/link";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";
import type { AppRole, AuthProfile, Permission } from "@/types/auth";

export const dynamic = "force-dynamic";

type ScopedGuide = {
  role: string;
  roles?: AppRole[];
  permissions?: Permission[];
  description: string;
  steps: Array<[string, string]>;
};

type ScopedStep = {
  title: string;
  href: string;
  detail: string;
  permissions: Permission[];
};

const roleGuides: ScopedGuide[] = [
  {
    role: "Dueno / Administracion",
    roles: ["technical_owner", "business_owner", "admin"],
    description: "Supervisa ventas, pedidos, reportes, clientes y mayoristas segun sus permisos.",
    steps: [
      ["Ventas", "Entra a Pedidos para revisar pedidos nuevos, pagos pendientes y estados de entrega."],
      ["Reportes", "Consulta ventas, ISV, productos e inventario para tomar decisiones operativas."],
      ["Clientes", "Revisa clientes activos, notas, seguimiento comercial y solicitudes de atencion."],
      ["Mayoristas", "Aprueba, rechaza, suspende o reactiva cuentas con precios especiales."],
    ],
  },
  {
    role: "Vendedor / Soporte",
    roles: ["vendedor", "soporte"],
    description: "Mantiene ordenada la relacion con prospectos, clientes y seguimientos.",
    steps: [
      ["CRM", "Actualiza estados, registra oportunidades reales y crea seguimientos."],
      ["Notas", "Guarda llamadas, acuerdos, dudas o informacion importante del cliente."],
      ["Seguimientos", "Programa tareas pendientes para contactar o atender clientes."],
      ["Clientes", "Verifica datos de contacto antes de escalar una solicitud."],
    ],
  },
  {
    role: "Bodega",
    roles: ["bodega"],
    description: "Controla stock, reservas y preparacion logistica de pedidos.",
    steps: [
      ["Inventario", "Revisa productos sin stock, bajo minimo, reservas activas y movimientos recientes."],
      ["Entrada", "Agrega stock recibido despues de revisar fisicamente el producto."],
      ["Salida", "Registra salidas manuales cuando no vienen de un pedido normal."],
      ["Preparacion", "Usa Pedidos para identificar que debe empacarse y actualizar estados logisticos."],
    ],
  },
  {
    role: "Contadora",
    roles: ["contadora"],
    description: "Revisa facturas, CAI, rango fiscal, correlativos y reportes contables.",
    steps: [
      ["Facturas", "Revisa facturas emitidas, anuladas, PDF e historial fiscal."],
      ["Reportes fiscales", "Consulta ventas facturadas, ISV, correlativos usados y exportaciones contables."],
      ["CAI y rango", "Vigila vencimiento de CAI, correlativo actual y rango fiscal disponible."],
      ["Alertas fiscales", "Atiende avisos de factura anulada, CAI proximo a vencer o errores fiscales."],
    ],
  },
];

const processSteps: ScopedStep[] = [
  { title: "Crear producto", href: "/admin/productos", detail: "Agrega nombre, SKU, categoria, precios, compatibilidad e imagenes.", permissions: ["products:manage"] },
  { title: "Cargar inventario", href: "/admin/inventario", detail: "Registra entradas reales y revisa minimos antes de vender.", permissions: ["inventory:manage"] },
  { title: "Preparar pedido", href: "/admin/pedidos?task=to_prepare", detail: "Identifica pedidos confirmados y avanza preparacion, empaque o envio.", permissions: ["orders:manage_logistics"] },
  { title: "Revisar reservas", href: "/admin/pedidos?task=expired_reservations", detail: "Revisa reservas vencidas desde el impacto de stock.", permissions: ["reservations:review"] },
  { title: "Revisar pedido", href: "/admin/pedidos", detail: "Abre pedidos nuevos, confirma datos del cliente y prepara el siguiente estado.", permissions: ["orders:manage"] },
  { title: "Confirmar pago", href: "/admin/pedidos?task=pending_payments", detail: "Valida transferencia, efectivo entregado o tarjeta por link antes de aprobar.", permissions: ["payments:confirm"] },
  { title: "Generar factura", href: "/admin/facturas", detail: "Emite solo con pago confirmado, CAI, rango y datos fiscales correctos.", permissions: ["invoices:create"] },
  { title: "Revisar facturas", href: "/admin/facturas", detail: "Consulta facturas emitidas, anuladas, PDF e historial fiscal.", permissions: ["invoices:read"] },
  { title: "Reportes fiscales", href: "/admin/reportes?scope=fiscal", detail: "Filtra facturas, ISV, anulaciones y correlativos para contabilidad.", permissions: ["reports:fiscal_read"] },
  { title: "Usar CRM", href: "/admin/clientes", detail: "Registra notas, seguimientos y estado comercial del cliente.", permissions: ["crm:manage"] },
  { title: "Aprobar mayorista", href: "/admin/clientes-mayoristas", detail: "Revisa la solicitud y activa precios especiales si procede.", permissions: ["wholesale:manage"] },
  { title: "Configurar redes", href: "/admin/configuracion", detail: "Manten datos publicos, enlaces y contacto actualizados.", permissions: ["commercial_settings:manage"] },
  { title: "Tarjeta por link", href: "/admin/revision-bac", detail: "Referencia operativa; el flujo activo usa link externo por WhatsApp.", permissions: ["commercial_settings:manage"] },
  { title: "Backups y uso", href: "/admin/uso", detail: "Revisa volumen, logs y tareas tecnicas cuando tengas permiso.", permissions: ["technical:tools"] },
];

function hasAnyPermission(profile: AuthProfile, permissions: Permission[]) {
  return permissions.some((permission) => profile.permissions.includes(permission));
}

function guideIsVisible(profile: AuthProfile, guide: ScopedGuide) {
  return Boolean(guide.roles?.includes(profile.role) || (guide.permissions && hasAnyPermission(profile, guide.permissions)));
}

export default async function AdminGuidePage() {
  const profile = await requirePermission("admin:access");
  const visibleRoleGuides = roleGuides.filter((guide) => guideIsVisible(profile, guide));
  const visibleProcessSteps = processSteps.filter((step) => hasAnyPermission(profile, step.permissions));

  return (
    <AdminShell title="Guia rapida">
      <section className="space-y-6">
        <div className="rounded-lg border border-black/10 bg-white p-5">
          <p className="text-sm text-black/50">Onboarding interno</p>
          <h1 className="mt-1 text-2xl font-semibold">Como operar Car Zone Accesorios</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-black/60">
            Esta guia muestra solo los flujos permitidos para tu rol.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {visibleRoleGuides.map((guide) => (
            <article key={guide.role} className="rounded-lg border border-black/10 bg-white p-5">
              <p className="text-sm font-medium uppercase text-[#e4252c]">{guide.role}</p>
              <p className="mt-1 text-sm text-black/60">{guide.description}</p>
              <div className="mt-4 grid gap-3">
                {guide.steps.map(([title, detail]) => (
                  <div key={title} className="rounded-md bg-[#f4f4f5] p-3">
                    <p className="font-semibold">{title}</p>
                    <p className="mt-1 text-sm text-black/58">{detail}</p>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>

        <div className="rounded-lg border border-black/10 bg-white p-5">
          <h2 className="text-xl font-semibold">Flujos principales</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleProcessSteps.map((step) => (
              <Link
                key={step.title}
                href={step.href}
                className="rounded-lg border border-black/10 p-4 transition-colors hover:border-[#e4252c]"
              >
                <p className="font-semibold">{step.title}</p>
                <p className="mt-2 text-sm text-black/58">{step.detail}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </AdminShell>
  );
}
