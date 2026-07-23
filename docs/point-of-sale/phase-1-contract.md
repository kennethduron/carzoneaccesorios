# Contrato funcional POS — Fase 1

Versión: 1.1
Fecha: 2026-07-21
Estado: contrato de diseño; no habilita ventas POS
Ámbito: `create_internal_sale_v1`, a implementarse y probarse en la Etapa 3

## 1. Límites y principios

Esta fase documenta el comportamiento futuro y agrega únicamente metadata, permisos, tipos e idempotencia. No existe todavía una pantalla POS, ni una operación que cree ventas POS. El checkout web, sus pedidos y `create_checkout_order_v2` siguen sin cambios.

Reglas invariables:

- `orders.user_id` identifica exclusivamente al comprador del portal. Nunca representa al administrador que crea una venta.
- `orders.customer_id` identifica al cliente comercial, incluso si no tiene cuenta de portal.
- `orders.created_by` identificará al actor administrativo de un pedido interno y se derivará de `auth.uid()`.
- El navegador nunca será fuente de verdad para actor, rol, permisos, precio, impuesto, costo, stock, crédito, total, correlativo fiscal, estado final o cuentas contables.
- La futura confirmación será un único RPC transaccional e idempotente; el navegador no coordinará varias Server Actions críticas.
- El PDF será posterior y reintentable. La falla del PDF no revierte ni vuelve a emitir la factura.
- La automatización contable permanece en `disabled` durante esta intervención.

## 2. Acceso y defensa en profundidad

Permisos nuevos:

- `pos:create_sale`
- `pos:apply_discount`

Ambos se asignan únicamente a `technical_owner`, `business_owner` y `admin`. `contadora`, `vendedor`, `bodega`, `soporte` y `cliente` quedan denegados.

La autorización exige simultáneamente rol permitido y permiso explícito. Debe repetirse en navegación/visibilidad, Server Component, Server Action, RPC, RLS/grants y auditoría. Ocultar una opción visual nunca concede seguridad. `auth.uid()` y el rol consultado en base de datos son la identidad canónica.

## 3. Cliente y condición comercial

Al seleccionar un cliente existente se consultarán `customers`, su cuenta de crédito y sus cuentas por cobrar para mostrar nombre, teléfono, correo, RTN (`customers.tax_id`), condición comercial, estado mayorista, precio aplicable, crédito, límite, saldo usado/disponible, cuentas abiertas/parciales/vencidas, bloqueo, vínculo de portal (`customers.user_id`) y datos fiscales.

El mapeo a la estructura actual es:

- minorista: `is_wholesale = false` o `wholesale_status <> 'approved'`; usa `products.retail_price`;
- mayorista existente: `wholesale_status = 'approved'` y `wholesale_customer_type = 'existing'`, o primera compra ya completada; usa `products.wholesale_price` válido;
- mayorista nuevo/candidato: se conserva `wholesale_status` vigente y `wholesale_customer_type = 'new'`; no se inventa un estado adicional en base de datos;
- primera compra completada: `wholesale_first_purchase_completed` y su fecha, sincronizados por el motor actual.

No se permite elegir manualmente minorista/mayorista contra la clasificación persistida. Un mayorista ya aprobado no se recalifica ni vuelve a cumplir el mínimo en cada venta.

### Cliente nuevo

El futuro RPC normalizará nombre, teléfono, correo y RTN; buscará coincidencias por teléfono, correo y RTN antes de insertar; y devolverá coincidencias sin modificar silenciosamente otro cliente. La confirmación explícita de una coincidencia debe referenciar su `customer_id`.

Crear un cliente interno significa insertar en `customers` con `user_id = null`. No crea `auth.users`, no envía credenciales, no escribe `orders.user_id` y no vincula automáticamente una cuenta de portal. La intención `wholesale_candidate` se mapeará a los campos mayoristas existentes, no a un estado nuevo incompatible. La creación y cualquier decisión sobre duplicados se auditan dentro del RPC.

## 4. Primera compra mayorista de L 10,000

Decisión comercial definitiva: la base es el valor final de la mercadería después de descuentos, con ISV incluido en los precios y sin entrega, contraentrega ni otros cargos logísticos. Debe alcanzar L 10,000. El importe anterior al descuento y el total general con cargos no sustituyen esta base.

- Mercadería L 10,500, descuento L 700, mercadería final L 9,800 y entrega L 120: no cumple.
- Mercadería final L 10,000 y entrega L 120: sí cumple.

La validación futura será exclusiva del servidor: releerá productos y condición comercial, recalculará líneas y descuentos y nunca confiará en un total del navegador. Solo aplica a un cliente nuevo que intenta activar la condición mayorista. No se vuelve a exigir a un cliente mayorista ya aprobado ni a quien ya completó válidamente su primera compra.

Hallazgo de compatibilidad: `202605270003_first_wholesale_minimum_uses_final_total.sql`, el RPC web efectivo y `docs/OPERACION.md` validan hoy contra el total final e incluyen cargos. Esa conducta web no se modifica en esta fase, pero no es el contrato del futuro POS y debe corregirse de forma coordinada antes de reutilizarla.

## 5. Precios, ISV y snapshots

Se reutilizan `products.retail_price`, `products.wholesale_price`, la validación de precio mayorista y los snapshots de `order_items`. No se crea otra tabla de precios. El servidor vuelve a leer y bloquear productos, valida cantidades y recalcula el precio autorizado inmediatamente antes de persistir.

Los precios visibles incluyen ISV. Para una base gravada `G` y tasa `r`, el contrato único es:

- subtotal antes de impuesto: `round(G / (1 + r), 2)`;
- ISV incluido: `round(G - subtotal_antes_impuesto, 2)`;
- total de producto: `G`; nunca `G + 15%`.

Hallazgo actual: el SQL histórico llegó a calcular `subtotal + tax`, mientras `applyIncludedTaxFinancialsToOrder` normaliza después del commit desde TypeScript y captura errores sin invalidar el pedido. Esto puede dejar temporal o permanentemente diferencias entre RPC, pedido, pago y factura borrador. La Etapa 3 debe mover el cálculo único de ISV incluido al RPC atómico. Esta fase no modifica checkout.

## 6. Descuentos

Solo `technical_owner`, `business_owner` y `admin`, pasando además `pos:apply_discount`, podrán solicitarlos. No existe inicialmente un porcentaje máximo rígido global. El RPC aceptará monto o porcentaje, por línea y global únicamente si puede distribuirse de manera determinista.

El servidor releerá precios y costos, validará cantidades positivas y recalculará cada precio final. Nunca aceptará un total arbitrario del navegador, cantidades inválidas, precios negativos ni descuentos sin motivo. La auditoría ordinaria conserva subtotal/precio original, tipo, valor solicitado y aplicado, líneas, total antes/después, motivo, actor, rol, fecha, pedido, factura e impacto fiscal/contable.

Si una línea o la venta queda por debajo del costo, el flujo no puede continuar silenciosamente: mostrará advertencia visible y explícita, requerirá confirmación excepcional y motivo obligatorio, y registrará auditoría reforzada con precio original, precio final, costo, margen, actor, rol, fecha, pedido y factura cuando existan. `pos:apply_discount` no autoriza alterar los precios fuente ni el costo snapshot.

## 7. Crédito comercial y abonos

El crédito se resuelve por `customer_id`, no por cuenta del portal. Antes de una venta totalmente a crédito el servidor bloquea/consulta `customer_credit_accounts` y suma `accounts_receivable.balance_due` de estados `open`, `partial` y `overdue`. Valida crédito habilitado, estado `active`, límite, saldo abierto, disponibilidad, cuentas vencidas y monto recalculado.

Crédito inactivo, suspendido, vencido, bloqueado o insuficiente impide la venta. No existe bypass silencioso. Los tres roles autorizados pueden salir al perfil y cambiar formalmente las condiciones mediante el flujo de crédito existente, con auditoría de valores anterior/nuevo, motivo cuando corresponda, actor, rol y fecha; al regresar, el POS recalcula el snapshot.

La venta POS será 100% a crédito o 100% pagada. No admite anticipo, saldo parcialmente financiado ni pago mixto. Una venta a crédito futura crea un pedido, factura cuando cumpla las precondiciones, una sola cuenta por cobrar por el total y el evento contable de crédito. La entrega determina cuándo sale inventario.

Los abonos posteriores siguen en `accounts_receivable_payments`: reducen saldo, pueden dejar estado `partial`, registran método/actor y generan `receivable_payment`. No crean otra factura, pedido ni salida de inventario.

## 8. Entrega y cargos

Modalidades distintas del pago:

- `store_immediate`: entrega inmediata en tienda;
- `home_delivery`: entrega a domicilio;
- `cash_on_delivery`: entrega y cobro posterior.

Canales: `store`, `whatsapp`, `phone`, `other`. `source` será `pos`; `website` queda reservado al checkout `web`.

Decisión definitiva de entrega: la sugerencia es L 120 cuando la mercadería final después de descuentos sea menor de L 3,000, y L 0 cuando sea igual o mayor. Entrega, contraentrega y otros cargos no cuentan para ese umbral. Por ejemplo, L 3,100 de productos menos L 200 de descuento produce mercadería final L 2,900 y sugerencia L 120.

El cargo sugerido de entrega será editable por los tres roles autorizados: pueden mantenerlo, reducirlo, aumentarlo o dejarlo en cero. Toda modificación manual futura exige motivo y audita sugerido/aplicado, actor, rol, fecha, pedido/factura e impacto total/contable.

Entrega y contraentrega son campos separados. Contraentrega comienza vacía y el rol autorizado fija su importe; ambos pueden coexistir, son trazables y se suman al total cuando aplican. Ninguno puede alcanzar el mínimo mayorista, alcanzar el umbral de entrega gratis, modificar costo de inventario o modificar condición mayorista.

Tratamiento fiscal real encontrado: el normalizador vigente de checkout calcula el ISV incluido únicamente sobre las líneas de mercadería y luego suma entrega, contraentrega, recargo mínimo y cargos adicionales fuera de la base gravada. Pedido, pago y factura reciben el total combinado; el PDF presenta entrega y contraentrega como renglones separados y no los agrega a la base gravada. El snapshot contable conserva entrega y contraentrega separadas, pero el borrador v1 todavía puede absorber importes no tributarios dentro del crédito genérico a ingresos.

Existe además una divergencia ejecutable: el RPC SQL histórico crea primero valores como `subtotal + tax + cargos`, mientras la normalización TypeScript posterior usa precios con ISV incluido; si esa normalización falla, el error se registra pero el pedido no se revierte. Esta fase no inventa un tratamiento nuevo ni modifica checkout. El futuro POS debe reproducir el tratamiento efectivo de líneas y cargos dentro de una única transacción, y no se autoriza despliegue POS mientras la divergencia siga abierta.

## 9. Métodos de pago

- Efectivo POS: recibido de inmediato. No significa contraentrega. Se guarda total y efectivo recibido; el cambio es informativo, no ingreso ni parte de factura/asiento.
- Tarjeta: confirmación manual autorizada, con referencia o evidencia. Pendiente no factura ni registra ingreso definitivo.
- Transferencia confirmada: pago aprobado; permite confirmar pedido/reserva, factura y eventos.
- Transferencia pendiente: un pedido único con pago `pending`, inventario reservado, sin factura ni ingreso definitivo. Aprobación posterior transforma ese mismo pedido; rechazo libera reserva y registra motivo.
- Crédito comercial: no es un pago inmediato y crea cuenta por cobrar por el total.

`payment_method`, `delivery_mode` y `channel` nunca se derivan uno del otro. En particular, `cash` en POS no reutiliza la semántica contraentrega del checkout actual.

## 10. Factura, PDF e inventario

La factura se emite solo con pago inmediato aprobado o crédito total válido, inventario/estado válidos y autorización fiscal vigente. Transferencia o tarjeta pendiente no consumen correlativo. El cliente sin RTN conserva la identificación de consumidor final que ya resuelve el motor fiscal; no se crea un identificador nuevo.

El PDF es bajo demanda, reintentable por `invoice_id`; una falla no cambia la factura ni consume otro correlativo.

Inventario reutiliza bloqueos, `inventory_reservations`, `inventory_movements` y snapshots de costo:

- pago inmediato aprobado: reservar/confirmar en la misma operación y descontar una vez;
- crédito con entrega inmediata: descontar al completar la entrega definida por contrato;
- pago pendiente: reservar sin descontar stock físico;
- aprobación: confirmar la reserva y descontar una vez;
- rechazo: liberar la reserva una vez.

## 11. Auditoría e idempotencia

`audit_logs.old_data` y `new_data`, junto con `user_id`, `actor_role`, fecha, IP y user-agent, son suficientes; no se agregan columnas de auditoría. Los eventos críticos se insertarán dentro del RPC, no solo con el helper TypeScript no bloqueante.

La clave idempotente es UUID, única junto con la operación. El payload se canonicaliza en servidor y solo se almacena su SHA-256; no se guarda información sensible cruda. Misma clave, actor, operación y hash devuelve el mismo resultado. Misma clave con actor o hash diferente se rechaza. La reconsulta autenticada cubre timeout después del commit.

El registro `processing` debe vivir en la misma transacción que la futura venta: si la transacción cae, se revierte también el claim. `lease_expires_at` es una alarma, no permiso de takeover automático. Un `processing` persistido se revisa contra efectos laterales antes de reparación manual.

## 12. Exclusiones

Fuera de esta fase y de los tipos actuales: pagos mixtos, anticipo, abono inicial, caja, apertura/cierre, arqueo, turnos, vendedores funcionales, comisiones, metas, scanner/barcode, anulaciones/devoluciones/reembolsos POS, pasarela nueva, variantes y publicación contable automática. `seller_id` solo queda nullable para futuro.
