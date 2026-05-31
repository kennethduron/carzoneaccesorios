import Link from "next/link";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const roleGuides = [
  {
    role: "Dueño",
    description: "Supervisa ventas, reportes, clientes y mayoristas sin tocar configuración técnica.",
    steps: [
      ["Ventas", "Entra a Pedidos para revisar pedidos nuevos, pagos pendientes y estados de entrega."],
      ["Reportes", "Consulta ventas, ISV, productos e inventario para tomar decisiones operativas."],
      ["Clientes", "Revisa clientes activos, notas, seguimiento comercial y solicitudes de atención."],
      ["Mayoristas", "Aprueba, rechaza, suspende o reactiva cuentas con precios especiales."],
    ],
  },
  {
    role: "Vendedor",
    description: "Mantiene ordenada la relación con prospectos y clientes.",
    steps: [
      ["CRM", "Crea prospectos, actualiza estados y registra oportunidades reales."],
      ["Notas", "Guarda llamadas, acuerdos, dudas o información importante del cliente."],
      ["Seguimientos", "Programa tareas pendientes para contactar o atender clientes."],
      ["Clientes", "Verifica datos de contacto antes de crear pedidos o solicitudes mayoristas."],
    ],
  },
  {
    role: "Bodega",
    description: "Controla stock, reservas y preparación de pedidos.",
    steps: [
      ["Inventario", "Revisa productos sin stock, bajo mínimo, reservas activas y movimientos recientes."],
      ["Entrada", "Agrega stock recibido después de revisar físicamente el producto."],
      ["Salida", "Registra salidas manuales cuando no vienen de un pedido normal."],
      ["Preparación", "Usa Pedidos para identificar qué debe empacarse y actualizar estados."],
    ],
  },
  {
    role: "Contadora",
    description: "Valida pagos, facturas y reportes fiscales.",
    steps: [
      ["Pagos", "Confirma o rechaza pagos solo cuando exista soporte suficiente."],
      ["Facturas", "Emite, reimprime o anula según el flujo fiscal vigente."],
      ["Reportes fiscales", "Revisa ISV, totales y documentos antes de cierre contable."],
      ["CAI y rango", "Valida los datos fiscales antes de emitir facturas reales."],
    ],
  },
  {
    role: "Admin",
    description: "Mantiene la operación y los accesos del equipo.",
    steps: [
      ["Productos", "Crea productos con SKU, precio, categoría, imágenes y estado correcto."],
      ["Usuarios", "Asigna roles operativos, suspende cuentas y revisa auditoría."],
      ["Configuración", "Actualiza datos públicos, redes, contacto, horarios y banners."],
      ["Seguridad", "Revisa roles, permisos y cambios sensibles antes de entregar accesos."],
    ],
  },
];

const processSteps = [
  ["Crear producto", "/admin/productos", "Agrega nombre, SKU, categoría, precios, descripción, compatibilidad e imágenes."],
  ["Cargar inventario", "/admin/inventario", "Registra entradas reales y revisa mínimos antes de vender."],
  ["Revisar pedido", "/admin/pedidos", "Abre pedidos nuevos, confirma datos del cliente y prepara el siguiente estado."],
  ["Confirmar pago", "/admin/pedidos", "Valida transferencia o estado BAC antes de aprobar."],
  ["Generar factura", "/admin/facturas", "Emite solo con CAI, rango y datos fiscales correctos."],
  ["Usar CRM", "/admin/clientes", "Registra notas, seguimientos y estado comercial del cliente."],
  ["Aprobar mayorista", "/admin/clientes-mayoristas", "Revisa la solicitud y activa precios especiales si procede."],
  ["Rastrear pedido", "/rastreo", "Busca código público para confirmar el estado visible al cliente."],
  ["Configurar redes", "/admin/configuracion", "Mantén datos públicos, enlaces y contacto actualizados."],
  ["Revisar BAC", "/admin/revision-bac", "Valida lo completado, pendientes, credenciales y revisión legal/contable."],
  ["Backups y uso", "/admin/uso", "Revisa volumen, logs y tareas técnicas cuando tengas permiso."],
];

export default async function AdminGuidePage() {
  const profile = await requirePermission("admin:access");
  const canViewTechnical = profile.permissions.includes("technical:tools");
  const visibleProcessSteps = canViewTechnical ? processSteps : processSteps.filter(([title]) => !/backup|backups/i.test(title));

  return (
    <AdminShell title="Guía rápida">
      <section className="space-y-6">
        <div className="rounded-lg border border-black/10 bg-white p-5">
          <p className="text-sm text-black/50">Onboarding interno</p>
          <h1 className="mt-1 text-2xl font-semibold">Cómo operar Car Zone Accesorios</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-black/60">
            Esta guía resume las tareas más importantes para demo, operación controlada y preparación comercial real.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {roleGuides.map((guide) => (
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
            {visibleProcessSteps.map(([title, href, detail]) => (
              <Link
                key={title}
                href={href}
                className="rounded-lg border border-black/10 p-4 transition-colors hover:border-[#e4252c]"
              >
                <p className="font-semibold">{title}</p>
                <p className="mt-2 text-sm text-black/58">{detail}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </AdminShell>
  );
}
