# Database

Carpeta para migraciones, seeds, funciones SQL y documentacion de base de datos.

La configuracion versionada esta en:

```txt
supabase/config.toml
supabase/migrations
supabase/seed/seed.sql
```

La regla de precios del sistema exige que cada producto mantenga dos columnas reales:

- `retail_price`
- `wholesale_price`

Los pedidos guardan un snapshot del precio aplicado en `order_items.unit_price`, junto con `retail_price_snapshot` y `wholesale_price_snapshot`, para que la factura no cambie si el producto se edita despues.

## Pagos Por Transferencia

La tabla `payments` mantiene campos normalizados para transferencias bancarias:

- `payment_method`
- `bank_reference_number`
- `transfer_receipt_url`
- `payment_status`
- `created_at`
- `updated_at`

`bank_reference_number` es obligatorio solo cuando `payment_method = 'bank_transfer'`.

No se exige nombre del banco, nombre del titular ni fecha de transferencia.

## Telefono Del Cliente

El telefono del cliente se guarda como dato obligatorio para pedidos:

- `customers.phone`
- `orders.customer_phone`
- `crm_followups.phone` cuando el seguimiento esta asociado a un cliente con telefono

El texto de UI recomendado es `Telefono / WhatsApp`.

## Tablas

El esquema crea estas 18 tablas:

```txt
roles
users
customers
products
categories
product_images
wholesale_codes
inventory_movements
orders
order_items
payments
invoices
invoice_items
shipment_tracking
crm_followups
crm_notes
company_settings
audit_logs
```

Todas tienen `id`, `created_at`, `updated_at`, foreign keys segun su dominio e indices para busquedas frecuentes.

## Aplicar En Supabase

Local:

```bash
npx supabase start
npx supabase db reset
```

Cloud:

```bash
npx supabase login
npx supabase link --project-ref TU_PROJECT_REF
npx supabase db push
```

## Storage

Bucket creado por migracion:

```txt
product-images
```

Lectura publica para mostrar imagenes en la tienda. Escritura, edicion y borrado solo para usuarios con rol `admin`.
