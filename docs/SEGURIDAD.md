# Seguridad interna - Car Zone Accesorios

## Principios

- Toda ruta administrativa debe validar sesion y permiso en servidor.
- RLS debe proteger datos aunque alguien llame Supabase directamente.
- Las operaciones sensibles deben pasar por RPC o server actions con validacion de permiso.
- El cliente solo debe ver sus propios pedidos, facturas y datos personales.

## Tablas sensibles

- `orders`, `order_items`, `payments`
- `customers`, `users`
- `invoices`, `invoice_items`, `fiscal_settings`
- `inventory_movements`
- `crm_notes`, `crm_followups`
- `customers.wholesale_status` y `wholesale_codes` historico
- `audit_logs`, `error_logs`, `notification_logs`
- `company_settings`

## Controles actuales importantes

- Escritura directa de checkout bloqueada para `orders`, `order_items` y `payments`.
- Inventario administrativo por RPC con bloqueo de producto.
- Facturacion por RPC con bloqueo de correlativo.
- Logs de notificacion/error separados de la operacion principal.
- Service role solo debe usarse en servidor.
- El frontend no puede activar mayoreo: el checkout valida en RPC que el usuario tenga `customers.wholesale_status = 'approved'`.

## Riesgos a vigilar

- Tracking publico: los codigos nuevos tienen mayor entropia, pero la ruta debe recibir rate limiting si hay abuso.
- Comprobantes: usar entrega privada o signed URLs si contienen datos sensibles.
- Recuperacion de password y confirmacion de correo deben validarse antes de operacion masiva.
- No registrar tokens, claves, numeros completos de tarjeta ni comprobantes completos en logs.
- Las API keys de Resend/Brevo solo pueden usarse en servidor. Nunca en frontend ni variables `NEXT_PUBLIC_*`.
- Los endpoints cron deben responder 401 si falta o no coincide `Authorization: Bearer CRON_SECRET`.

## Variables criticas

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `EMAIL_PROVIDER`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `BREVO_API_KEY`
- `BREVO_FROM_EMAIL`
- `BREVO_SENDER_NAME`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CRON_SECRET`

Nunca guardar valores reales en Git, tickets, capturas o logs.

## Dominios de correo

Antes de enviar correos transaccionales en produccion:

- Autenticar el dominio del remitente en el proveedor elegido.
- Configurar DKIM y DMARC.
- En Resend, revisar los registros DNS generados para el dominio, incluyendo SPF/DKIM/MX cuando aplique.
- En Brevo, agregar el dominio en Senders, Domains & IPs y completar Brevo code, DKIM y DMARC.
- Usar un remitente profesional del dominio del negocio, no Gmail/Yahoo.

## Rate limiting y cron

- `rate_limits` guarda identificadores hash, ruta, ventana y contador; no guarda IP en claro.
- `cleanup-rate-limits` elimina ventanas antiguas.
- `operational_cron_runs` registra ejecuciones exitosas/fallidas sin guardar secretos.
