# Contrato contable POS — Fase 1

Versión: 1.1
Fecha: 2026-07-21
Estado de automatización: `disabled`; este documento no la modifica

## Principio de unicidad económica

Una venta reconoce ingresos e ISV una sola vez. Un pago inmediato no debe acreditarse contra cuentas por cobrar si nunca existió una cuenta por cobrar. Un abono posterior sí cancela cuentas por cobrar, pero nunca vuelve a reconocer ingreso, impuesto, factura, inventario o COGS.

La unicidad técnica vigente de `financial_events` es `(source_type, source_id, event_purpose, posting_version)`. Evita duplicados idénticos, pero no impide dos eventos conceptualmente incompatibles con fuentes diferentes. La Etapa 3 debe agregar arbitraje por escenario/correlación POS antes de habilitar automatización.

## Matriz obligatoria

| Escenario | Evento permitido | Evento prohibido | Fuente y correlación | Momento/condición | Asiento esperado | Riesgo actual |
|---|---|---|---|---|---|---|
| Efectivo, tarjeta o transferencia aprobada | `sale_revenue` | `payment_received`, `commercial_credit` para la misma venta | `order:{order_id}:sale_revenue:v1`, correlacionado con `request_key` | pago aprobado, pedido confirmado y factura elegible | Débito efectivo/banco; crédito ingresos; crédito ISV por pagar | El scanner de pagos también puede proponer `payment_received`; hoy ese borrador acredita CxC y sería incorrecto/duplicado |
| Tarjeta o transferencia pendiente | ninguno de ingreso/cobro | `sale_revenue`, `payment_received`, factura emitida | pedido/pago conservan `request_key` | hasta aprobación | ninguno | Un cambio de estado fuera del coordinador podría disparar eventos antes de tiempo |
| Aprobación de pago pendiente | `sale_revenue` | segundo pedido, `payment_received` contra CxC | pedido existente; misma correlación POS | transición atómica de pago/reserva/pedido/factura | Débito banco; crédito ingresos e ISV | Reintentos no coordinados podrían repetir efectos aunque el evento exacto sea único |
| Venta totalmente a crédito | `commercial_credit` | `sale_revenue` y `payment_received` para la misma venta | `commercial_credit:{receivable_id}:commercial_credit:v1`; `request_key` enlaza pedido | cuenta por cobrar creada por total y factura válida | Débito CxC; crédito ingresos; crédito ISV | El scanner de pedidos también puede proponer `sale_revenue`; ambos generarían reconocimiento duplicado |
| Abono posterior | `receivable_payment` | `sale_revenue`, `commercial_credit`, nueva factura, nuevo COGS | `receivable_payment:{payment_id}:receivable_payment:v1` | abono persistido no anulado | Débito efectivo/banco; crédito CxC | `receivable_paid` debe seguir como control `skipped`, no asiento adicional |
| Factura emitida | `invoice_issued` solo control `skipped` | nuevo asiento de ingreso | `invoice:{invoice_id}:invoice_issued:v1` | después de emisión | ninguno adicional | Correcto hoy: el generador evita duplicar ingreso |
| Salida de inventario por venta | `inventory_cogs` | segundo COGS para el mismo movimiento | `inventory_movement:{movement_id}:inventory_cogs:v1` | movimiento físico confirmado, costo snapshot válido | Débito costo de venta; crédito inventario | Debe originarse por movimiento, no además por pedido/factura |
| Rechazo de pago pendiente | ninguno | ingreso, cobro, factura, COGS | pedido/pago/reserva existentes | pago rechazado y reserva liberada | ninguno | Liberación no idempotente podría alterar stock dos veces |

## Hallazgos del motor existente

- `sale_revenue` debita efectivo/banco para pago inmediato o CxC si el método es `commercial_credit`, y acredita ingreso/ISV.
- `commercial_credit` también debita CxC y acredita ingreso/ISV.
- `payment_received` y `receivable_payment` comparten actualmente la plantilla débito efectivo/banco, crédito CxC.
- Por ello, `payment_received` solo es conceptualmente válido como cobro de una CxC; no debe emitirse para una venta POS pagada de inmediato bajo el contrato elegido.
- `invoice_issued` es evento de control sin borrador, lo cual evita doble ingreso.
- `receivable_paid` es control; los asientos vienen de cada `receivable_payment`.
- `inventory_cogs` utiliza costo histórico/snapshot del movimiento y su clave única propia.
- El escaneo posterior descubre candidatos por tablas distintas. La clave única actual no resuelve incompatibilidad entre `order`, `payment` y `commercial_credit`.

## Regla de dispatcher para la Etapa 3

El RPC devolverá un `accounting_scenario` inmutable: `immediate_sale`, `credit_sale` o `pending_payment`. El dispatcher usará ese escenario para permitir exactamente un evento de reconocimiento:

- `immediate_sale` → `sale_revenue`;
- `credit_sale` → `commercial_credit`;
- `pending_payment` → ninguno hasta aprobación.

Además, cada salida física crea a lo sumo un `inventory_cogs` por `inventory_movement.id`. Los adaptadores de escaneo deben respetar la misma decisión y marcar candidatos incompatibles como `skipped` con motivo, no como borradores.

## Cargos y descuentos

Entrega y contraentrega son conceptos separados y ambos forman parte del total cuando aplican. El comportamiento fiscal efectivo del checkout calcula ISV incluido sobre la mercadería y agrega estos cargos después, fuera de la base gravada; la factura y el PDF los muestran por separado. Se debe reutilizar ese tratamiento y no inventar otro en el POS.

El snapshot contable ya transporta `shipping` y `cash_on_delivery_fee` por separado, pero la plantilla v1 de `sale_revenue` calcula el crédito genérico de ingresos desde total e impuesto y no tiene cuentas específicas aprobadas para ambos cargos. Por ello, cualquier evento POS con cargos debe permanecer `pending` y no publicarse automáticamente hasta definir y probar sus mapeos. La automatización sigue en `disabled`.

El descuento reduce la base fiscal de mercadería conforme al cálculo de ISV incluido. No hay porcentaje máximo global inicial, pero cada descuento exige motivo y conserva monto original/aplicado. Si el precio final queda bajo costo, exige advertencia, confirmación excepcional, motivo y auditoría reforzada de precio original/final, costo y margen. El COGS no cambia por descuento: usa costo snapshot y cantidad efectivamente salida.

## Controles antes de cambiar `disabled`

Se requiere una matriz automatizada con todos los escenarios, mapeos activos, reconciliación débito=crédito, supresión de eventos incompatibles, reintentos concurrentes, COGS único, periodos contables y reversos. Solo una etapa explícita puede evaluar `draft_only`; `auto_post` y publicación quedan fuera.
