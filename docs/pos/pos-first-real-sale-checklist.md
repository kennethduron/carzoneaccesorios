# Checklist de la primera venta real POS

La primera confirmación productiva debe corresponder a una venta real autorizada. No utilices una venta de prueba ni elimines la operación después.

## Antes de confirmar

- [ ] Operador con rol `technical_owner`, `business_owner` o `admin`.
- [ ] Cliente correcto y sin duplicados.
- [ ] Clasificación minorista/mayorista correcta.
- [ ] Crédito habilitado y disponible, si aplica.
- [ ] Productos, cantidades y existencia correctos.
- [ ] Precio minorista, mayorista o manual correcto.
- [ ] Justificación del precio manual visible, si aplica.
- [ ] Fecha fiscal correcta para Honduras.
- [ ] Método y referencia correctos.
- [ ] Gravado, exento, ISV y total revisados.

## Después de confirmar

- [ ] Un solo pedido con origen POS y estado autorizado.
- [ ] Una sola factura y correlativo fiscal.
- [ ] Fecha, CAI, líneas e impuestos correctos.
- [ ] Un pago aprobado o una CxC, nunca ambos por el total.
- [ ] Cambio correcto en efectivo.
- [ ] Inventario y movimientos correctos; servicios sin movimiento.
- [ ] Evento/borrador de ventas y COGS correctos.
- [ ] Ninguna partida publicada automáticamente.
- [ ] Auditoría contiene draft, request key, actor, pedido y factura.
- [ ] PDF y recibo se regeneran sin duplicar la venta.
- [ ] Reintentar la misma confirmación devuelve la venta original.
