import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const roleSections = [
  {
    role: "Dueño",
    focus: "Ver salud diaria del negocio y tomar decisiones.",
    items: [
      "Revisar ventas de hoy y del mes en el panel principal.",
      "Entrar a Pedidos para pendientes, pagos y preparación.",
      "Revisar Reportes para comportamiento de ventas e inventario.",
      "Aprobar o rechazar solicitudes mayoristas con criterio comercial.",
      "Revisar alertas BAC, cron y backups como semáforo operativo.",
    ],
  },
  {
    role: "Vendedor",
    focus: "Atender clientes, dar seguimiento y ordenar el CRM.",
    items: [
      "Crear o actualizar clientes desde Clientes.",
      "Agregar notas con acuerdos, dudas, llamadas o información importante.",
      "Crear seguimientos con fecha y prioridad.",
      "Cerrar seguimientos cuando el contacto ya se realizó.",
      "Escalar mayoristas al dueño o administrador antes de aprobar.",
    ],
  },
  {
    role: "Bodega",
    focus: "Mantener inventario confiable y preparar pedidos.",
    items: [
      "Buscar producto por SKU, código o nombre antes de cargar movimiento.",
      "Registrar entradas cuando se recibe mercadería física.",
      "Usar ajustes solo para correcciones reales después de conteo.",
      "Revisar productos sin stock, bajo mínimo y reservas activas.",
      "Actualizar estado del pedido cuando esté preparado o despachado.",
    ],
  },
  {
    role: "Contadora",
    focus: "Validar pagos, facturas y cumplimiento fiscal.",
    items: [
      "Confirmar pagos solo con soporte válido.",
      "Emitir facturas con CAI, rango y datos fiscales correctos.",
      "Revisar facturas pendientes y anulaciones.",
      "Usar Reportes como vista operativa, no como cierre fiscal final sin validación.",
      "Revisar configuración fiscal antes de facturar en operación real.",
    ],
  },
  {
    role: "Administrador",
    focus: "Configurar operación, equipo, productos y seguridad.",
    items: [
      "Crear productos con SKU, precios, categoría, compatibilidad y estado correcto.",
      "Subir imágenes claras y marcar una imagen principal.",
      "Crear usuarios internos y asignar solo el rol necesario.",
      "Revisar auditoría después de cambios sensibles.",
      "Mantener configuración empresarial, BAC, cron, backups y contacto al día.",
    ],
  },
];

const workflows = [
  {
    title: "Crear productos",
    href: "/admin/productos",
    steps: ["Completa SKU y nombre.", "Asigna categoría y precios.", "Agrega compatibilidad si aplica.", "Activa solo productos listos para vender."],
  },
  {
    title: "Subir imágenes",
    href: "/admin/productos",
    steps: ["Usa imágenes limpias.", "Sube ángulos útiles.", "Define imagen principal.", "Evita duplicar imágenes pesadas sin necesidad."],
  },
  {
    title: "Cargar inventario",
    href: "/admin/inventario",
    steps: ["Busca el producto.", "Elige entrada, salida, devolución o ajuste.", "Registra cantidad.", "Agrega nota cuando sea una corrección."],
  },
  {
    title: "Revisar pedidos",
    href: "/admin/pedidos",
    steps: ["Filtra pendientes.", "Valida datos del cliente.", "Revisa productos y stock reservado.", "Actualiza estado según preparación."],
  },
  {
    title: "Confirmar pagos",
    href: "/admin/pedidos",
    steps: ["Abre el pedido.", "Revisa referencia o comprobante.", "Confirma solo si coincide.", "Rechaza con cuidado si hay inconsistencia."],
  },
  {
    title: "Emitir facturas",
    href: "/admin/facturas",
    steps: ["Verifica pago aprobado.", "Confirma datos fiscales.", "Emite factura.", "Descarga o comparte PDF cuando corresponda."],
  },
  {
    title: "Usar CRM",
    href: "/admin/clientes",
    steps: ["Busca cliente.", "Abre perfil.", "Revisa pedidos, notas y seguimientos.", "Agenda próxima acción si falta atención."],
  },
  {
    title: "Agregar notas",
    href: "/admin/clientes",
    steps: ["Abre cliente.", "Agrega nota breve y concreta.", "No guardes información innecesaria.", "Archiva notas obsoletas si aplica."],
  },
  {
    title: "Crear seguimientos",
    href: "/admin/clientes",
    steps: ["Elige cliente.", "Define acción siguiente.", "Asigna fecha y prioridad.", "Marca completado al terminar."],
  },
  {
    title: "Aprobar mayoristas",
    href: "/admin/clientes-mayoristas",
    steps: ["Revisa solicitud.", "Valida negocio y contacto.", "Aprueba solo cuentas reales.", "Suspende acceso si deja de cumplir política."],
  },
  {
    title: "Crear usuarios del equipo",
    href: "/admin/seguridad",
    steps: ["Crea usuario.", "Asigna rol mínimo necesario.", "Verifica correo.", "Suspende cuentas que ya no deben operar."],
  },
  {
    title: "Revisar reportes",
    href: "/admin/reportes",
    steps: ["Usa filtros y paginación.", "Exporta solo lo necesario.", "Valida cierres fiscales con contabilidad.", "No uses vista preliminar como cierre final."],
  },
  {
    title: "Revisar BAC",
    href: "/admin/revision-bac",
    steps: ["Completa checklist.", "Verifica datos públicos.", "Confirma credenciales.", "Activa tarjeta cuando el proveedor lo autorice."],
  },
  {
    title: "Revisar backups y cron",
    href: "/admin/uso",
    steps: ["Revisa últimas ejecuciones cron.", "Registra revisión manual de backup.", "Limpia logs antiguos cuando aplique.", "Escala a plan Pro antes de saturar base."],
  },
];

export default async function AdminHelpPage() {
  await requirePermission("admin:access");

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
        <h2 className="mt-1 text-2xl font-semibold">Cómo trabajar sin perder control</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-black/60">
          Esta ayuda resume el uso correcto del sistema por rol. Está pensada para operación diaria, capacitación rápida y control interno.
        </p>
      </section>

      <section className="mt-5 grid gap-4 lg:grid-cols-2">
        {roleSections.map((section) => (
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
          {workflows.map((workflow) => (
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
