# Auditoría fiscal de extremo a extremo — Etapa 2B

Fecha: 2026-07-22. Alcance: checkout web vigente y fundamentos reutilizables por el futuro POS. No se implementa `create_internal_sale_v1`, interfaz POS ni automatización contable.

## Diagnóstico y decisión

Los precios minoristas y mayoristas son importes brutos con ISV incluido. El comportamiento operativo vigente separa entrega y contraentrega de la base gravada. Antes de esta etapa, `create_checkout_order_v2` heredaba del checkout legacy una fórmula que sumaba ISV sobre el precio visible; después del commit, `applyIncludedTaxFinancialsToOrder` reinterpretaba las líneas como precios con ISV y corregía pedido, pago, factura borrador y cuenta por cobrar mediante varias operaciones independientes. Su error se registraba y se ignoraba. También el precontrol TypeScript de primera compra mayorista incluía entrega en el mínimo.

La decisión implementada es una función SQL pura y versionada, `calculate_sale_financials_v1`, y un único persistidor transaccional, `recalculate_checkout_order_financials_v1`. El RPC vigente los ejecuta antes de crear una cuenta por cobrar y antes de retornar. Una excepción revierte toda la llamada PostgreSQL. El navegador no envía precios ni totales.

## Matriz de flujo y divergencias

| Concepto | Archivo o función | Fórmula/entrada anterior | Momento y transacción | Persistencia/consumidor | Divergencia y riesgo | Decisión |
|---|---|---|---|---|---|---|
| Carrito | `src/contexts/cart-context.tsx`, `src/hooks/use-cart.ts` | Precio visible por cantidad; helper de ISV incluido para presentación | Navegador, fuera de transacción | Solo UI; checkout envía producto/cantidad | La UI no es autoridad | Mantener como presentación; servidor relee precios |
| Precio minorista | `getAuthorizedProductPrice`, `products.retail_price`, checkout SQL | `retail_price` del producto | Dentro de checkout SQL | `order_items.unit_price` y snapshots | Legacy sumaba ISV adicional | El precio resuelto ya incluye ISV |
| Precio mayorista | `create_checkout_order`, `getAuthorizedProductPrice` | `wholesale_price` aprobado y cantidad mínima | Validación TS + SQL | `order_items`, pedido | La normalización mayorista calculaba `subtotal * 15%` | Recalcular el resultado final con v1 dentro de `checkout_v2` |
| Descuentos | `orders.discount_total`, `invoices.discount_total` | Global, normalmente cero en checkout; futuros descuentos aún no activos | Antes: restado post-RPC | Pedido/factura/PDF | PDF restaba el descuento otra vez a la base ya neta | v1 valida línea/global antes de umbrales; PDF usa `invoice.subtotal` |
| Mercadería | `order_items.line_total` | Suma de líneas redondeadas | Dentro del RPC | Ítems → pedido/factura | Se confundía bruto con base fiscal | `merchandise_gross_subtotal` y `merchandise_final` explícitos |
| ISV incluido | `src/utils/included-tax.ts`, checkout SQL | TS: `g/(1+r)`; SQL legacy: `g*r` y suma | TS ocurría post-commit | Pedido/pago/factura | Pedido parcial si la corrección fallaba | Fórmula única SQL v1 dentro del RPC |
| Entrega | `calculateCheckoutFees`, `company_settings`, checkout SQL | L 120 si mercadería < L 3,000 | SQL y UI | `shipping_fee`, `shipping_total` | TS de mínimo mayorista sumaba entrega | Umbral usa mercadería final; entrega no gravada y separada |
| Contraentrega | `create_checkout_order_v2`, acción admin | Legacy: porcentaje; normalizador: cero pendiente | Antes SQL + corrección post-commit | Pedido/pago/factura | Fórmulas y momentos distintos | Cero al crear checkout pendiente; edición atómica por RPC v1 |
| Total pedido | checkout SQL + normalizador TS | Dos fórmulas independientes | Dentro y fuera de transacción | `orders.total` | Riesgo crítico de inconsistencia | Solo `total_final` de v1 |
| Creación de pedido | `create_checkout_order` → `create_checkout_order_v2` | Wrapper identity-safe sobre legacy | Transacción PostgreSQL | `orders` | El wrapper directo podía omitir cierre canónico | Anon/auth solo pueden ejecutar `checkout_v2` |
| Ítems | checkout legacy y wrapper mayorista | Cantidad × precio servidor | Transacción PostgreSQL | `order_items` → factura/PDF | Se usaban para corregir después | v1 valida cantidad, precio, descuento y suma contra `line_total` |
| Snapshot monetario | `orders`, `order_items` | Subtotal, tax, cargos, descuento, total | Antes parcialmente normalizado | Todos los módulos | Sin versión interpretable | `orders.calculation_version = 1`; legacy queda `null` |
| Pago | `payments` | Monto heredado del total intermedio | Transacción y corrección posterior | Confirmación/factura/reportes | Podía diferir del pedido | Actualizado por el mismo persistidor v1 |
| Cuenta por cobrar | `accounts_receivable` | Total calculado por wrapper y resincronizado en TS | SQL + post-commit | Crédito/abonos | Podía diferir o quedar parcial | Se crea después del cálculo v1; sincronización privada solo sin abonos |
| Factura fiscal | `generate_fiscal_invoice_from_order` | Copia subtotal, tax y total del pedido; trigger copia cargos | Transacción fiscal separada | `invoices`, `invoice_items` | No validaba versión/equivalencia completa | Trigger v1 exige coincidencia exacta y copia versión |
| Snapshot factura | `apply_order_fees_to_invoice`, nuevo guard v1 | Cargos desde pedido | `BEFORE INSERT` | PDF/reportes/contabilidad | Sin guard integral | Factura versionada debe igualar pedido |
| PDF | rutas `/api/.../facturas/.../pdf`, mappers y `official-invoice-document` | Lee factura; recalculaba base como `subtotal-discount` | Bajo demanda, sin escritura | Documento fiscal | Doble descuento visual | Lee snapshots; base gravada = subtotal persistido |
| Eventos financieros | `accounting-event-dispatcher.ts` | Snapshots de subtotal, tax, entrega, contraentrega, descuento y total | Después de transición operativa | `financial_events` | Riesgo de reconocer dos veces ingreso/pago | Crédito usa `commercial_credit`; abono usa `receivable_payment`; factura es control |
| Borradores | `journal-draft-generator.ts` | Venta: débito medio/CxC, créditos ingreso+ISV; abono: medio contra CxC | Solo si automatización lo permite | Partidas borrador | Cargos aún no tienen mapeo específico | Automatización permanece `disabled`; no publicar |
| Reportes | servicios y componentes admin | Suman snapshots de pedidos/facturas | Lectura | Paneles/exports | Heredan cualquier divergencia persistida | Los nuevos pedidos versionados ya reconcilian |
| Correos/notificaciones | checkout, crédito y colas | Usan total persistido/RPC | Después del commit; informativos | Cliente/admin | Podían anunciar total intermedio | El RPC retorna solo tras persistir el total v1 |

## Fórmulas definitivas v1

Para cada línea: `bruto_línea = round(cantidad × precio_unitario, 2)`. Los precios son resueltos por el servidor y contienen ISV. `descuento_total = round(descuentos_línea + descuento_global_validado, 2)`. `mercadería_final = round(mercadería_bruta - descuento_total, 2)`.

Con tasa `r`: `base_mercadería = round(mercadería_final / (1 + r), 2)` e `ISV_mercadería = round(mercadería_final - base_mercadería, 2)`. Por tanto `base + ISV = mercadería_final` exactamente a centavos. Entrega, contraentrega, recargo mínimo y cargos adicionales conservan el tratamiento vigente fuera de la base gravada: sus bases fiscales e ISV son cero. `total_final = round(mercadería_final + entrega + contraentrega + recargo_mínimo + cargos_adicionales, 2)`.

El mínimo de primera compra mayorista y la regla de entrega usan `mercadería_final`, nunca cargos. Se cumple mayoreo con `mercadería_final >= 10000`. La sugerencia de entrega es L 120 si `mercadería_final < 3000`, y L 0 en caso contrario. Los mayoristas con historial válido no vuelven a evaluar la primera compra.

## Snapshots y compatibilidad

Los campos existentes ya preservan líneas, precios, subtotal fiscal, ISV, entrega, contraentrega, descuentos, cargos adicionales y total. Solo se añadieron `orders.calculation_version` e `invoices.calculation_version`, ambos `nullable`, para no reinterpretar ni reescribir ventas históricas. La factura versionada se bloquea si no coincide con el pedido. Los pagos y cuentas por cobrar conservan el total y sus relaciones con pedido/factura.

## Migraciones históricas

Supabase CLI 2.109.1 compara las versiones/timestamps locales contra `supabase_migrations.schema_migrations`; no compara checksums del archivo. `migration list --linked --debug` confirmó que las cuatro versiones están registradas remotamente. Por ello no se reejecutan en una base existente; sus cambios solo mejoran reconstrucciones futuras.

| Migración | Remota | Modificación local | Base nueva | Base existente | Riesgo/decisión |
|---|---:|---|---|---|---|
| `202605260005_cleanup_internal_test_fiscal_data.sql` | Sí | Salida segura cuando ambos fixtures históricos no existen; aborta si falta solo uno | Bootstrap deja de fallar sin fixtures | No se ejecuta otra vez | Bajo; conservar para reproducibilidad |
| `202606120002_wholesale_first_purchase_sync.sql` | Sí | Parche tolerante y filtro de compra mayorista válida | Corrige reconstrucción histórica | No se ejecuta otra vez | Bajo; la lógica vigente queda cerrada por la migración nueva |
| `202606130005_commercial_credit_checkout_ambiguity_fix.sql` | Sí | Idempotencia si el predicado ya está corregido | Evita fallo al reconstruir | No se ejecuta otra vez | Bajo; conservar |
| `202606250002_accounting_phase_1.sql` | Sí | Elimina BOM UTF-8 inicial | Evita error de parser/bootstrap | No se ejecuta otra vez | Nulo; corrección de codificación |

El dry-run remoto no intentó reaplicar ninguna de estas cuatro migraciones. Detectó una migración de backups preexistente y no desplegada (`202607150005`) anterior al último historial remoto; debe mantenerse fuera del commit POS y cualquier despliegue de base debe realizarse desde un árbol aislado que no la incluya.
