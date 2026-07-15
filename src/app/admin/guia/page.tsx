import Link from "next/link";
import Image from "next/image";
import { AdminBackButton } from "@/components/admin/admin-back-button";
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
    summary: "Vista general de la tienda pública y el panel administrativo.",
    roles: allAdminRoles,
    what: "Car Zone Accesorios es el sistema donde se organizan las ventas, la atención, el inventario, los pedidos, las facturas y el seguimiento comercial.",
    purpose: "Sirve para que cada área trabaje con la misma información y el dueño pueda revisar el estado del negocio sin depender de hojas sueltas.",
    steps: [
      "Usa la tienda pública para ver cómo compra el cliente.",
      "Usa el panel administrativo para operar productos, pedidos, clientes, facturas y reportes.",
      "Revisa solo los módulos habilitados para tu rol.",
      "Registra notas o cambios importantes dentro del sistema para dejar historial.",
    ],
    recommendation: "Empieza el día revisando el Dashboard, los pedidos y las alertas que correspondan a tu área.",
    commonError: "Confundir la tienda pública con el panel administrativo. La tienda es para clientes; el panel es para el equipo interno.",
  },
  {
    id: "inicio-sesion",
    title: "Inicio de sesión",
    summary: "Acceso seguro para cada usuario interno.",
    href: "/login",
    roles: allAdminRoles,
    what: "Cada persona entra con su propio usuario para que el sistema registre quién realiza cada acción.",
    purpose: "Protege la información de clientes, pagos, facturas y la operación diaria.",
    steps: [
      "Abre la página de inicio de sesión.",
      "Escribe tu correo o usuario.",
      "Escribe tu contraseña.",
      "Si olvidaste la contraseña, usa Recuperar contraseña.",
      "Cierra sesión cuando uses una computadora compartida.",
    ],
    recommendation: "No compartas contraseñas. Si alguien necesita acceso, el responsable debe crearle un usuario con el rol correcto.",
    commonError: "Usar la cuenta de otra persona. Esto afecta la auditoría y puede ocultar quién hizo un cambio.",
    warning: "Nunca guardes contraseñas en chats, notas visibles o capturas.",
  },
  {
    id: "dashboard",
    title: "Dashboard",
    summary: "Indicadores, alertas y accesos rápidos del negocio.",
    href: "/admin",
    screenshot: "/help/car-zone/dashboard.png",
    roles: allAdminRoles,
    permissions: ["admin:access"],
    what: "Es la primera pantalla del panel. Resume pendientes, ventas, inventario, clientes y tareas según los permisos.",
    purpose: "Ayuda a decidir qué atender primero: pedidos nuevos, pagos pendientes, existencias bajas, facturas o clientes.",
    steps: [
      "Revisa los indicadores principales.",
      "Lee las alertas importantes antes de cambiar estados.",
      "Usa los accesos rápidos para ingresar al módulo correspondiente.",
      "Si una tarjeta no aparece, puede ser porque tu rol no tiene permiso para verla.",
    ],
    recommendation: "El dueño o el administrador debe revisar esta pantalla al iniciar y cerrar el día.",
    commonError: "Ignorar alertas de stock, reservas o pagos y avanzar pedidos sin validar.",
  },
  {
    id: "productos",
    title: "Productos",
    summary: "Crear, editar, publicar y mantener productos del catálogo.",
    href: "/admin/productos",
    screenshot: "/help/car-zone/productos.png",
    roles: businessRoles,
    permissions: ["products:read", "products:manage"],
    what: "Módulo para administrar el nombre, SKU, categoría, precios, compatibilidad, estado e imágenes de cada producto.",
    purpose: "Mantiene el catálogo ordenado y evita vender productos con datos incompletos.",
    steps: [
      "Entra a Productos.",
      "Presiona crear producto o abre uno existente.",
      "Completa el nombre, SKU, categoría y descripción.",
      "Define precio normal y precio mayorista cuando aplique.",
      "Sube imágenes nítidas del producto.",
      "Revisa la compatibilidad por marca, modelo o año, si aplica.",
      "Activa el producto solo cuando esté listo para vender.",
      "Si no debe venderse, desactívalo o cámbialo a un estado no visible.",
    ],
    recommendation: "Usa un SKU único, nombres claros y fotos reales. Antes de publicar, confirma el precio y las existencias.",
    commonError: "Activar un producto sin imagen, sin stock o con precio mayorista incorrecto.",
  },
  {
    id: "inventario",
    title: "Inventario",
    summary: "Stock disponible, reservado, agotado y movimientos.",
    href: "/admin/inventario",
    screenshot: "/help/car-zone/inventario.png",
    roles: warehouseRoles,
    permissions: ["inventory:manage"],
    what: "Controla unidades disponibles, reservas activas, productos agotados y movimientos de entrada o salida.",
    purpose: "Evita la sobreventa y ayuda a preparar pedidos con información confiable.",
    steps: [
      "Busca el producto por SKU, código o nombre.",
      "Revisa stock disponible antes de prometer entrega.",
      "Identifica stock reservado: son unidades apartadas por pedidos en proceso.",
      "Revisa los productos por debajo del mínimo para solicitar reposición.",
      "Registra la entrada cuando llegue mercadería física.",
      "Registra salida o ajuste solo con motivo claro.",
    ],
    recommendation: "Cuenta físicamente antes de ajustar. Las reservas no deben liberarse manualmente sin revisar el pedido.",
    commonError: "Confundir las existencias reservadas con las disponibles y prometer unidades que ya están apartadas.",
  },
  {
    id: "pedidos",
    title: "Pedidos",
    summary: "Revisión, pago, cancelación y flujo logístico.",
    href: "/admin/pedidos",
    screenshot: "/help/car-zone/pedidos.png",
    roles: ["technical_owner", "business_owner", "admin", "vendedor", "bodega", "soporte"],
    permissions: ["orders:read", "orders:manage", "orders:manage_logistics"],
    what: "Reúne los pedidos nuevos, los datos del cliente, los productos, el pago, la reserva, las notas internas y el estado logístico.",
    purpose: "Permite atender cada compra desde recibida hasta entregada.",
    steps: [
      "Entra a Pedidos.",
      "Filtra pedidos nuevos o pendientes.",
      "Abre un pedido y revisa productos, cantidades y datos del cliente.",
      "Valida el método de pago antes de avanzar.",
      "Confirma o rechaza pago solo si tienes permiso.",
      "Avanza el estado según el proceso: preparación, empacado, enviado, en ruta y entregado.",
      "Cancela solo cuando exista una razón clara y el flujo lo permita.",
      "Agrega una nota interna si hay una situación especial.",
    ],
    recommendation: "No prepares pedidos con pago pendiente, salvo flujo autorizado de pago contra entrega.",
    commonError: "Cambiar el estado logístico sin revisar el pago, las existencias reservadas o los datos de contacto.",
  },
  {
    id: "metodos-pago",
    title: "Métodos de pago",
    summary: "Efectivo, transferencia y tarjeta mediante enlace externo.",
    href: "/admin/pedidos?task=pending_payments",
    roles: businessRoles,
    permissions: ["payments:read", "payments:confirm", "payments:reject"],
    what: "El sistema registra el método elegido y permite confirmar o rechazar pagos según la evidencia.",
    purpose: "Ordena la validación del dinero antes de preparar, entregar o facturar.",
    steps: [
      "Efectivo: se confirma cuando el dinero se recibe realmente, normalmente al entregar.",
      "Transferencia: revisa referencia, monto y comprobante si existe.",
      "Si la transferencia no coincide, rechaza con motivo claro.",
      "Tarjeta mediante enlace: el sitio no procesa tarjetas.",
      "El cliente elige tarjeta y el pedido queda pendiente.",
      "El equipo contacta al cliente por WhatsApp y envía el enlace de pago externo.",
      "El cliente paga fuera del sitio y envía el comprobante o la confirmación.",
      "El administrador confirma manualmente cuando el pago está verificado.",
    ],
    recommendation: "Confirma pagos solo con evidencia suficiente. Si hay duda, llama o escribe al cliente antes de aprobar.",
    commonError: "Marcar la tarjeta como pagada antes de recibir la confirmación real del pago externo.",
    warning: "Nunca pidas el número de tarjeta, CVV ni la fecha de vencimiento dentro del sistema o por chat.",
  },
  {
    id: "whatsapp",
    title: "WhatsApp",
    summary: "Contacto rápido con clientes y envío manual de documentos.",
    roles: salesRoles,
    permissions: ["orders:read", "crm:manage", "customers:read"],
    what: "Los botones de WhatsApp ayudan a abrir una conversación con un mensaje prellenado cuando existe un teléfono del cliente.",
    purpose: "Permite confirmar datos, enviar instrucciones de pago, coordinar la entrega y compartir archivos PDF manualmente.",
    steps: [
      "Abre el pedido o perfil del cliente.",
      "Usa el botón de WhatsApp si está disponible.",
      "Revisa el mensaje prellenado antes de enviarlo.",
      "Para pagos con tarjeta mediante enlace, pega el enlace externo seguro en la conversación.",
      "Para facturas, descarga el PDF y adjúntalo manualmente si el cliente lo solicita.",
      "Llama al cliente si hay un pago dudoso, una dirección incompleta o una entrega urgente.",
    ],
    recommendation: "Mantén los mensajes cortos, claros y con el número de pedido cuando aplique.",
    commonError: "Enviar datos del pedido equivocado por no revisar el nombre, el teléfono y el número de pedido.",
  },
  {
    id: "facturacion",
    title: "Facturación fiscal",
    summary: "CAI, correlativo, rango, vista previa, PDF e impresión.",
    href: "/admin/facturas",
    screenshot: "/help/car-zone/facturacion.png",
    roles: fiscalRoles,
    permissions: ["invoices:read", "invoices:create", "fiscal:read"],
    what: "Módulo para emitir y consultar facturas fiscales con CAI, correlativo y rango autorizado.",
    purpose: "Formaliza ventas pagadas y mantiene historial fiscal del negocio.",
    steps: [
      "Verifica que el pedido tenga pago confirmado.",
      "Confirma que los datos fiscales del cliente estén correctos.",
      "Revisa que exista CAI, rango autorizado y correlativo disponible.",
      "Genera la factura desde el pedido cuando el botón esté habilitado.",
      "Revisa la vista previa de la factura.",
      "Abre la factura en navegador, descarga PDF o imprime.",
      "Desde celular, abre la factura y usa Compartir o Guardar PDF del navegador.",
      "Si el pedido ya tiene factura, solo consulta, reimprime o descarga la existente.",
    ],
    recommendation: "Antes de emitir, revisa el nombre o la razón social y el RTN. Después de emitir, el manejo fiscal debe seguir el procedimiento correspondiente.",
    commonError: "Intentar facturar sin pago confirmado o con CAI/rango vencido.",
    warning: "Abrir, descargar o imprimir una factura existente no consume correlativo. Solo generar una factura nueva consume correlativo.",
  },
  {
    id: "correccion-fiscal",
    title: "Corrección de datos fiscales",
    summary: "Nombre, razón social, RTN y auditoría interna.",
    href: "/admin/facturas",
    roles: fiscalRoles,
    permissions: ["invoices:correct"],
    what: "Permite corregir los datos fiscales del cliente cuando el proceso y el permiso lo permiten.",
    purpose: "Evita emitir una factura con el nombre, la razón social o el RTN incorrectos.",
    steps: [
      "Antes de emitir la factura, revisa el nombre o la razón social.",
      "Revisa el RTN si el cliente lo proporcionó.",
      "Corrige datos antes de emitir cuando sea necesario.",
      "Después de emitirla, sigue el proceso fiscal correspondiente y deja un motivo.",
      "Toda corrección debe quedar registrada con una razón clara para la auditoría interna.",
    ],
    recommendation: "Pide una confirmación escrita al cliente cuando cambie el RTN o la razón social.",
    commonError: "Emitir primero y corregir después por no revisar los datos fiscales a tiempo.",
  },
  {
    id: "clientes",
    title: "Clientes",
    summary: "Clientes, historial, datos comerciales y cuenta.",
    href: "/admin/clientes",
    screenshot: "/help/car-zone/clientes.png",
    roles: salesRoles,
    permissions: ["crm:manage", "customers:read"],
    what: "Centraliza clientes, prospectos, historial de compras, datos de cuenta, notas y actividad comercial.",
    purpose: "Permite revisar el contexto del cliente antes de llamar, vender, responder o escalar una situación.",
    steps: [
      "Busca al cliente por nombre, empresa, teléfono o correo electrónico.",
      "Abre el perfil para revisar historial.",
      "Confirma si es cliente normal, mayorista o cuenta de prueba.",
      "Revisa pedidos, facturas y notas relacionadas antes de responder.",
      "Evita crear duplicados: compara el teléfono, el correo electrónico y el nombre comercial.",
    ],
    recommendation: "Antes de editar datos, valida que estás en el cliente correcto y que la información proviene de una fuente confiable.",
    commonError: "Crear clientes duplicados sin revisar el teléfono o el correo electrónico existente.",
  },
  {
    id: "crm",
    title: "CRM",
    summary: "Notas, seguimientos, oportunidades y tareas vencidas.",
    href: "/admin/crm",
    screenshot: "/help/car-zone/crm.png",
    roles: salesRoles,
    permissions: ["crm:manage", "customers:read"],
    what: "Organiza la atención comercial: notas, seguimientos, oportunidades, tareas vencidas y acuerdos con clientes.",
    purpose: "Ayuda a dar seguimiento sin perder información entre ventas, soporte y administración.",
    steps: [
      "Entra a CRM para revisar seguimientos pendientes o vencidos.",
      "Agrega notas con acuerdos, dudas o llamadas.",
      "Crea seguimientos con fecha y prioridad.",
      "Revisa tareas vencidas para retomar contactos pendientes.",
      "Cierra los seguimientos cuando la acción se complete.",
      "Usa el historial para entender qué se prometió antes de volver a contactar al cliente.",
    ],
    recommendation: "Cada llamada o acuerdo importante debe quedar como nota. Eso evita depender de memoria o chats externos.",
    commonError: "Cerrar seguimientos sin registrar qué se hizo o cuál fue el próximo paso.",
  },
  {
    id: "mayoristas",
    title: "Mayoristas",
    summary: "Solicitudes, aprobación, códigos y precios especiales.",
    href: "/admin/clientes-mayoristas",
    screenshot: "/help/car-zone/mayoristas.png",
    roles: businessRoles,
    permissions: ["wholesale:manage"],
    what: "Gestiona solicitudes de clientes que quieren comprar como mayoristas.",
    purpose: "Permite aprobar precios especiales solo para las cuentas que cumplen el criterio comercial.",
    steps: [
      "Revisa la solicitud mayorista.",
      "Valida negocio, contacto, ciudad y necesidad real.",
      "Aprueba si cumple los criterios.",
      "Rechaza con motivo si no aplica.",
      "Suspende si la cuenta deja de cumplir condiciones.",
      "Cuando un cliente queda aprobado, puede ver precios mayoristas al iniciar sesión.",
      "Si existen códigos mayoristas, revisa su vigencia, uso y cliente asociado.",
    ],
    recommendation: "Antes de aprobar, confirma que el cliente realmente compra para un negocio, taller, distribución o por volumen.",
    commonError: "Aprobar cuentas sin validarlas y afectar los márgenes de venta al detalle.",
  },
  {
    id: "banners",
    title: "Banners",
    summary: "Promociones, prioridad, imagen, video y estado.",
    href: "/admin/banners",
    screenshot: "/help/car-zone/banners.png",
    roles: businessRoles,
    permissions: ["commercial_settings:manage"],
    what: "Administra banners visibles en la tienda para promociones, temporadas o avisos importantes.",
    purpose: "Permite destacar campañas sin cambiar productos ni la estructura del sitio.",
    steps: [
      "Entra a Banners.",
      "Crea un banner con un título claro.",
      "Elige la posición principal o secundaria, si aplica.",
      "Asigna una prioridad de 1 a 5; la prioridad más alta se muestra primero según la configuración.",
      "Sube una imagen o un video liviano y claro.",
      "Define fechas si la campaña es temporal.",
      "Activa o desactiva según sea necesario.",
      "Elimina solo banners que ya no deban usarse.",
    ],
    recommendation: "Usa textos cortos y piezas visuales legibles en celular.",
    commonError: "Crear varios banners activos con la misma prioridad y fechas superpuestas.",
    warning: "Al eliminar un banner, el sistema limpia internamente el archivo asociado cuando corresponde.",
  },
  {
    id: "reportes",
    title: "Reportes",
    summary: "Ventas, clientes, inventario, información fiscal y exportaciones.",
    href: "/admin/reportes",
    screenshot: "/help/car-zone/reportes.png",
    roles: ["technical_owner", "business_owner", "admin", "contadora"],
    permissions: ["reports:read", "reports:fiscal_read"],
    what: "Reúne información para revisar ventas, clientes, productos, inventario, pagos y facturación.",
    purpose: "Ayuda a tomar decisiones y preparar cierres administrativos o fiscales.",
    steps: [
      "Entra a Reportes.",
      "Elige tipo de reporte.",
      "Filtra por fecha inicial y final.",
      "Agrega filtros de cliente, producto, estado o método de pago, si aplica.",
      "Revisa totales antes de exportar.",
      "Exporta solo la información necesaria para el cierre o análisis.",
    ],
    recommendation: "Para cierres, usa rangos de fecha exactos y compara pedidos contra facturas cuando aplique.",
    commonError: "Exportar sin filtros y mezclar información operativa con información fiscal.",
  },
  {
    id: "roles",
    title: "Seguridad, roles y permisos",
    summary: "Usuarios, auditoría y alcance de cada rol.",
    href: "/admin/seguridad",
    screenshot: "/help/car-zone/seguridad.png",
    roles: allAdminRoles,
    permissions: ["admin:access"],
    what: "Cada usuario tiene un rol para limitar lo que puede ver y hacer dentro del sistema.",
    purpose: "Protege la información sensible y reduce los errores operativos.",
    steps: [
      "Technical Owner: acceso técnico y supervisión completa.",
      "Business Owner: control operativo amplio del negocio.",
      "Administrador: operación diaria con productos, pedidos, pagos, facturas, CRM y reportes.",
      "Vendedor: clientes, CRM y consulta de pedidos.",
      "Bodega: inventario, reservas y estados logísticos.",
      "Contadora: facturas, CAI, reportes fiscales y exportaciones contables.",
      "Soporte: clientes, CRM, pedidos y facturas de consulta.",
      "Cliente: tienda pública, sus pedidos y sus facturas.",
    ],
    recommendation: "Asigna siempre el rol mínimo necesario. Si alguien cambia de puesto, actualiza o suspende su acceso.",
    commonError: "Dar permisos de administrador a usuarios que solo necesitan vender, preparar pedidos o consultar facturas.",
  },
  {
    id: "configuracion",
    title: "Configuración",
    summary: "Datos del negocio, contacto, preferencias y fiscal.",
    href: "/admin/configuracion",
    screenshot: "/help/car-zone/configuracion.png",
    roles: businessRoles,
    permissions: ["settings:manage", "commercial_settings:manage", "settings:fiscal"],
    what: "Contiene datos públicos del negocio, contacto, preferencias operativas, notificaciones y configuración fiscal.",
    purpose: "Mantiene la información correcta en la tienda, las comunicaciones, los reportes y los documentos.",
    steps: [
      "Actualiza datos de negocio cuando cambien.",
      "Revisa los teléfonos, el correo electrónico y el WhatsApp de servicio al cliente.",
      "Configura las preferencias de notificación según las responsabilidades.",
      "La configuración fiscal debe modificarse solo con autorización.",
      "No cambies CAI, rango o correlativo si no sabes el impacto fiscal.",
    ],
    recommendation: "Los datos fiscales deben revisarse con la contadora o responsable antes de emitir facturas reales.",
    commonError: "Cambiar datos fiscales o preferencias globales sin avisar al equipo.",
    warning: "Esta guía no muestra secretos, claves, tokens ni configuraciones técnicas internas.",
  },
  {
    id: "ayuda",
    title: "Ayuda interna",
    summary: "Respuesta rápida para tareas frecuentes.",
    href: "/admin/ayuda",
    screenshot: "/help/car-zone/ayuda.png",
    roles: allAdminRoles,
    permissions: ["admin:access"],
    what: "Resume acciones comunes por tarea para que el equipo encuentre rápidamente qué revisar y qué evitar.",
    purpose: "Sirve como apoyo diario cuando alguien necesita una respuesta breve antes de abrir el módulo completo.",
    steps: [
      "Entra a Ayuda interna desde el Dashboard o desde esta guía.",
      "Busca el bloque relacionado con la tarea: pedidos, pagos, inventario, facturas, CRM o reportes.",
      "Lee la lista de verificación rápida antes de cambiar estados o confirmar información.",
      "Usa Ver manual completo cuando necesites el proceso detallado.",
    ],
    recommendation: "Usa Ayuda para resolver dudas operativas sencillas y la Guía para capacitación o revisión completa.",
    commonError: "Pedir cambios al sistema antes de revisar si el comportamiento depende de permisos o estado del registro.",
  },
  {
    id: "guia",
    title: "Guía interna",
    summary: "Manual completo de uso del CRM/Admin.",
    href: "/admin/guia",
    screenshot: "/help/car-zone/guia.png",
    roles: allAdminRoles,
    permissions: ["admin:access"],
    what: "Explica, módulo por módulo, cómo operar el CRM/Admin de Car Zone Accesorios sin exponer información técnica sensible.",
    purpose: "Funciona como documento de capacitación para el dueño, administradores, ventas, bodega, contabilidad y soporte.",
    steps: [
      "Abre el índice rápido para ir al módulo que necesitas.",
      "Lee primero qué hace el módulo y para qué sirve.",
      "Sigue los pasos operativos en orden.",
      "Revisa las recomendaciones, los errores comunes y las advertencias antes de actuar.",
      "Regresa al módulo con Abrir módulo cuando estés listo para operar.",
    ],
    recommendation: "Mantén esta guía actualizada después de realizar cambios visibles en los flujos administrativos.",
    commonError: "Actualizar funcionalidades del sistema sin actualizar el material interno de capacitación.",
  },
];

const roleGuides: RoleGuide[] = [
  {
    role: "technical_owner",
    label: "Technical Owner",
    canDo: ["Supervisar todo el sistema.", "Revisar la seguridad, el uso y las herramientas técnicas.", "Apoyar el mantenimiento y la auditoría."],
    cannotDo: ["Compartir accesos técnicos.", "Usar datos reales para pruebas sin control."],
  },
  {
    role: "business_owner",
    label: "Business Owner",
    canDo: ["Ver la operación completa.", "Gestionar usuarios operativos.", "Revisar ventas, pagos, facturas, clientes y reportes."],
    cannotDo: ["Modificar configuraciones fiscales sin validación.", "Compartir su cuenta con el equipo."],
  },
  {
    role: "admin",
    label: "Administrador",
    canDo: ["Gestionar productos, pedidos, pagos, facturas, CRM, mayoristas y reportes.", "Atender la operación diaria."],
    cannotDo: ["Usar herramientas técnicas reservadas.", "Asignar permisos por encima de su alcance."],
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
    canDo: ["Gestionar el inventario.", "Revisar reservas.", "Avanzar estados logísticos."],
    cannotDo: ["Confirmar pagos.", "Emitir facturas.", "Aprobar mayoristas."],
  },
  {
    role: "contadora",
    label: "Contadora",
    canDo: ["Consultar facturas.", "Revisar CAI, correlativos y reportes fiscales.", "Exportar la información contable permitida."],
    cannotDo: ["Modificar inventario.", "Confirmar pagos.", "Gestionar CRM operativo."],
  },
  {
    role: "soporte",
    label: "Soporte",
    canDo: ["Atender clientes.", "Consultar pedidos y facturas.", "Registrar notas y seguimientos."],
    cannotDo: ["Confirmar pagos.", "Cambiar la configuración fiscal.", "Modificar el inventario."],
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
    question: "¿Por qué no puedo generar una factura?",
    answer: "Normalmente falta pago confirmado, el pedido no cumple condiciones, ya existe factura, o hay un problema con CAI, rango o datos fiscales.",
    permissions: ["invoices:create", "invoices:read"],
  },
  {
    question: "¿Por qué no puedo confirmar un pago?",
    answer: "Puede que tu rol no tenga permiso, que el pedido ya esté cancelado, que el pago ya esté aprobado o rechazado, o que sea un pago contra entrega que aún no corresponde confirmar.",
    permissions: ["payments:confirm", "payments:read"],
  },
  {
    question: "¿Por qué un producto no aparece en el catálogo?",
    answer: "Revisa que esté activo, tenga un estado visible, una categoría correcta, una imagen adecuada y existencias disponibles si la configuración lo requiere.",
    permissions: ["products:manage", "products:read"],
  },
  {
    question: "¿Por qué un pedido no aparece en el rastreo?",
    answer: "El rastreo público muestra pedidos con un código válido y un estado permitido. Si el pedido está cancelado o no tiene código, puede que no se muestre.",
    permissions: ["orders:read", "orders:manage"],
  },
  {
    question: "¿Cómo descargo una factura desde el celular?",
    answer: "Abre la factura, usa el visor del navegador y luego elige Compartir, Guardar en archivos o Descargar, según el teléfono.",
    permissions: ["invoices:read"],
  },
  {
    question: "¿Qué hago si el cliente quiere pagar con tarjeta?",
    answer: "El sitio no procesa tarjetas. Contacta al cliente por WhatsApp, envía el enlace externo autorizado y confirma manualmente solo cuando el pago esté verificado.",
    permissions: ["payments:confirm", "orders:read"],
  },
  {
    question: "¿Qué hago si el banner no aparece?",
    answer: "Revisa si está activo, dentro de las fechas definidas, con la prioridad correcta y con una imagen o un video válido.",
    permissions: ["commercial_settings:manage"],
  },
  {
    question: "¿Qué hago si un producto no tiene existencias?",
    answer: "No prometas una entrega inmediata. Revisa el inventario, los productos alternos o solicita una reposición.",
    permissions: ["inventory:manage", "products:read"],
  },
  {
    question: "¿Qué significa existencias reservadas?",
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
  if (!src) return null;

  return (
    <figure className="min-w-0 overflow-hidden rounded-md border border-black/10 bg-[#f4f4f5]">
      <Image
        src={src}
        alt={`Captura real del módulo ${title}`}
        width={1440}
        height={900}
        sizes="(max-width: 1024px) 100vw, 52vw"
        className="h-auto w-full object-contain"
      />
    </figure>
  );
}

function GuideCard({ section }: { section: GuideSection }) {
  return (
    <article id={section.id} className="scroll-mt-6 rounded-lg border border-black/10 bg-white p-4 sm:p-5">
      <div className={section.screenshot ? "grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" : "grid gap-5"}>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase text-[#e4252c]">{section.summary}</p>
          <h2 className="mt-1 text-xl font-semibold sm:text-2xl">{section.title}</h2>
          <p className="mt-3 text-sm leading-6 text-black/65">{section.what}</p>
          <p className="mt-3 text-sm leading-6 text-black/65">{section.purpose}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {section.href ? (
              <Link href={section.href} className="rounded-md bg-[#080808] px-3 py-2 text-sm font-semibold text-white">
                Abrir módulo
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
          <InfoBox title="Recomendación" text={section.recommendation} />
          <InfoBox title="Error común" text={section.commonError} />
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
    technical_owner: "Technical Owner",
    business_owner: "Business Owner",
    admin: "Administrador",
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
    <AdminShell title="Guía interna">
      <AdminBackButton />
      <section className="space-y-6">
        <div className="rounded-lg border border-black/10 bg-white p-5">
          <p className="text-sm text-black/50">Manual operativo del CRM/Admin</p>
          <h1 className="mt-1 text-2xl font-semibold">Cómo usar Car Zone Accesorios paso a paso</h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-black/60">
            Esta guía capacita al dueño y al equipo interno. Muestra contenido según el rol y evita exponer información técnica sensible.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <InfoBox title="Tienda pública" text="Es lo que ve el cliente: catálogo, carrito, checkout, rastreo, cuenta y facturas." />
            <InfoBox title="Panel administrativo" text="Es el espacio del equipo para operar pedidos, productos, inventario, facturas, clientes y reportes." />
            <InfoBox title="Regla diaria" text="Cada acción importante debe quedar registrada dentro del sistema: estado, nota, pago, factura o seguimiento." />
          </div>
        </div>

        <nav className="rounded-lg border border-black/10 bg-white p-4">
          <p className="text-sm font-semibold">Índice rápido</p>
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
          <h2 className="mt-1 text-xl font-semibold">Qué puede hacer cada usuario</h2>
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
          <h2 className="mt-1 text-xl font-semibold">Respuestas rápidas para la operación diaria</h2>
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
