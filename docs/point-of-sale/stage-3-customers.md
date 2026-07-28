# POS Fase 1 — Etapa 3: clientes y reglas comerciales

Versión: 1.0
Fecha: 2026-07-28
Estado: implementada y validada localmente

## Alcance

Esta etapa habilita únicamente el espacio administrativo `/admin/pos` para buscar, seleccionar, crear y editar clientes, consultar su contexto comercial y evaluar elegibilidad mayorista. No habilita productos POS, carrito, cobro, cierre de venta, pedidos, facturas, correlativos, inventario, cuentas por cobrar ni contabilidad.

La Etapa 4, que contendrá la venta transaccional, permanece pausada.

## Entidad canónica y compatibilidad

- `public.customers` sigue siendo la entidad comercial canónica.
- `customers.user_id` continúa siendo un vínculo opcional a la cuenta del portal; crear un cliente POS no crea `auth.users`.
- El mayoreo conserva `is_wholesale`, `wholesale_status`, `wholesale_customer_type` y `wholesale_first_purchase_completed`.
- El crédito permanece en `customer_credit_accounts` y `accounts_receivable`; el POS solo lo consulta.
- No se fusionan ni reclasifican duplicados legacy.
- No hay backfill ni actualización masiva de estados comerciales.

La migración añade únicamente `customers.commercial_notes`, `customers.commercial_version`, índices de búsqueda normalizada, permisos y RPC específicos. `commercial_version` aumenta cuando cambia identidad comercial, portal, estado general, mayoreo o cuenta de crédito. La edición exige una versión esperada y rechaza escrituras obsoletas.

## Permisos

El acceso exige simultáneamente rol permitido y permiso explícito, tanto en TypeScript como en DB:

- `pos:access`;
- `pos:customers:search`;
- `pos:customers:create`;
- `pos:customers:update`;
- `customers:read_commercial`;
- `customers:read_credit`.

Solo `technical_owner`, `business_owner` y `admin` los reciben. `contadora`, `vendedor`, `bodega`, `soporte` y `cliente` quedan fuera del POS. Los permisos vigentes de esos roles en módulos ajenos al POS no se retiran.

## Contratos de base de datos

### `search_pos_customers_v1`

Búsqueda paginada, bajo demanda y determinista por nombre, empresa, teléfono, correo, RTN o UUID interno. Ordena coincidencia exacta, prefijo y parcial. El listado devuelve teléfono/correo enmascarados y nunca entrega dirección, notas, RTN completo ni UUID Auth.

### `get_pos_customer_context_v1`

Carga el detalle solo después de seleccionar. Devuelve identidad operativa permitida, precio resuelto, mayoreo, versión, indicador de portal, resumen de crédito y resumen comercial. No hay agregados por cada fila del buscador.

### `resolve_customer_pricing_mode_v1`

- mayorista aprobado, activo y no suspendido: `wholesale`;
- suspendido, pendiente, rechazado, elegible o minorista: `retail`.

El navegador nunca envía el modo de precio como autoridad. Un mayorista aprobado mantiene el beneficio aunque la mercadería sea menor de L 10,000.

### `evaluate_wholesale_eligibility_v1`

Evalúa exclusivamente `merchandise_final`, con ISV incluido y después de ajustes válidos. No recibe ni considera entrega, COD o cargos externos.

- L 9,999.99: no elegible; falta L 0.01.
- L 10,000.00: elegible para revisión.
- Mayorista aprobado con L 500.00: conserva precio mayorista.

La función no aprueba, no crea solicitud, no modifica cliente y no crea venta.

### `create_pos_customer_v1`

Creación transaccional e idempotente de un cliente minorista: normaliza identificadores, adquiere advisory locks en orden determinista, bloquea duplicado fuerte por correo/teléfono/RTN, reutiliza `pos_idempotency_requests` y audita solo hashes, últimos cuatro dígitos e indicadores.

Deja mayoreo sin aprobar, crédito sin habilitar y portal sin vincular. No crea usuario Auth, pedido, pago, factura, CxC, inventario ni evento contable.

### `update_pos_customer_v1`

Edita solo nombre, teléfono, correo, empresa, RTN, dirección, ciudad y notas comerciales no sensibles. Exige `commercial_version`, idempotencia y control de duplicados. No permite cambiar portal, mayoreo, crédito ni estados sensibles.

## Concurrencia e idempotencia

Las claves normalizadas fuertes se bloquean con `pg_advisory_xact_lock` en orden estable. Dos solicitudes concurrentes con el mismo identificador no pueden crear dos clientes.

La infraestructura de Etapa 2 se reutiliza:

- misma clave y payload: replay del mismo resultado;
- misma clave y payload distinto: conflicto;
- doble clic o requests concurrentes: una sola creación;
- respuesta perdida: el resultado exitoso puede recuperarse.

No existe una segunda tabla de idempotencia.

## Interfaz

`/admin/pos` incluye búsqueda con debounce de 300 ms, cancelación, paginación, teclado con flechas/Enter/Escape, estados completos, selección, alta rápida, edición con aviso de cambios, contexto comercial y evaluador mayorista no mutante.

Productos, Carrito y Pago aparecen únicamente como marcadores de la siguiente etapa. No hay control para cobrar, cerrar, facturar o modificar inventario.

## Validación y rollback

Pruebas locales cubren migraciones desde cero, roles, RLS/RPC, idempotencia, concurrencia, duplicados, búsqueda enmascarada, control optimista, mayoreo aprobado/suspendido, crédito de solo lectura, umbral L 10,000, volumen de 3,000 clientes y ausencia de mutaciones transaccionales.

Rollback operativo previo a Etapa 4:

1. ocultar `/admin/pos` y revocar permisos POS de clientes;
2. revocar los RPC públicos autenticados;
3. conservar `commercial_version` y auditoría si ya hubo edición;
4. eliminar índices/funciones solo después de confirmar que ningún consumidor los usa.

No se recomienda eliminar versiones ni auditoría ya utilizadas.
