# Backups y recuperacion - Car Zone Accesorios

## Objetivo operativo

Car Zone Accesorios maneja clientes, pedidos, pagos, facturacion, inventario, CRM, mayoristas y datos sensibles. La meta no es solo "tener backups", sino poder restaurar operacion con evidencia, responsables y un RPO/RTO claro.

## Estado por proveedor

### Supabase

Segun la documentacion oficial de Supabase revisada el 21 de mayo de 2026:

- Supabase realiza backups diarios para proyectos Free, Pro, Team y Enterprise.
- En Free, los backups no estan disponibles para descarga y Supabase recomienda exportaciones regulares con `supabase db dump` y copias fuera de la plataforma.
- En Pro se puede acceder a los ultimos 7 dias de backups diarios.
- PITR es un add-on para Pro/Team/Enterprise y permite restaurar a puntos mas precisos que un backup diario.
- Los backups de base de datos no incluyen objetos de Supabase Storage; solo metadata.
- Si se elimina un proyecto Supabase, tambien se elimina la data asociada y sus backups.

Fuentes:

- https://supabase.com/docs/guides/platform/backups
- https://supabase.com/docs/guides/deployment/going-into-prod

### Cloudinary

Los comprobantes se suben como `authenticated` en `car-zone/comprobantes-transferencia-privados`. El sistema ya no expone la URL directa al cliente ni en las pantallas publicas. Admin/contadora acceden por una ruta interna que genera URL firmada temporal.

Cloudinary advierte que los assets `authenticated` requieren signed URL y que una URL firmada compartida puede ser vista por quien la tenga hasta que expire.

Fuente:

- https://cloudinary.com/documentation/control_access_to_media

### Vercel

Vercel no es backup de configuracion sensible. Las variables deben inventariarse por nombre, ambiente, responsable y fecha de rotacion, pero nunca guardar valores en Git.

### Repositorio

El repositorio versiona migraciones, codigo y documentacion. Debe permanecer en remoto privado con ramas protegidas antes de operacion comercial fuerte.

## Que se respalda

Tablas criticas:

- `orders`
- `order_items`
- `payments`
- `invoices`
- `invoice_items`
- `customers`
- `users`
- `products`
- `product_images`
- `inventory_movements`
- `inventory_reservations`
- `crm_followups`
- `crm_notes`
- `wholesale_codes`
- `audit_logs`
- `company_settings`

Archivos y metadata:

- Imagenes de producto: Cloudinary `public_id`, URL, carpeta, angulo y producto relacionado.
- Comprobantes: `transfer_receipt_public_id`, `resource_type`, `delivery_type`, formato, pago y pedido asociado.
- Variables Vercel/Supabase/Cloudinary: nombres, ambiente, responsable, fecha de rotacion, ubicacion segura externa.

## Frecuencia minima

| Recurso | Frecuencia | Responsable |
| --- | --- | --- |
| Supabase logical dump externo | Diario | `technical_owner` |
| Supabase backup semanal retenido | Semanal | `technical_owner` |
| Supabase backup mensual retenido | Mensual | `technical_owner` |
| Prueba de restauracion | Trimestral | `technical_owner` + admin |
| Manifest Cloudinary productos | Semanal | `technical_owner` |
| Manifest Cloudinary comprobantes | Diario | `technical_owner` |
| Inventario Vercel env vars | Mensual y antes de rotar claves | `technical_owner` |
| Revision de migraciones | Antes de cada deploy | `technical_owner` |

## Backup automatico y manual por correo

La estrategia activa no usa Google Cloud, Google Drive API ni Service Account. El respaldo se genera en servidor, se comprime como ZIP y se envia por el proveedor de correo transaccional existente a:

```text
carzonetech0@gmail.com
```

Google Drive queda desactivado por ahora para evitar depender de una cuenta de Google Cloud con tarjeta conectada. El endpoint historico `/api/cron/backups/google-drive` permanece protegido por `CRON_SECRET`, pero responde que esa via esta desactivada.

Variables necesarias en Vercel Production:

- `CRON_SECRET`
- proveedor de correo ya existente, por ejemplo `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
- `EMAIL_BACKUP_MAX_BYTES` opcional, por defecto `15000000`

No guardar secretos, API keys, tokens ni valores de variables en Git, documentacion, backups o capturas.

### Endpoint cron

Endpoint activo:

```http
GET /api/cron/backups/email
Authorization: Bearer CRON_SECRET
```

Tambien acepta `POST`. Sin `Authorization: Bearer CRON_SECRET`, responde `401` y no crea backup.

`vercel.json` ya contiene crons operativos. Si el proyecto esta en Hobby, Vercel permite maximo 2 cron jobs; en ese caso mantener backup manual o usar Cron-Job.org con este endpoint. Si el proyecto esta en Pro, se puede agregar una tarea semanal, preferiblemente domingo de madrugada, sin romper los crons existentes.

### Backup manual

En `/admin/seguridad`, el `technical_owner` puede usar `Enviar backup por correo`. El backup manual genera un ZIP completo, lo envia a `carzonetech0@gmail.com` y muestra:

- estado
- fecha
- tamano
- nombre del archivo
- destinatario
- proveedor de entrega
- numero de tablas respaldadas
- tablas no encontradas, si aplica

### Tablas respaldadas

Alcance completo:

- `products`
- `product_images`
- `categories`
- `inventory_movements`
- `inventory_reservations`
- `orders`
- `order_items`
- `payments`
- `invoices`
- `invoice_items`
- `customers`
- `users`
- `wholesale_codes`
- `crm_notes`
- `crm_followups`
- `holiday_banners`
- `fiscal_settings`
- `business_settings`
- `notification_logs` recientes importantes
- `audit_logs` recientes importantes

Si una tabla no existe, se registra como faltante y el respaldo continua.

### Formato

Cada backup se guarda como ZIP:

```text
car-zone-backup-YYYY-MM-DD-HH-mm.zip
```

Incluye:

- `metadata.json`: fecha, entorno, URL, tablas, conteos, tamano, commit si existe, dependencias y nota de seguridad.
- un JSON por tabla exportada, por ejemplo `products.json`, `orders.json`, `users.json`.
- `summary.csv`: resumen de tablas y conteos.
- `csv/*.csv`: copia rapida por tabla para revision humana.

Los IDs originales, timestamps y relaciones por IDs se preservan para que Codex, ChatGPT o un desarrollador puedan reconstruir una restauracion asistida. No hay restauracion automatica implementada.

### Datos excluidos

El sistema no respalda variables de entorno ni Supabase Auth. Tambien redacta recursivamente campos cuyo nombre indique secretos, por ejemplo:

- passwords
- tokens
- secrets
- API keys
- private keys
- service role keys
- authorization headers
- cron secrets
- cookies
- sesiones
- numeros de tarjeta/CVV

### Tamano maximo

El limite recomendado por correo es `EMAIL_BACKUP_MAX_BYTES=15000000` (15 MB). Si el ZIP supera ese tamano:

- no se envia el correo
- se registra error en `backup_runs`
- el panel muestra que el backup supera el tamano permitido para correo
- se debe descargar manualmente o configurar almacenamiento externo

### Auditoria

Las migraciones `202606070001_google_drive_backup_runs.sql` y `202606070002_email_backup_runs.sql` dejan `backup_runs` listo para registrar ejecuciones por correo:

- inicio y fin
- estado
- tipo
- nombre y tamano de archivo
- destinatario
- proveedor de entrega
- ID de mensaje del proveedor, si lo devuelve
- tablas exportadas y faltantes
- origen (`manual`, `cron`, `system`)
- usuario creador, si aplica
- error sin secretos, si falla

Tambien se registra compatibilidad en `backup_logs` y auditoria tecnica en `audit_logs`.

## Procedimiento de backup manual en Free

1. Verificar que el proyecto no este pausado.
2. Ejecutar un dump logico desde una maquina confiable:

```bash
supabase db dump --db-url "$SUPABASE_DB_URL" --file backups/car-zone-$(date +%F).sql
```

3. Cifrar el archivo antes de moverlo fuera de la maquina.
4. Guardarlo en almacenamiento externo controlado por el negocio.
5. Registrar la revision en `/admin/uso`.
6. Mantener al menos:

- 7 diarios recientes.
- 8 semanales.
- 12 mensuales.

## Restauracion de base de datos

1. No restaurar directo sobre produccion salvo emergencia confirmada.
2. Crear proyecto Supabase temporal.
3. Restaurar el dump o backup seleccionado.
4. Ejecutar migraciones pendientes si aplica.
5. Validar tablas criticas, correlativo fiscal, pedidos, pagos e inventario.
6. Validar login admin, checkout, rastreo, facturacion y CRM.
7. Si la restauracion es aceptada, programar ventana de mantenimiento.
8. Actualizar variables en Vercel apuntando al proyecto restaurado solo cuando la validacion pase.

## Si se elimina informacion

1. Pausar tareas administrativas y nuevos deploys.
2. Identificar tabla, registros, usuario y hora aproximada en `audit_logs`.
3. Si hay PITR, restaurar a un punto anterior en ambiente separado y extraer los registros.
4. Si solo hay dump, restaurar el dump mas reciente en ambiente separado.
5. Reinsertar manualmente solo los registros validados.
6. Registrar incidente, causa raiz y accion preventiva.

## Si falla una migracion

1. Detener deploy.
2. No editar datos manualmente sin snapshot previo.
3. Revisar el error exacto de Supabase CLI.
4. Restaurar en ambiente temporal si la migracion dejo datos parcialmente transformados.
5. Crear migracion correctiva; no reescribir una migracion ya aplicada en produccion.
6. Ejecutar build y pruebas criticas antes de redeploy.

## Si Cloudinary pierde imagenes

1. Usar `product_images.public_id` y `product_images.public_url` para identificar impacto.
2. Restaurar desde manifest semanal o backup externo de assets.
3. Re-subir assets conservando `public_id` cuando sea posible.
4. Para comprobantes, usar metadata en `payments.transfer_receipt_public_id`.
5. Si un comprobante no se puede recuperar, marcar el pago para revision contable y solicitar reenvio al cliente por canal privado.

## Si Vercel pierde variables

Variables criticas que deben inventariarse por nombre:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SUPABASE_PRODUCT_IMAGES_BUCKET`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `NEXT_PUBLIC_SITE_URL`
- `RATE_LIMIT_SALT`
- `CRON_SECRET`
- `SUPABASE_PLAN_NAME`
- `EMAIL_PROVIDER`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `BREVO_API_KEY`
- `BREVO_SENDER_EMAIL`
- `BREVO_SENDER_NAME`

No guardar valores en Git. Guardarlos en un administrador de secretos con acceso del `technical_owner`.

## Proteccion contra eliminacion accidental

- RLS y permisos por rol activos.
- Checkout escribe mediante RPC transaccional, no por inserts directos publicos.
- Inventario usa reservas y `FOR UPDATE` para evitar overselling.
- Comprobantes privados no se enlazan directamente en frontend publico.
- `/admin/uso` registra revisiones operativas.
- Se recomienda activar proteccion de ramas y requerir review antes de merge.

## Cron de reservas vencidas

Endpoint:

```http
GET /api/cron/check-expired-reservations
Authorization: Bearer CRON_SECRET
```

Si no hay cron configurado en Vercel, ejecutar manualmente desde una herramienta segura hasta configurar Vercel Cron.

## Cron-job.org

Configuracion recomendada:

1. Crear cuenta en https://cron-job.org.
2. Crear cron nuevo.
3. Iniciar sesión con la cuenta técnica `carzonetech0@gmail.com`.
4. URL: `https://carzoneaccesorios.vercel.app/api/cron/check-expired-reservations`.
5. Metodo: `GET` o `POST`.
6. Header: `Authorization: Bearer valor_de_CRON_SECRET`.
7. Frecuencia inicial: cada 1 hora.
8. Activar notificaciones de fallo hacia el `technical_owner`.
9. Revisar `/admin/uso` despues de la primera ejecucion.

Endpoints cron disponibles:

- `/api/cron/check-expired-reservations`: detecta reservas vencidas, crea alertas internas, registra auditoría y limpia rate limits antiguos. No libera stock automáticamente.
- `/api/cron/cleanup-rate-limits`: limpia ventanas antiguas de rate limiting.
- `/api/cron/cleanup-logs`: limpia `audit_logs`, `error_logs` y `notification_logs` con mas de 90 dias.

No usar cron sin `CRON_SECRET` en Vercel. Si falla, revisar `operational_cron_runs`, logs de Vercel y que el header este escrito exactamente como `Authorization`.

## Proveedor de correo

El proveedor se elige con `EMAIL_PROVIDER`.

Resend:

- `EMAIL_PROVIDER=resend`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`

Brevo:

- `EMAIL_PROVIDER=brevo`
- `BREVO_API_KEY`
- `BREVO_SENDER_EMAIL`
- `BREVO_SENDER_NAME`

El sistema registra `notification_logs` como `sent`, `failed` o `skipped`. Si faltan variables, el pedido no se rompe; se registra el fallo operativo.

## Limitaciones conocidas

- Supabase Free no reemplaza una estrategia externa de backups. Aunque existen backups diarios gestionados, no hay descarga directa en Free.
- PITR requiere plan compatible y add-on.
- Cloudinary signed URLs protegen acceso temporal, pero quien reciba la URL puede verla hasta que expire.
- Los backups de base de datos no restauran archivos eliminados de Cloudinary.
- Restauracion real debe probarse en un ambiente separado antes de considerarse confiable.
