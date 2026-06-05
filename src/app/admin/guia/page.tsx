import Link from "next/link";
import Image from "next/image";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";
import type { AppRole, AuthProfile, Permission } from "@/types/auth";

export const dynamic = "force-dynamic";

type GuideSection = {
  id: string;
  title: string;
  summary: string;
  href?: string;
  screenshot?: string;
  roles: AppRole[];
  permissions?: Permission[];
  what: string;
  purpose: string;
  steps: string[];
  recommendation: string;
  commonError: string;
  warning?: string;
};

type RoleGuide = {
  role: AppRole;
  label: string;
  canDo: string[];
  cannotDo: string[];
};

type Faq = {
  question: string;
  answer: string;
  permissions?: Permission[];
};

const allAdminRoles: AppRole[] = ["technical_owner", "business_owner", "admin", "vendedor", "bodega", "contadora", "soporte"];
const businessRoles: AppRole[] = ["technical_owner", "business_owner", "admin"];
const salesRoles: AppRole[] = ["technical_owner", "business_owner", "admin", "vendedor", "soporte"];
const warehouseRoles: AppRole[] = ["technical_owner", "business_owner", "admin", "bodega"];
const fiscalRoles: AppRole[] = ["technical_owner", "business_owner", "admin", "contadora"];

const guideSections: GuideSection[] = [
  {
    id: "bienvenida",
    title: "Bienvenida al sistema",
    summary: "Vista general de la tienda publica y el panel administrativo.",
    roles: allAdminRoles,
    what: "Car Zone Accesorios es el sistema donde se organiza la venta, atencion, inventario, pedidos, facturas y seguimiento comercial.",
    purpose: "Sirve para que cada area trabaje con la misma informacion y el dueno pueda revisar el estado del negocio sin depender de hojas sueltas.",
    steps: [
      "Usa la tienda publica para ver como compra el cliente.",
      "Usa el panel administrativo para operar productos, pedidos, clientes, facturas y reportes.",
      "Revisa solo los modulos habilitados para tu rol.",
      "Registra notas o cambios importantes dentro del sistema para dejar historial.",
    ],
    recommendation: "Empieza el dia revisando Dashboard, Pedidos y las alertas que correspondan a tu area.",
    commonError: "Confundir tienda publica con panel administrativo. La tienda es para clientes; el panel es para el equipo interno.",
  },
  {
    id: "inicio-sesion",
    title: "Inicio de sesion",
    summary: "Acceso seguro para cada usuario interno.",
    href: "/login",
    roles: allAdminRoles,
    what: "Cada persona entra con su propio usuario para que el sistema registre quien realiza cada accion.",
    purpose: "Protege informacion de clientes, pagos, facturas y operacion diaria.",
    steps: [
      "Abre la pagina de login.",
      "Escribe tu correo o usuario.",
      "Escribe tu contrasena.",
      "Si olvidaste la contrasena, usa Recuperar contrasena.",
      "Cierra sesion cuando uses una computadora compartida.",
    ],
    recommendation: "No compartas contrasenas. Si alguien necesita acceso, el responsable debe crear su usuario con el rol correcto.",
    commonError: "Usar una cuenta de otra persona. Esto rompe la auditoria y puede ocultar quien hizo un cambio.",
    warning: "Nunca guardes contrasenas en chats, notas visibles o capturas.",
  },
  {
    id: "dashboard",
    title: "Dashboard",
    summary: "Indicadores, alertas y accesos rapidos del negocio.",
    href: "/admin",
    roles: allAdminRoles,
    permissions: ["admin:access"],
    what: "Es la primera pantalla del panel. Resume pendientes, ventas, inventario, clientes y tareas segun permisos.",
    purpose: "Ayuda a decidir que atender primero: pedidos nuevos, pagos pendientes, bajo stock, facturas o clientes.",
    steps: [
      "Revisa los indicadores principales.",
      "Lee las alertas importantes antes de cambiar estados.",
      "Usa accesos rapidos para entrar al modulo correcto.",
      "Si una tarjeta no aparece, puede ser porque tu rol no tiene permiso para verla.",
    ],
    recommendation: "El dueno o administrador debe revisar esta pantalla al iniciar y cerrar el dia.",
    commonError: "Ignorar alertas de stock, reservas o pagos y avanzar pedidos sin validar.",
  },
  {
    id: "productos",
    title: "Productos",
    summary: "Crear, editar, publicar y mantener productos del catalogo.",
    href: "/admin/productos",
    roles: businessRoles,
    permissions: ["products:manage"],
    what: "Modulo para administrar nombre, SKU, categoria, precios, compatibilidad, estado e imagenes de cada producto.",
    purpose: "Mantiene el catalogo ordenado y evita vender productos con datos incompletos.",
    steps: [
      "Entra a Productos.",
      "Presiona crear producto o abre uno existente.",
      "Completa nombre, SKU, categoria y descripcion.",
      "Define precio normal y precio mayorista cuando aplique.",
      "Sube imagenes limpias del producto.",
      "Revisa compatibilidad por marca, modelo o anio si aplica.",
      "Activa el producto solo cuando este listo para vender.",
      "Si no debe venderse, desactivalo o cambialo a un estado no visible.",
    ],
    recommendation: "Usa SKU unico, nombres claros y fotos reales. Antes de publicar, confirma precio y stock.",
    commonError: "Activar un producto sin imagen, sin stock o con precio mayorista incorrecto.",
  },
  {
    id: "inventario",
    title: "Inventario",
    summary: "Stock disponible, reservado, agotado y movimientos.",
    href: "/admin/inventario",
    roles: warehouseRoles,
    permissions: ["inventory:manage"],
    what: "Controla unidades disponibles, reservas activas, productos agotados y movimientos de entrada o salida.",
    purpose: "Evita sobreventa y ayuda a preparar pedidos con informacion confiable.",
    steps: [
      "Busca producto por SKU, codigo o nombre.",
      "Revisa stock disponible antes de prometer entrega.",
      "Identifica stock reservado: son unidades apartadas por pedidos en proceso.",
      "Revisa productos bajo minimo para pedir reposicion.",
      "Registra entrada cuando llegue mercaderia fisica.",
      "Registra salida o ajuste solo con motivo claro.",
    ],
    recommendation: "Cuenta fisicamente antes de ajustar. Las reservas no deben liberarse manualmente sin revisar el pedido.",
    commonError: "Confundir stock reservado con stock disponible y prometer unidades que ya estan apartadas.",
  },
  {
    id: "pedidos",
    title: "Pedidos",
    summary: "Revision, pago, cancelacion y flujo logistico.",
    href: "/admin/pedidos",
    roles: ["technical_owner", "business_owner", "admin", "vendedor", "bodega", "soporte"],
    permissions: ["orders:read", "orders:manage", "orders:manage_logistics"],
    what: "Reune los pedidos nuevos, datos del cliente, productos, pago, reserva, notas internas y estado logistico.",
    purpose: "Permite atender cada compra desde recibida hasta entregada.",
    steps: [
      "Entra a Pedidos.",
      "Filtra pedidos nuevos o pendientes.",
      "Abre un pedido y revisa productos, cantidades y datos del cliente.",
      "Valida el metodo de pago antes de avanzar.",
      "Confirma o rechaza pago solo si tienes permiso.",
      "Avanza el estado segun el proceso: preparacion, empacado, enviado, en ruta y entregado.",
      "Cancela solo cuando exista una razon clara y el flujo lo permita.",
      "Agrega nota interna si hay una situacion especial.",
    ],
    recommendation: "No prepares pedidos con pago pendiente, salvo flujo autorizado de pago contra entrega.",
    commonError: "Cambiar el estado logistico sin revisar pago, stock reservado o datos de contacto.",
  },
  {
    id: "metodos-pago",
    title: "Metodos de pago",
    summary: "Efectivo, transferencia y tarjeta por link externo.",
    href: "/admin/pedidos?task=pending_payments",
    roles: businessRoles,
    permissions: ["payments:read", "payments:confirm", "payments:reject"],
    what: "El sistema registra el metodo elegido y permite confirmar o rechazar pagos segun evidencia.",
    purpose: "Ordena la validacion de dinero antes de preparar, entregar o facturar.",
    steps: [
      "Efectivo: se confirma cuando el dinero se recibe realmente, normalmente al entregar.",
      "Transferencia: revisa referencia, monto y comprobante si existe.",
      "Si la transferencia no coincide, rechaza con motivo claro.",
      "Tarjeta por link: el sitio no procesa tarjetas.",
      "El cliente elige tarjeta y el pedido queda pendiente.",
      "El equipo contacta por WhatsApp y envia el link de pago externo.",
      "El cliente paga fuera del sitio y envia comprobante o confirmacion.",
      "El admin confirma manualmente cuando el pago esta verificado.",
    ],
    recommendation: "Confirma pagos solo con evidencia suficiente. Si hay duda, llama o escribe al cliente antes de aprobar.",
    commonError: "Marcar tarjeta como pagada antes de recibir confirmacion real del pago externo.",
    warning: "Nunca pidas numero de tarjeta, CVV ni fecha de vencimiento dentro del sistema o por chat.",
  },
  {
    id: "whatsapp",
    title: "WhatsApp",
    summary: "Contacto rapido con clientes y envio manual de documentos.",
    roles: salesRoles,
    permissions: ["orders:read", "crm:manage", "customers:read"],
    what: "Los botones de WhatsApp ayudan a abrir una conversacion con mensaje prellenado cuando existe telefono del cliente.",
    purpose: "Permite confirmar datos, enviar instrucciones de pago, coordinar entrega y compartir PDF manualmente.",
    steps: [
      "Abre el pedido o perfil del cliente.",
      "Usa el boton de WhatsApp si esta disponible.",
      "Revisa el mensaje prellenado antes de enviarlo.",
      "Para tarjeta por link, pega el link externo seguro en la conversacion.",
      "Para facturas, descarga el PDF y adjuntalo manualmente si el cliente lo solicita.",
      "Llama al cliente si hay pago dudoso, direccion incompleta o urgencia de entrega.",
    ],
    recommendation: "Mantén mensajes cortos, claros y con numero de pedido cuando aplique.",
    commonError: "Enviar datos del pedido equivocado por no revisar nombre, telefono y numero de pedido.",
  },
  {
    id: "facturacion",
    title: "Facturacion fiscal",
    summary: "CAI, correlativo, rango, vista previa, PDF e impresion.",
    href: "/admin/facturas",
    roles: fiscalRoles,
    permissions: ["invoices:read", "invoices:create", "fiscal:read"],
    what: "Modulo para emitir y consultar facturas fiscales con CAI, correlativo y rango autorizado.",
    purpose: "Formaliza ventas pagadas y mantiene historial fiscal del negocio.",
    steps: [
      "Verifica que el pedido tenga pago confirmado.",
      "Confirma que los datos fiscales del cliente esten correctos.",
      "Revisa que exista CAI, rango autorizado y correlativo disponible.",
      "Genera factura desde el pedido cuando el boton este habilitado.",
      "Revisa la vista previa.",
      "Abre la factura en navegador, descarga PDF o imprime.",
      "Desde celular, abre la factura y usa Compartir o Guardar PDF del navegador.",
      "Si el pedido ya tiene factura, solo consulta, reimprime o descarga la existente.",
    ],
    recommendation: "Antes de emitir, revisa nombre o razon social y RTN. Despues de emitir, el manejo fiscal debe seguir el procedimiento correspondiente.",
    commonError: "Intentar facturar sin pago confirmado o con CAI/rango vencido.",
    warning: "Abrir, descargar o imprimir una factura existente no consume correlativo. Solo generar una factura nueva consume correlativo.",
  },
  {
    id: "correccion-fiscal",
    title: "Correccion de datos fiscales",
    summary: "Nombre, razon social, RTN y auditoria interna.",
    href: "/admin/facturas",
    roles: fiscalRoles,
    permissions: ["invoices:correct"],
    what: "Permite corregir datos fiscales del cliente cuando el proceso y el permiso lo permiten.",
    purpose: "Evita emitir una factura con nombre, razon social o RTN incorrectos.",
    steps: [
      "Antes de emitir factura, revisa nombre o razon social.",
      "Revisa RTN si el cliente lo proporciono.",
      "Corrige datos antes de emitir cuando sea necesario.",
      "Despues de emitida, sigue el proceso fiscal correspondiente y deja motivo.",
      "Toda correccion debe quedar con razon clara para auditoria interna.",
    ],
    recommendation: "Pide confirmacion escrita al cliente cuando cambie RTN o razon social.",
    commonError: "Emitir primero y corregir despues por no revisar datos fiscales a tiempo.",
  },
  {
    id: "crm",
    title: "Clientes y CRM",
    summary: "Clientes, historial, notas, seguimientos y tareas.",
    href: "/admin/clientes",
    roles: salesRoles,
    permissions: ["crm:manage", "customers:read"],
    what: "Centraliza clientes, prospectos, historial de compras, notas, seguimientos y tareas comerciales.",
    purpose: "Ayuda a dar seguimiento sin perder informacion entre vendedor, soporte y administracion.",
    steps: [
      "Busca cliente por nombre, empresa, telefono o correo.",
      "Abre el perfil para revisar historial.",
      "Agrega notas con acuerdos, dudas o llamadas.",
      "Crea seguimientos con fecha y prioridad.",
      "Revisa tareas vencidas para retomar contactos pendientes.",
      "Cierra seguimientos cuando la accion se complete.",
    ],
    recommendation: "Cada llamada o acuerdo importante debe quedar como nota. Eso evita depender de memoria o chats externos.",
    commonError: "Crear clientes duplicados sin revisar telefono o correo existente.",
  },
  {
    id: "mayoristas",
    title: "Mayoristas",
    summary: "Solicitudes, aprobacion, codigos y precios especiales.",
    href: "/admin/clientes-mayoristas",
    roles: businessRoles,
    permissions: ["wholesale:manage"],
    what: "Gestiona solicitudes de clientes que quieren comprar como mayoristas.",
    purpose: "Permite aprobar precios especiales solo a cuentas que cumplen criterio comercial.",
    steps: [
      "Revisa la solicitud mayorista.",
      "Valida negocio, contacto, ciudad y necesidad real.",
      "Aprueba si cumple los criterios.",
      "Rechaza con motivo si no aplica.",
      "Suspende si la cuenta deja de cumplir condiciones.",
      "Cuando un cliente queda aprobado, ve precios mayoristas al iniciar sesion.",
      "Si existen codigos mayoristas, revisa vigencia, uso y cliente asociado.",
    ],
    recommendation: "Antes de aprobar, confirma que el cliente realmente compra para negocio, taller, distribucion o volumen.",
    commonError: "Aprobar cuentas sin validar y afectar margenes de venta al detalle.",
  },
  {
    id: "banners",
    title: "Banners",
    summary: "Promociones, prioridad, imagen, video y estado.",
    href: "/admin/banners",
    roles: businessRoles,
    permissions: ["commercial_settings:manage"],
    what: "Administra banners visibles en la tienda para promociones, temporadas o avisos importantes.",
    purpose: "Permite destacar campanas sin cambiar productos ni estructura del sitio.",
    steps: [
      "Entra a Banners.",
      "Crea un banner con titulo claro.",
      "Elige posicion principal o secundaria si aplica.",
      "Asigna prioridad de 1 a 5; la prioridad mas alta se muestra primero segun configuracion.",
      "Sube imagen o video liviano y claro.",
      "Define fechas si la campana es temporal.",
      "Activa o desactiva segun necesidad.",
      "Elimina solo banners que ya no deban usarse.",
    ],
    recommendation: "Usa textos cortos y piezas visuales legibles en celular.",
    commonError: "Crear varios banners activos con la misma prioridad y fechas superpuestas.",
    warning: "Al eliminar un banner, el sistema limpia internamente el archivo asociado cuando corresponde.",
  },
  {
    id: "reportes",
    title: "Reportes",
    summary: "Ventas, clientes, inventario, fiscal y exportaciones.",
    href: "/admin/reportes",
    roles: ["technical_owner", "business_owner", "admin", "contadora"],
    permissions: ["reports:read", "reports:fiscal_read"],
    what: "Reune informacion para revisar ventas, clientes, productos, inventario, pagos y facturacion.",
    purpose: "Ayuda a tomar decisiones y preparar cierres administrativos o fiscales.",
    steps: [
      "Entra a Reportes.",
      "Elige tipo de reporte.",
      "Filtra por fecha inicial y final.",
      "Agrega filtros de cliente, producto, estado o metodo de pago si aplica.",
      "Revisa totales antes de exportar.",
      "Exporta solo la informacion necesaria para el cierre o analisis.",
    ],
    recommendation: "Para cierres, usa rangos de fecha exactos y compara pedidos contra facturas cuando aplique.",
    commonError: "Exportar sin filtros y mezclar informacion operativa con fiscal.",
  },
  {
    id: "roles",
    title: "Roles y permisos",
    summary: "Que puede hacer cada tipo de usuario.",
    href: "/admin/seguridad",
    roles: allAdminRoles,
    permissions: ["admin:access"],
    what: "Cada usuario tiene un rol para limitar lo que puede ver y hacer dentro del sistema.",
    purpose: "Protege informacion sensible y reduce errores operativos.",
    steps: [
      "Technical owner: acceso tecnico y supervision completa.",
      "Dueno: control operativo amplio del negocio.",
      "Admin: operacion diaria con productos, pedidos, pagos, facturas, CRM y reportes.",
      "Vendedor: clientes, CRM y consulta de pedidos.",
      "Bodega: inventario, reservas y estados logisticos.",
      "Contadora: facturas, CAI, reportes fiscales y exportaciones contables.",
      "Soporte: clientes, CRM, pedidos y facturas de consulta.",
      "Cliente: tienda publica, sus pedidos y sus facturas.",
    ],
    recommendation: "Asigna siempre el rol minimo necesario. Si alguien cambia de puesto, actualiza o suspende su acceso.",
    commonError: "Dar permisos de administrador a usuarios que solo necesitan vender, preparar pedidos o consultar facturas.",
  },
  {
    id: "configuracion",
    title: "Configuracion",
    summary: "Datos del negocio, contacto, preferencias y fiscal.",
    href: "/admin/configuracion",
    roles: businessRoles,
    permissions: ["settings:manage", "commercial_settings:manage", "settings:fiscal"],
    what: "Contiene datos publicos del negocio, contacto, preferencias operativas, notificaciones y configuracion fiscal.",
    purpose: "Mantiene la informacion correcta en tienda, comunicaciones, reportes y documentos.",
    steps: [
      "Actualiza datos de negocio cuando cambien.",
      "Revisa telefonos, correo y WhatsApp de servicio al cliente.",
      "Configura preferencias de notificacion segun responsabilidades.",
      "La configuracion fiscal debe tocarse solo con autorizacion.",
      "No cambies CAI, rango o correlativo si no sabes el impacto fiscal.",
    ],
    recommendation: "Los datos fiscales deben revisarse con la contadora o responsable antes de emitir facturas reales.",
    commonError: "Cambiar datos fiscales o preferencias globales sin avisar al equipo.",
    warning: "Esta guia no muestra secretos, claves, tokens ni configuraciones tecnicas internas.",
  },
];

const roleGuides: RoleGuide[] = [
  {
    role: "technical_owner",
    label: "Technical owner",
    canDo: ["Supervisar todo el sistema.", "Revisar seguridad, uso y herramientas tecnicas.", "Apoyar mantenimiento y auditoria."],
    cannotDo: ["Compartir accesos tecnicos.", "Usar datos reales para pruebas sin control."],
  },
  {
    role: "business_owner",
    label: "Dueno / business owner",
    canDo: ["Ver operacion completa.", "Gestionar usuarios operativos.", "Revisar ventas, pagos, facturas, clientes y reportes."],
    cannotDo: ["Modificar configuraciones fiscales sin validacion.", "Compartir su cuenta con el equipo."],
  },
  {
    role: "admin",
    label: "Admin",
    canDo: ["Gestionar productos, pedidos, pagos, facturas, CRM, mayoristas y reportes.", "Atender operacion diaria."],
    cannotDo: ["Usar herramientas tecnicas reservadas.", "Asignar permisos por encima de su alcance."],
  },
  {
    role: "vendedor",
    label: "Vendedor",
    canDo: ["Atender clientes.", "Usar CRM.", "Consultar pedidos para seguimiento comercial."],
    cannotDo: ["Confirmar pagos.", "Emitir facturas.", "Modificar inventario."],
  },
  {
    role: "bodega",
    label: "Bodega",
    canDo: ["Gestionar inventario.", "Revisar reservas.", "Avanzar estados logisticos."],
    cannotDo: ["Confirmar pagos.", "Emitir facturas.", "Aprobar mayoristas."],
  },
  {
    role: "contadora",
    label: "Contadora",
    canDo: ["Consultar facturas.", "Revisar CAI, correlativos y reportes fiscales.", "Exportar informacion contable permitida."],
    cannotDo: ["Modificar inventario.", "Confirmar pagos.", "Gestionar CRM operativo."],
  },
  {
    role: "soporte",
    label: "Soporte",
    canDo: ["Atender clientes.", "Consultar pedidos y facturas.", "Registrar notas y seguimientos."],
    cannotDo: ["Confirmar pagos.", "Cambiar configuracion fiscal.", "Modificar inventario."],
  },
  {
    role: "cliente",
    label: "Cliente",
    canDo: ["Comprar en tienda.", "Ver sus pedidos.", "Abrir o descargar sus facturas."],
    cannotDo: ["Entrar al panel administrativo.", "Ver pedidos o facturas de otros clientes."],
  },
];

const faqs: Faq[] = [
  {
    question: "Por que no puedo generar factura?",
    answer: "Normalmente falta pago confirmado, el pedido no cumple condiciones, ya existe factura, o hay un problema con CAI, rango o datos fiscales.",
    permissions: ["invoices:create", "invoices:read"],
  },
  {
    question: "Por que no puedo confirmar pago?",
    answer: "Puede que tu rol no tenga permiso, el pedido ya este cancelado, el pago ya este aprobado o rechazado, o sea un pago contra entrega que aun no corresponde confirmar.",
    permissions: ["payments:confirm", "payments:read"],
  },
  {
    question: "Por que un producto no aparece en catalogo?",
    answer: "Revisa que este activo, con estado visible, categoria correcta, imagen adecuada y stock disponible si la configuracion lo requiere.",
    permissions: ["products:manage", "products:read"],
  },
  {
    question: "Por que un pedido no aparece en rastreo?",
    answer: "El rastreo publico muestra pedidos con codigo valido y estado permitido. Si el pedido esta cancelado o no tiene codigo, puede no mostrarse.",
    permissions: ["orders:read", "orders:manage"],
  },
  {
    question: "Como descargo una factura desde celular?",
    answer: "Abre la factura, usa el visor del navegador y luego elige Compartir, Guardar en archivos o Descargar segun el telefono.",
    permissions: ["invoices:read"],
  },
  {
    question: "Que hago si el cliente quiere pagar con tarjeta?",
    answer: "El sitio no procesa tarjetas. Contacta por WhatsApp, envia el link externo autorizado y confirma manualmente solo cuando el pago este verificado.",
    permissions: ["payments:confirm", "orders:read"],
  },
  {
    question: "Que hago si el banner no aparece?",
    answer: "Revisa si esta activo, dentro de fechas, con prioridad correcta y con imagen o video valido.",
    permissions: ["commercial_settings:manage"],
  },
  {
    question: "Que hago si un producto no tiene stock?",
    answer: "No prometas entrega inmediata. Revisa inventario, productos alternos o solicita reposicion.",
    permissions: ["inventory:manage", "products:read"],
  },
  {
    question: "Que significa stock reservado?",
    answer: "Son unidades apartadas por pedidos en proceso. No deben contarse como disponibles para otra venta.",
    permissions: ["inventory:manage", "orders:read"],
  },
];

function hasAnyPermission(profile: AuthProfile, permissions?: Permission[]) {
  if (!permissions || permissions.length === 0) return true;
  return permissions.some((permission) => profile.permissions.includes(permission));
}

function isVisibleToRole(profile: AuthProfile, roles: AppRole[], permissions?: Permission[]) {
  return roles.includes(profile.role) || hasAnyPermission(profile, permissions);
}

function ScreenshotPanel({ title, src }: { title: string; src?: string }) {
  if (!src) {
    return (
      <div className="grid aspect-[16/9] w-full place-items-center rounded-md border border-dashed border-black/20 bg-[#f4f4f5] p-4 text-center">
        <div>
          <p className="text-sm font-semibold text-black/70">Captura pendiente</p>
          <p className="mt-1 text-xs leading-5 text-black/50">
            Tomar con cuenta de prueba y datos ficticios antes de entregar manual impreso.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Image
      src={src}
      alt={`Captura de ${title}`}
      width={1280}
      height={720}
      className="h-auto max-h-[420px] w-full rounded-md border border-black/10 object-contain"
    />
  );
}

function GuideCard({ section }: { section: GuideSection }) {
  return (
    <article id={section.id} className="scroll-mt-6 rounded-lg border border-black/10 bg-white p-4 sm:p-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase text-[#e4252c]">{section.summary}</p>
          <h2 className="mt-1 text-xl font-semibold sm:text-2xl">{section.title}</h2>
          <p className="mt-3 text-sm leading-6 text-black/65">{section.what}</p>
          <p className="mt-3 text-sm leading-6 text-black/65">{section.purpose}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {section.href ? (
              <Link href={section.href} className="rounded-md bg-[#080808] px-3 py-2 text-sm font-semibold text-white">
                Abrir modulo
              </Link>
            ) : null}
            <span className="rounded-md border border-black/10 px-3 py-2 text-sm text-black/60">
              Roles: {section.roles.map((role) => roleLabel(role)).join(", ")}
            </span>
          </div>
        </div>
        <ScreenshotPanel title={section.title} src={section.screenshot} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div className="rounded-md bg-[#f4f4f5] p-4">
          <h3 className="font-semibold">Pasos</h3>
          <ol className="mt-3 space-y-2 text-sm leading-6 text-black/65">
            {section.steps.map((step, index) => (
              <li key={step} className="grid grid-cols-[1.75rem_1fr] gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-white text-xs font-semibold text-[#e4252c]">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="grid gap-3">
          <InfoBox title="Recomendacion" text={section.recommendation} />
          <InfoBox title="Error comun" text={section.commonError} />
          {section.warning ? <InfoBox title="Importante" text={section.warning} tone="warning" /> : null}
        </div>
      </div>
    </article>
  );
}

function InfoBox({ title, text, tone = "neutral" }: { title: string; text: string; tone?: "neutral" | "warning" }) {
  const classes = tone === "warning" ? "border-[#e4252c]/25 bg-[#fff1f2] text-[#7f1d1d]" : "border-black/10 bg-white text-black/65";

  return (
    <div className={`rounded-md border p-4 ${classes}`}>
      <p className="text-sm font-semibold text-black">{title}</p>
      <p className="mt-2 text-sm leading-6">{text}</p>
    </div>
  );
}

function roleLabel(role: AppRole) {
  const labels: Record<AppRole, string> = {
    technical_owner: "Technical owner",
    business_owner: "Dueno",
    admin: "Admin",
    vendedor: "Vendedor",
    bodega: "Bodega",
    contadora: "Contadora",
    soporte: "Soporte",
    cliente: "Cliente",
  };

  return labels[role];
}

export default async function AdminGuidePage() {
  const profile = await requirePermission("admin:access");
  const visibleSections = guideSections.filter((section) => isVisibleToRole(profile, section.roles, section.permissions));
  const visibleFaqs = faqs.filter((faq) => hasAnyPermission(profile, faq.permissions));

  return (
    <AdminShell title="Guia interna">
      <section className="space-y-6">
        <div className="rounded-lg border border-black/10 bg-white p-5">
          <p className="text-sm text-black/50">Manual operativo del CRM/Admin</p>
          <h1 className="mt-1 text-2xl font-semibold">Como usar Car Zone Accesorios paso a paso</h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-black/60">
            Esta guia capacita al dueno y al equipo interno. Muestra contenido segun rol y evita informacion tecnica sensible.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <InfoBox title="Tienda publica" text="Es lo que ve el cliente: catalogo, carrito, checkout, rastreo, cuenta y facturas." />
            <InfoBox title="Panel administrativo" text="Es el espacio del equipo para operar pedidos, productos, inventario, facturas, clientes y reportes." />
            <InfoBox title="Regla diaria" text="Cada accion importante debe quedar dentro del sistema: estado, nota, pago, factura o seguimiento." />
          </div>
        </div>

        <nav className="rounded-lg border border-black/10 bg-white p-4">
          <p className="text-sm font-semibold">Indice rapido</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {visibleSections.map((section) => (
              <a key={section.id} href={`#${section.id}`} className="rounded-md border border-black/10 px-3 py-2 text-sm text-black/65 hover:border-[#e4252c] hover:text-[#e4252c]">
                {section.title}
              </a>
            ))}
          </div>
        </nav>

        <div className="space-y-5">
          {visibleSections.map((section) => (
            <GuideCard key={section.id} section={section} />
          ))}
        </div>

        <section className="rounded-lg border border-black/10 bg-white p-5">
          <p className="text-sm text-black/50">Resumen por rol</p>
          <h2 className="mt-1 text-xl font-semibold">Que puede hacer cada usuario</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {roleGuides.map((role) => (
              <article key={role.role} className="rounded-lg border border-black/10 p-4">
                <h3 className="font-semibold">{role.label}</h3>
                <p className="mt-3 text-sm font-semibold text-black/70">Puede hacer</p>
                <ul className="mt-2 space-y-1 text-sm leading-6 text-black/60">
                  {role.canDo.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
                <p className="mt-3 text-sm font-semibold text-black/70">No debe hacer</p>
                <ul className="mt-2 space-y-1 text-sm leading-6 text-black/60">
                  {role.cannotDo.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-black/10 bg-white p-5">
          <p className="text-sm text-black/50">Preguntas frecuentes</p>
          <h2 className="mt-1 text-xl font-semibold">Respuestas rapidas para operacion diaria</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {visibleFaqs.map((faq) => (
              <article key={faq.question} className="rounded-md bg-[#f4f4f5] p-4">
                <h3 className="font-semibold">{faq.question}</h3>
                <p className="mt-2 text-sm leading-6 text-black/62">{faq.answer}</p>
              </article>
            ))}
          </div>
        </section>
      </section>
    </AdminShell>
  );
}
