import type { LegalSection } from "@/components/store/legal-page";

export const legalPages: Record<string, { title: string; intro: string; sections: LegalSection[] }> = {
  terms: {
    title: "Términos y condiciones",
    intro: "Condiciones generales para usar la tienda en línea de Car Zone Accesorios.",
    sections: [
      {
        title: "Uso del sitio",
        body: "El cliente se compromete a utilizar este sitio para consultas y compras legítimas. La información de productos, precios y disponibilidad puede actualizarse según inventario real.",
      },
      {
        title: "Pedidos y confirmación",
        body: "Todo pedido queda sujeto a validación de datos, disponibilidad de producto, confirmación de pago y cobertura de entrega. El comercio podrá contactar al cliente para confirmar información antes del despacho.",
      },
      {
        title: "Precios y facturación",
        body: "Los precios se muestran en lempiras hondureños. La facturación se emite con los datos proporcionados por el cliente y debe ser revisada antes de confirmar el pedido.",
      },
      {
        title: "Pagos seguros",
        body: "Los pagos con tarjeta serán procesados por una pasarela bancaria autorizada cuando la integración esté activa. Car Zone Accesorios no almacena número de tarjeta, CVV ni fecha de vencimiento.",
      },
    ],
  },
  privacy: {
    title: "Política de privacidad",
    intro: "Resumen de cómo se recopilan y utilizan los datos del cliente.",
    sections: [
      {
        title: "Datos recopilados",
        body: "Podemos solicitar nombre, teléfono, correo electrónico, RTN, dirección de entrega, historial de pedidos y datos necesarios para servicio al cliente.",
      },
      {
        title: "Uso de la información",
        body: "La información se usa para procesar pedidos, coordinar entregas, emitir facturas, brindar soporte, administrar solicitudes mayoristas y cumplir obligaciones legales aplicables.",
      },
      {
        title: "Datos de tarjeta",
        body: "No almacenamos datos sensibles de tarjeta. La información de tarjeta será procesada únicamente por BAC Credomatic o el proveedor autorizado cuando la pasarela esté activa.",
      },
      {
        title: "Seguridad",
        body: "El sitio utiliza HTTPS/TLS y controles de acceso por rol para proteger la información operativa del comercio y de los clientes.",
      },
    ],
  },
  delivery: {
    title: "Política de entrega",
    intro: "Condiciones base de despacho y entrega dentro de Honduras.",
    sections: [
      {
        title: "Cobertura",
        body: "Por ahora realizamos entregas dentro de Honduras. La cobertura exacta puede depender de disponibilidad logística y confirmación del equipo de ventas.",
      },
      {
        title: "Tiempos de entrega",
        body: "Los tiempos pueden variar según ciudad, disponibilidad de producto, método de pago y empresa de entrega. El cliente recibirá seguimiento del pedido cuando esté disponible.",
      },
      {
        title: "Costos de envío",
        body: "El costo de envío se calcula en checkout según la configuración vigente. Algunas compras pueden aplicar a envío gratis según monto mínimo definido por el comercio.",
      },
      {
        title: "Recepción del pedido",
        body: "El cliente debe revisar que los productos recibidos correspondan al pedido. Cualquier incidencia debe reportarse al servicio al cliente en un plazo razonable.",
      },
    ],
  },
  returns: {
    title: "Política de devoluciones",
    intro: "Condiciones base para cambios y devoluciones.",
    sections: [
      {
        title: "Revisión de solicitudes",
        body: "Las solicitudes de devolución se revisan caso por caso. El producto debe conservar empaque, accesorios y condición adecuada, salvo defectos comprobables.",
      },
      {
        title: "Productos instalados o usados",
        body: "Los productos instalados, modificados o con señales de uso pueden estar sujetos a revisión técnica antes de aceptar devolución o cambio.",
      },
      {
        title: "Defectos o errores de despacho",
        body: "Si el producto presenta defecto o no corresponde al pedido, el cliente debe contactar a servicio al cliente con número de pedido, evidencia y descripción del caso.",
      },
      {
        title: "Costos asociados",
        body: "Los costos de retorno o reenvío dependerán del motivo de la devolución y de la validación realizada por el comercio.",
      },
    ],
  },
  cancellation: {
    title: "Política de cancelación",
    intro: "Condiciones para cancelar pedidos antes o después de la confirmación.",
    sections: [
      {
        title: "Pedidos pendientes",
        body: "Un pedido pendiente puede cancelarse antes de ser confirmado o despachado. El cliente debe contactar a servicio al cliente con su número de pedido.",
      },
      {
        title: "Pedidos en preparación o enviados",
        body: "Si el pedido ya está en preparación, empacado o enviado, la cancelación puede requerir revisión logística y podría aplicar costo de envío o gestión.",
      },
      {
        title: "Pagos con tarjeta",
        body: "Cuando la pasarela BAC esté activa, las anulaciones o reversos se procesarán según las reglas del banco, la marca de tarjeta y el estado de la transacción.",
      },
      {
        title: "Pagos por transferencia",
        body: "Los reembolsos por transferencia se revisarán con contabilidad y podrían requerir validación de titularidad de cuenta.",
      },
    ],
  },
};
