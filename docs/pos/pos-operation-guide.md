# Guía de operación del Punto de Venta

## Flujo normal

1. Abre **Administración → Punto de Venta**.
2. Busca al cliente por nombre, empresa, teléfono, correo o RTN. Si no existe, usa **Cliente rápido** para crear únicamente su perfil comercial interno.
3. Confirma si el cliente es minorista o mayorista y revisa su crédito disponible. Mayoreo y crédito son condiciones independientes.
4. Crea el borrador y agrega productos por nombre, SKU o código interno. Revisa existencia, impuesto y precio resuelto. Las líneas marcadas **Sin control de inventario** corresponden a servicios y no requieren existencia.
5. Ajusta cantidades. Los roles autorizados pueden aplicar un precio manual con la justificación solicitada por la pantalla.
6. Elige una fecha fiscal permitida y un solo método: efectivo, transferencia bancaria, tarjeta o crédito comercial.
7. En efectivo registra el monto recibido; el servidor calculará el cambio. En transferencia confirma la verificación y referencia. Tarjeta no distingue crédito o débito.
8. Revisa cliente, líneas, gravado, exento, ISV, total, método y advertencias.
9. Marca la confirmación explícita y pulsa **Confirmar venta** una sola vez.
10. Conserva en pantalla el resultado hasta ver pedido y factura. Descarga la factura PDF o imprime el recibo.

## Reglas operativas

- Un borrador no es una venta y no reserva inventario.
- Un servicio sin control de inventario no debe mostrar advertencia de stock ni crear movimientos de inventario al confirmarse.
- No recargues ni crees otro carrito mientras una confirmación sigue procesándose.
- Nunca ingreses número completo de tarjeta, CVV, PIN o vencimiento.
- Una venta a crédito crea CxC; no crea un pago total ficticio.
- La venta genera eventos/borradores contables. La publicación continúa siendo manual.
- La fecha fiscal queda inmutable después de emitir la factura.

## Cliente interno y cuenta pública

El cliente rápido crea un perfil CRM, no credenciales. Si el cliente obtiene una cuenta pública posteriormente, utiliza el flujo administrativo de vinculación. La vinculación conserva historial, mayoreo, crédito, pedidos, facturas y saldos; no debe duplicar datos económicos.
