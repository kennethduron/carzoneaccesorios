# Actualizacion controlada del minimo mayorista a una unidad

Operacion puntual, transaccional e idempotente sobre
`public.products.wholesale_min_quantity`. No es una migracion y no se debe mover
a `supabase/migrations`.

## Contrato

- Request key: `wholesale-minimum-all-products-to-one-20260731-v1`.
- Solicitante: `Edgar / business_owner`.
- Origen: `controlled_maintenance`.
- Actor: el unico usuario activo con rol `technical_owner`, resuelto y validado
  dentro de la transaccion. No se suplanta `auth.uid()` ni se inventa un UUID.
- Objetivo cerrado: exactamente 150 productos, todos con valor anterior 3.
- Escritura permitida: `wholesale_min_quantity = 1`. Los triggers conservan
  `product_sales_version` monotona y actualizan `updated_at`.
- Auditoria: `public.audit_logs`, con batch iniciado/completado y un evento por
  producto dentro de la misma transaccion.

`apply.sql` usa la tabla canonica de auditoria directamente porque
`public.write_audit_log` exige `auth.uid()`, que no existe en una sesion SQL de
mantenimiento. La transaccion valida el actor interno y registra explicitamente
su UUID y rol.

## Orden de ejecucion

Desde el worktree limpio y enlazado al proyecto productivo correcto:

```powershell
npx.cmd supabase projects list
npx.cmd supabase db query --linked --file scripts/maintenance/wholesale-minimum-to-one/preview.sql
```

Antes del dry-run se debe generar fuera del repositorio el snapshot JSON, su
SHA-256 y la lista exacta sanitizada. El hash fijado en `apply.sql` debe
coincidir con `snapshot-sha256.txt` antes del commit.

El dry-run usa una copia byte por byte de `apply.sql` salvo por la ultima
sentencia, que se cambia de `COMMIT` a `ROLLBACK`. Despues se vuelve a ejecutar
`preview.sql` y se confirma que no persisten productos, versiones ni auditorias.

La ejecucion real usa el `apply.sql` comprometido y sin modificaciones:

```powershell
npx.cmd supabase db query --linked --file scripts/maintenance/wholesale-minimum-to-one/apply.sql
npx.cmd supabase db query --linked --file scripts/maintenance/wholesale-minimum-to-one/verify.sql
```

Repetir `apply.sql` despues del exito debe devolver `ALREADY_APPLIED`, cero
productos actualizados y cero auditorias duplicadas.

## Concurrencia y protecciones

La operacion toma un advisory lock por request key, bloquea temporalmente
Checkout V4 y las tablas protegidas contra escrituras, y bloquea `products`
contra actualizaciones concurrentes. Cada `UPDATE` exige coincidencia de ID,
minimo anterior y `product_sales_version`. Una discrepancia aborta todo.

Los hashes deterministas cubren todas las columnas de los productos objetivo,
excepto `wholesale_min_quantity`, `product_sales_version` y `updated_at`, y las
tablas de pedidos, lineas, facturas, pagos, CxC, inventario, reservas y
contabilidad. Cualquier diferencia produce rollback completo.

## Rollback

`rollback.sql` no contiene una lista manual: reconstruye el conjunto desde los
150 eventos canonicos del batch aplicado. Antes de restaurar exige minimo 1 y
la version posterior exacta. Si un producto cambio despues, aborta todo. El
trigger incrementa de nuevo la version; nunca se disminuye ni se restaura
`updated_at`.

Request key del rollback:
`rollback-wholesale-minimum-all-products-to-one-20260731-v1`.

El rollback productivo solo se ejecuta con nueva autorizacion ante una
regresion confirmada.
