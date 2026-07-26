# Contabilidad de abonos de cuentas por cobrar

## Contrato aprobado

Cada fila no anulada de `accounts_receivable_payments` representa un hecho monetario individual:

```text
receivable_payment
→ siempre deja trazabilidad recuperable
→ crea un evento financiero individual
→ crea una partida en borrador cuando es contablemente válido
→ nunca se publica automáticamente
```

El modo global `automation_mode = disabled` no cambia. La excepción dirigida se limita de forma exacta a:

- `source_type = receivable_payment`
- `event_purpose = receivable_payment`
- `posting_version = v1`

Pedidos, facturas, ventas, inventario, compras, pagos generales, créditos comerciales, cancelaciones y demás eventos conservan el comportamiento de `disabled`.

## Flujo transaccional

1. `register_credit_receivable_payment` valida actor, rol, permiso, CxC, monto, método, estado, sobrepago e idempotencia.
2. La implementación operativa vigente inserta el abono y actualiza saldo, estado, pago agregado, auditoría, notificaciones y correo.
3. Un trigger obligatorio inserta `accounting_outbox` dentro de esa misma transacción.
4. Si la outbox no puede insertarse, la sentencia falla y PostgreSQL revierte también el abono y el saldo.
5. La RPC devuelve por separado el abono, saldo anterior/posterior, estado, outbox e indicador de reintento idempotente.
6. La Server Action procesa únicamente la fila de outbox devuelta. No ejecuta un escaneo global.

La unicidad de outbox y evento usa:

```text
(source_type, source_id, event_purpose, posting_version)
```

Por tanto, dos abonos tienen eventos diferentes porque tienen `payment.id` diferentes; un reintento del mismo abono recupera la misma outbox, evento y partida.

## Procesador y recuperación

`process_receivable_payment_accounting_outbox_v1` reclama una sola fila con bloqueo de fila y `SKIP LOCKED`. Una fila `processing` puede recuperarse después de 15 minutos si un proceso murió.

Estados de outbox:

- `queued`: lista para reclamar.
- `processing`: reclamada, con `locked_at` y `locked_by`.
- `completed`: el hecho ya está representado por un evento recuperable; puede o no tener borrador.
- `failed`: fallo técnico sanitizado y reintentable.

El procesador incrementa `attempts`, reconstruye el evento desde tablas operativas y nunca acepta del navegador monto, fecha, método, cuentas, débitos, créditos, estado ni partida.

El evento usa:

- `event_type = receivable_payment_received` dentro del snapshot;
- monto exacto de `accounts_receivable_payments.amount`;
- fecha efectiva de `received_at`;
- fecha contable convertida a `America/Tegucigalpa`;
- método canónico `cash`, `bank_transfer` o `card`;
- cliente, CxC, pedido/factura opcionales, referencia permitida y actor operativo.

## Mapeos y período

El débito se resuelve exclusivamente desde el mapeo activo y efectivo en la fecha del abono:

- `payment_method:cash`
- `payment_method:bank_transfer`
- `payment_method:card`

El crédito usa exclusivamente:

- `receivable:accounts_receivable`

No se crean cuentas ni mapeos automáticamente. Si falta un mapeo, el evento queda `pending`, la outbox puede quedar `completed` porque el hecho ya es recuperable y no se crea partida.

Si la fecha local del abono pertenece a un período cerrado, el evento queda `pending`; el sistema no cambia la fecha ni abre el período.

## Borrador dirigido

Cuando el evento está listo, la aplicación reutiliza `create_journal_draft_from_financial_event`. Para eventos de abono, la envoltura SQL ignora los datos monetarios enviados por el cliente y vuelve a leer el abono y los mapeos.

La partida contiene:

- débito a Caja, Banco/transferencias o Tarjeta/puente por el monto del abono;
- crédito a Cuentas por cobrar por el mismo monto;
- fecha local derivada de `received_at`;
- referencias internas al abono, CxC, cliente, evento y actor.

La partida queda `borrador`. La unicidad de `journal_entries(source_type, source_id)` para `source_type = financial_event`, más `financial_events.journal_entry_id`, evita duplicados.

## Publicación y anulaciones

Solo un actor autorizado con `accounting:post` puede publicar manualmente. La RPC canónica vuelve a comprobar borrador, versión, período, balance, cuentas activas e idempotencia.

Para una partida de abono, la envoltura adicional comprueba:

- contrato exacto del evento;
- rol autorizado;
- permiso `accounting:post`;
- que el abono no esté anulado.

Un abono anulado no crea un nuevo borrador normal y bloquea la publicación del borrador pendiente. Si la partida ya estaba publicada, se utiliza el flujo formal de reversión; no se elimina la partida.

Los reportes definitivos y estados financieros continúan usando partidas publicadas. El borrador es visible en Libro Diario para revisión, pero no se trata como contabilizado definitivamente.

La reversión controlada de un lote histórico puede retirar outbox y eventos sin partida antes de eliminar sus abonos importados. Si cualquier abono del lote ya tiene una partida, la reversión del lote se bloquea y exige el flujo contable formal.

## Evento final de control

Al quedar la CxC en cero también se registra:

```text
event_type = receivable_paid
status = skipped
journal_entry_id = null
```

Es un evento de control. El cobro se contabiliza mediante eventos individuales de abono para evitar duplicados. Nunca utiliza `accounts_receivable.original_amount` ni se envía al generador de borradores.

## Roles y permisos

Los roles humanos admitidos por las RPC de este flujo son:

- `technical_owner`
- `business_owner`
- `admin`
- `contadora`

Se reutilizan permisos existentes:

- `credit:mark_paid`
- `accounting:read`
- `accounting:manage`
- `accounting:create` / creación canónica de borrador
- `accounting:edit_draft_entries`
- `accounting:post`

La UI no concede autoridad. Server Actions revalidan permisos y las funciones `SECURITY DEFINER` comprueban rol, permiso, contrato exacto y datos reales.

`accounting_outbox` solo permite lectura autorizada. `financial_events`, `journal_entries`, `journal_entry_lines` y `accounts_receivable_payments` no admiten mutación autenticada directa para este flujo.

## Estados visibles y reintentos

La UI distingue:

- evento pendiente;
- partida en borrador;
- partida publicada;
- requiere mapeo;
- período cerrado;
- procesamiento fallido.

El historial administrativo enlaza abono, evento y partida y muestra saldo anterior/posterior, actor e intentos. Estos detalles contables no se consultan ni muestran en el portal público.

“Reintentar procesamiento contable” procesa una sola outbox, revalida mapeos y período, y es idempotente. No aplica a `receivable_paid`, abonos anulados, eventos revertidos ni partidas ya publicadas.

“Escanear eventos” conserva su alcance histórico y escribe datos; no es un dry run real ni participa en el registro normal de un abono. “Ver eventos pendientes” es únicamente un filtro visual.

## Reparación histórica

Preview, siempre de solo lectura:

```bash
node --env-file=.env.local scripts/accounting/preview-missing-receivable-payment-events.mjs
```

La herramienta muestra cantidades, montos, métodos, períodos, mapeos faltantes, períodos cerrados y posibles partidas manuales con IDs enmascarados.

La reparación:

```bash
node --env-file=.env.local scripts/accounting/repair-missing-receivable-payment-events.mjs \
  --payment-id=<UUID>
```

también ejecuta preview por defecto. Aplicar exige simultáneamente:

```text
--apply
RECEIVABLE_PAYMENT_REPAIR_CONFIRM=APPLY_RECEIVABLE_PAYMENT_REPAIR
SUPABASE_REPAIR_ACTOR_ACCESS_TOKEN=<actor autorizado>
```

Reconcilia tanto abonos sin evento como eventos exactos sin outbox y sin partida. Excluye abonos anulados, operaciones ya enlazadas a partida y posibles partidas manuales equivalentes. No publica ni duplica el evento existente. Debe revisarse el preview y obtener aprobación expresa antes de ejecutarla contra producción.

## Observabilidad

`accounting_event_log` registra reclamo, reintento, finalización y fallo de outbox, junto con evento y partida. `accounting_outbox` permite consultar pendientes, fallos, intentos y antigüedad sin guardar secretos ni datos bancarios.

Consultas operativas recomendadas:

- outbox `queued`/`failed` por `available_at`;
- eventos de abono `pending` sin `journal_entry_id`;
- borradores de abono no publicados;
- antigüedad desde `created_at` y `occurred_at`.

## Alcance pausado

La fecha seleccionable de factura, precio unitario ajustable, cargo de entrega editable y Etapa 3 del POS continúan pausados y no forman parte de esta implementación.
