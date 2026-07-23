# Transiciones de estado POS — Fase 1

Versión: 1.1
Fecha: 2026-07-21

Este documento describe el futuro coordinador. No crea estados ni operaciones en esta fase.

## Precondiciones comerciales definitivas

Antes de cualquier persistencia, el servidor recalcula mercadería, descuentos e ISV incluido. Para la primera activación mayorista, la mercadería final después de descuentos debe ser al menos L 10,000; entrega y contraentrega no cuentan. Para sugerir entrega, esa misma base produce L 120 por debajo de L 3,000 y L 0 desde L 3,000.

Un descuento requiere `pos:apply_discount` y motivo. Una venta bajo costo agrega una transición explícita `warning_required → exceptionally_confirmed`; sin confirmación y motivo no puede pasar a persistencia. Entrega y contraentrega se resuelven por separado y toda edición manual queda auditada.

## Venta pagada inmediatamente

1. Validar actor/permiso y reclamar `request_key` dentro de la transacción.
2. Resolver cliente, precio, descuentos, umbrales comerciales, ISV, cargos separados, crédito no aplicable y stock con bloqueos.
3. Crear pedido `source=pos`, `created_by=auth.uid()`.
4. Registrar pago aprobado con referencia/evidencia cuando aplique.
5. Reservar y confirmar inventario una sola vez.
6. Emitir factura una sola vez si CAI/rango/fecha son válidos.
7. Registrar `sale_revenue` y movimientos `inventory_cogs`, sin `payment_received`.
8. Auditar y finalizar idempotencia `succeeded`.
9. Generar PDF bajo demanda fuera de la transacción.

## Venta totalmente a crédito

1. Validar cuenta de crédito y bloquear cliente/cuenta/saldos relevantes.
2. Recalcular el total completo y rechazar vencimiento, bloqueo o límite insuficiente.
3. Crear pedido, factura elegible y una cuenta por cobrar por el total.
4. Descontar inventario solo según la modalidad de entrega acordada.
5. Registrar `commercial_credit`, no `sale_revenue` ni `payment_received`.
6. Finalizar la misma clave idempotente.

El abono posterior transita `open → partial → paid`; un vencimiento permite `open|partial → overdue`. Cada abono genera `receivable_payment`. No genera factura, pedido, impuesto o inventario nuevos.

## Transferencia o tarjeta pendiente

```text
pending payment
  ├─ approve → approved payment → confirmed order/reservation → invoice → accounting
  └─ reject  → rejected payment → released reservation → cancelled/rejected order state
```

Al crear: un pedido, un pago `pending`, una reserva; cero factura, ingreso y COGS. La aprobación reutiliza IDs y `request_key`, confirma reserva una vez, emite factura y reconoce la venta. El rechazo libera una vez, no consume correlativo y exige motivo/actor. Nunca se crea un segundo pedido.

## Inventario

Transiciones válidas por reserva:

- `reserved → confirmed`: una salida física y un movimiento de venta;
- `reserved → released`: resta unidades reservadas, no stock físico;
- `reserved → expired`: requiere revisión; no libera automáticamente según el flujo vigente;
- cualquier reintento del mismo estado: no-op idempotente;
- `confirmed → confirmed` y `released → released`: no crean movimientos adicionales.

Los locks se toman en orden estable por `product_id` para reducir deadlocks.

## Factura y PDF

- sin pago aprobado y sin crédito válido → no factura;
- pago aprobado o crédito total válido + fiscal válido → factura emitida;
- factura emitida + reintento → devolver misma factura/correlativo;
- PDF fallido → factura permanece, PDF reintentable;
- reintento de PDF → nunca nueva factura.

## Idempotencia

- inexistente → `processing` adquirido;
- misma operación/clave/actor/hash en `processing` → informar en proceso, no ejecutar en paralelo;
- misma operación/clave/actor/hash en `succeeded` → devolver mismo resultado;
- misma operación/clave/actor/hash en `failed` → devolver error seguro persistido;
- misma operación/clave con hash o actor diferente → conflicto;
- timeout tras commit → reconsultar y recuperar resultado;
- `processing` con lease vencido → revisión de efectos antes de recuperación manual, nunca takeover ciego.

La reclamación y los efectos críticos se ejecutan en una sola transacción. Una caída antes de commit revierte ambos; una respuesta perdida después de commit se resuelve por reconsulta.

## Auditoría mínima por transición

Cliente creado, pedido creado, venta confirmada, pago registrado, CxC creada, factura emitida, reserva confirmada/liberada, inventario descontado, eventos contables registrados, replay idempotente y fallo crítico deben guardar actor, rol, entidad, IDs seguros y valores anterior/nuevo cuando existan.
