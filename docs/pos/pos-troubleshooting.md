# Solución de problemas del Punto de Venta

## Stock insuficiente

Actualiza el carrito y revisa existencias. Otra venta puede haber consumido la última unidad. No cambies stock para forzar la confirmación.

Si la línea es un servicio, confirma que aparezca **Sin control de inventario**. Un servicio no debe bloquearse por stock; si ocurre, detén la operación y escala el caso.

## Crédito insuficiente o suspendido

Revisa límite, saldo abierto, vencidos y estado del crédito. Cambia a un método pagado o solicita una modificación comercial por el flujo autorizado. No manipules el payload.

## Precio cambiado

El producto cambió después de guardarse el borrador. Recarga el producto y revisa nuevamente precio e impuestos antes de confirmar.

## Fecha fiscal inválida

Usa una fecha permitida según Honduras. Una factura emitida no puede cambiarse. No edites directamente la base.

## Rango fiscal o CAI

Detén la venta y solicita revisión de configuración fiscal. No reutilices correlativos ni elimines facturas.

## Transferencia o tarjeta rechazada

Confirma que la transferencia esté verificada y tenga referencia. Para tarjeta registra únicamente la referencia permitida; nunca datos sensibles.

## Timeout o respuesta perdida

No crees otro carrito. Mantén el mismo borrador y usa **Recuperar confirmación** o recarga la pantalla. El sistema consultará la venta existente y no debe crear una segunda.

## Venta ya confirmada

Abre el resultado recuperado y reimprime los documentos. No repitas la operación con otra request key.

## Permiso denegado

Sólo `technical_owner`, `business_owner` y `admin` pueden confirmar. La contadora conserva la revisión/publicación contable, pero no recibe permiso POS.

Si uno de esos tres roles recibe un 403, no cambies su rol ni edites permisos en la base: conserva el borrador y escala la incompatibilidad entre el permiso `pos:confirm_sale` y la aplicación.

## Escalamiento

Registra hora, operador, cliente, draft, método y mensaje sanitizado. No copies cookies, tokens, credenciales, datos completos de tarjeta ni stack traces al usuario.
