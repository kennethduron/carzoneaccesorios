# Plan de implementación POS

Versión: 1.2
Fecha: 2026-07-28

## Etapa 1 — contrato (completada)

- Contrato funcional, contable y de estados versionado.
- Divergencias de ISV y mínimo mayorista registradas.
- Política de eventos contables incompatibles definida.
- Exclusiones explícitas; ninguna venta real.

## Base de Etapa 2 — incluida

- `orders.source`, `channel`, `created_by`, `seller_id` con defaults web y checks.
- Índices parciales solo para pedidos internos/actor, evitando índices redundantes sobre todo el histórico web.
- Protección de metadata contra actualización autenticada directa.
- `pos:create_sale` y `pos:apply_discount` asignados solo a los tres roles permitidos.
- Helper TypeScript que exige rol y permiso.
- Ledger idempotente con SHA-256, estados, lease, concurrencia, replay y reconsulta.
- RLS habilitada, sin grants de tabla para `anon`/`authenticated`; solo RPC de consulta actor-scoped.
- Tipos de solicitud/resultado sin actor, precio final, impuesto, costo, stock o total confiados al cliente.

## Compatibilidad y costo de migración

Las columnas constantes `web`/`website` preservan pedidos existentes y futuros del checkout sin modificar su llamada. `created_by` y `seller_id` quedan nulos para web/legacy. Los checks se agregan `NOT VALID` y luego se validan; las adiciones toman un lock breve de catálogo y la validación escanea `orders`. Los tres índices son parciales para `source <> 'web'` o `created_by is not null`, por lo que empiezan vacíos en un sistema solo web, aunque su creación aún requiere el lock normal de `CREATE INDEX`.

No se aplicará la migración a producción en esta intervención sin una base local/staging validada. Rollback lógico previo a cualquier uso POS:

1. revocar funciones/grants y eliminar tabla idempotente;
2. retirar permisos JSON;
3. eliminar trigger/índices/constraints;
4. eliminar columnas únicamente si se confirma que no existen pedidos internos.

Después de que existan pedidos POS, las columnas no deben eliminarse; el rollback será deshabilitar entrada POS y conservar metadata/auditoría.

## Etapa 3 — clientes y reglas comerciales (completada)

- Espacio `/admin/pos` limitado a clientes; no crea ventas.
- Búsqueda paginada y enmascarada por identidad comercial.
- Contexto separado de precio, mayoreo, portal y crédito de solo lectura.
- Creación idempotente con prevención concurrente de duplicados.
- Edición con `commercial_version` y control optimista.
- Precio mayorista resuelto por DB y elegibilidad sobre mercadería final.
- Acceso exclusivo de `technical_owner`, `business_owner` y `admin`.
- Contrato y pruebas: `docs/point-of-sale/stage-3-customers.md`.

## Etapa 4 recomendada — pausada

La Etapa 4 continúa pausada. Cuando se inicie, `create_internal_sale_v1` debe
reutilizar `adjust_sale_terms_v1` para fecha/precios/entrega y
`calculate_sale_financials_v1` como única fuente monetaria.

Implementar `create_internal_sale_v1` como único RPC `SECURITY DEFINER`, `search_path=public`, sin ejecución pública y con grant solo `authenticated`. Orden exacto recomendado:

1. verificar `auth.uid()`, rol y `pos:create_sale`;
2. canonicalizar payload y calcular SHA-256 en servidor;
3. reclamar idempotencia dentro de la misma transacción;
4. bloquear/resolver cliente, duplicados, condición mayorista y crédito;
5. bloquear productos en orden UUID, recalcular precios/cantidades/costo;
6. validar descuentos con permiso independiente;
7. calcular ISV incluido, entrega y contraentrega;
8. aplicar el mínimo mayorista definitivo sobre mercadería final después de descuentos, sin cargos;
9. crear un pedido `source=pos`, actor `auth.uid()` y snapshots;
10. ejecutar exactamente una rama: pago aprobado, pago pendiente o crédito total;
11. coordinar reserva/movimiento, factura/CxC y auditoría;
12. registrar el único evento de ingreso permitido y COGS por movimiento;
13. finalizar idempotencia y devolver IDs seguros;
14. ejecutar PDF/notificaciones reintentables después del commit.

No construir la interfaz completa hasta que el RPC pase pruebas concurrentes y de regresión.

## Contrato de entrada del RPC

Entradas: `request_key`, cliente existente o datos de nuevo cliente, líneas `product_id/quantity`, modalidad, canal, método/estado/referencia de pago, descuentos/motivo, cargo sugerido/aplicado/motivo, contraentrega y elección de crédito total.

Nunca entran como verdad: actor, rol, permisos, source, precio final, impuesto, costo, stock, saldo/límite, totales, número fiscal, estados finales o cuentas contables.

Respuesta: `request_key`, resultado, replay, `order_id/number`, `payment_id/status`, `invoice_id/number`, URL PDF nullable, `receivable_id`, estado contable, advertencias y fecha.

Errores seguros: permiso, cliente inexistente/duplicado, crédito inactivo/vencido/insuficiente, stock insuficiente, precio cambió, CAI inválido, pago pendiente, conflicto idempotente y fallo post-commit recuperable. No se exponen nombres de tablas, SQLSTATE internos, stack ni payload sensible.

## Pruebas de Etapa 4

- roles permitidos/denegados en frontend, Server Component, Action y RPC;
- pedidos web invitados/autenticados/minoristas/mayoristas sin cambios;
- mismas claves con mismo/diferente payload y dos conexiones concurrentes;
- timeout antes/después de commit y reconsulta;
- stock insuficiente y orden de locks;
- pago inmediato, pendiente/aprobado/rechazado y crédito total;
- factura/CAI/correlativo y PDF fallido reintentable;
- CxC/abonos sin duplicar factura/inventario;
- matriz contable: un reconocimiento, un COGS por movimiento, cero publicación automática;
- CRM, mayoristas, crédito, pedidos, inventario, factura, reportes, Centro Financiero, Libro Contable y vínculo manual del portal.

## Decisiones comerciales cerradas

1. Primera compra mayorista: mínimo L 10,000 de mercadería final después de descuentos, con ISV incluido y sin entrega, contraentrega ni otros cargos.
2. Entrega sugerida: L 120 si esa mercadería final es menor de L 3,000; L 0 desde L 3,000. Los tres roles autorizados pueden editarla con motivo y auditoría.
3. Descuentos: sin porcentaje máximo global inicial; siempre recalculados por servidor, con motivo y auditoría. Bajo costo exige advertencia visible, confirmación excepcional, motivo y auditoría reforzada.
4. Entrega y contraentrega: campos separados, editables y trazables; ambos suman al total, pero no alteran umbrales, condición mayorista ni costo de inventario.
5. Fiscal: se conserva el tratamiento efectivo actual — ISV incluido sobre mercadería y cargos separados fuera de esa base — sin habilitar automatización contable.

## Bloqueos previos a Etapa 4 o despliegue de venta POS

- Unificar en una sola transacción el cálculo SQL/TypeScript de ISV incluido del checkout; hoy existe una divergencia y la normalización posterior no es bloqueante.
- Definir cuentas contables específicas para entrega y contraentrega y probar sus borradores; hasta entonces todo evento POS con cargos permanece `pending`.
- No implementar `create_internal_sale_v1` ni interfaz POS como parte de esta intervención.
