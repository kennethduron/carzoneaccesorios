# Términos comerciales previos a facturación

## Contrato

`adjust_sale_terms_v1` es la operación compartida y transaccional para Pedidos y el futuro POS. Recibe la fecha comercial, todos los precios finales de línea, el cargo de entrega, metadatos opcionales, la versión leída y una clave UUID de idempotencia. Relee costos, cantidades, descuentos y cargos desde PostgreSQL y usa una sola vez `calculate_sale_financials_v1`; el navegador nunca define totales, ISV ni costos.

La operación bloquea en orden pedido, líneas, pagos y cuenta por cobrar. `commercial_terms_version` evita sobrescribir cambios concurrentes y `pos_idempotency_requests` permite repetir exactamente la misma solicitud sin aplicarla dos veces. Un error revierte líneas, pedido, pago, cuenta por cobrar, auditoría e idempotencia en la misma transacción.

## Fechas

- `orders.created_at`: instante técnico e inmutable de creación del pedido.
- `orders.requested_invoice_date`: fecha `YYYY-MM-DD` seleccionada antes de facturar.
- `invoices.invoice_date`: snapshot comercial/fiscal inmutable que muestra la factura y usan los reportes de facturación.
- `invoices.issued_at`: instante técnico real de generación, siempre asignado con `now()`.
- `fiscal_settings.cai_authorization_date`: inicio de vigencia del CAI; no es la fecha de la factura.
- `fiscal_settings.emission_deadline`: fecha límite de emisión del CAI.

La interfaz propone hoy en `America/Tegucigalpa`. SQL rechaza fechas futuras, anteriores a la autorización del CAI, posteriores al límite o dentro de un período explícitamente cerrado. Una fecha puede ser anterior al pedido. La ausencia de una fila de período no inventa un cierre y no bloquea.

Para facturas legacy sin `invoice_date`, el documento y los reportes usan la fecha Honduras de `issued_at` y, si falta, de `created_at`. Nunca usan `cai_authorization_date` como fallback.

## Precio final

El precio acordado se guarda en `order_items.unit_price`; no es un descuento y no modifica `products.retail_price`, `products.wholesale_price` ni `products.cost_price`. El trigger de precio sigue imponiendo el catálogo en checkout y rechaza escrituras arbitrarias. Solo la RPC puede abrir el contexto transaccional privado para un override validado.

Una modificación requiere `unit_cost_snapshot > 0`. Se permite precio igual o superior al costo y se bloquean precio cero, negativo, con más de dos decimales o inferior al costo. No existe fallback silencioso al costo maestro. El motivo es opcional y solo se conserva en auditoría interna, junto con actor, rol, precio original confiable, precio final, costo y margen.

## Entrega

El cálculo canónico sugiere HNL 120 cuando la mercadería final es menor a HNL 3,000 y HNL 0 desde ese umbral. `shipping_fee_suggested` conserva la sugerencia; `shipping_fee` conserva cualquier cargo aplicado no negativo. Modalidad, empresa externa y motivo son opcionales.

Un cobro separado de una empresa externa no pertenece a la factura, pago, cuenta por cobrar, impuestos o contabilidad de Car Zone. COD permanece en `cash_on_delivery_fee` y nunca se mezcla con entrega.

## Estados y propagación

Una fecha puede cambiar mientras no exista factura ni cancelación, incluso si el pago o inventario ya avanzó, porque no modifica importes. Precio o entrega quedan bloqueados con pago aprobado (excepto el registro técnico del crédito abierto), inventario consumido, reserva convertida/liberada, entrega, cancelación, factura, abonos o trazabilidad contable irreversible.

Un cambio monetario actualiza atómicamente las líneas, el pedido, únicamente pagos esperados pendientes y una cuenta por cobrar abierta sin abonos. En CxC cambia `original_amount` y `balance_due`; `due_date` no cambia. Abonos, outboxes, eventos y partidas existentes no se escriben.

## Seguridad y permisos

Solo `technical_owner`, `business_owner` y `admin` reciben:

- `sales:set_invoice_date`
- `sales:override_price`
- `sales:override_delivery`

La contadora conserva sus permisos actuales de lectura, fiscalidad y contabilidad, pero no puede ajustar fecha, precio ni entrega. Si el flujo vigente le permite emitir, la RPC fiscal usa el snapshot previamente guardado; si no hay fecha seleccionada usa hoy en Honduras.

Las escrituras monetarias de líneas y los inserts/updates de facturas y líneas fiscales se revocan a `authenticated`. Las facturas emitidas y sus líneas son inmutables. La factura oficial solo se crea mediante `generate_fiscal_invoice_from_order`.

## Contabilidad y compatibilidad

`financial_events.occurred_at` sigue siendo el instante técnico. Los candidatos de factura copian `invoice_date` a `accounting_date`; un consumidor legacy cae a la fecha Honduras de `occurred_at`. Esta implementación no crea ni publica partidas de venta.

`automation_mode` permanece `disabled`. La excepción dirigida, outbox, borradores, publicación manual y reparación histórica de `receivable_payment` no se modifican. Los pagos usan `paid_at` y los abonos `received_at`.

Las facturas y eventos históricos no reciben backfill ni recálculo. Una línea legacy sin costo sigue siendo facturable solo conforme a las validaciones fiscales vigentes, pero no puede recibir override. La Etapa 3 del POS continúa pausada.
