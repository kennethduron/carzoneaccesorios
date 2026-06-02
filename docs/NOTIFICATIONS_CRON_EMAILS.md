# Notificaciones, cron y cola de correos

## Arquitectura

El sistema usa tres capas:

1. `internal_notifications`: alertas internas del admin con modulo, severidad, destinatarios por rol, estado de lectura y `dedupe_key`.
2. `notification_preferences`: preferencias por tipo de evento para notificacion interna, correo, push futuro y roles destinatarios.
3. `email_queue`: cola transaccional. Los flujos del negocio encolan primero y `/api/cron/process-email-queue` envia despues con Brevo cuando este habilitado.

Cron-Job.org no envia correos. Solo llama endpoints protegidos con `Authorization: Bearer <CRON_SECRET>`.

## Variables de entorno

```env
CRON_SECRET=
EMAIL_PROVIDER=resend
EMAIL_ENABLED=true
RESEND_API_KEY=
RESEND_FROM_EMAIL=
RESEND_FROM_NAME=Car Zone Accesorios
RESEND_REPLY_TO=

BREVO_ENABLED=false
BREVO_API_KEY=
BREVO_SENDER_EMAIL=
BREVO_SENDER_NAME=Car Zone Accesorios
BREVO_REPLY_TO=

FCM_ENABLED=false
FCM_PROJECT_ID=
FCM_CLIENT_EMAIL=
FCM_PRIVATE_KEY=
```

Resend es el proveedor activo por ahora. Si `EMAIL_PROVIDER` no esta definido, el sistema usa Resend automaticamente cuando existen `RESEND_API_KEY` y `RESEND_FROM_EMAIL`.

Mientras `EMAIL_ENABLED=false` o falte el proveedor, la cola no envia correos y los deja pendientes. Brevo queda preservado para una fase futura.

## Correos inteligentes

- El correo inicial de pedido recibido es obligatorio y siempre se encola para el cliente.
- El cliente decide en checkout si desea actualizaciones por correo.
- Cambios normales de estado solo se mandan al cliente si acepto actualizaciones.
- Cancelacion de pedido y pago rechazado se consideran criticos y se encolan aunque el cliente no haya aceptado actualizaciones.
- Correos internos usan `notification_preferences` por rol y `notification_user_preferences` por usuario.
- Stock bajo normal crea alerta interna; stock critico/agostado puede encolar correo y se deduplica por producto.
- Backup exitoso, salud OK y cron exitoso no generan correo por defecto.

## Firebase Cloud Messaging

El sistema queda preparado con `fcm_device_tokens` y rutas internas:

- `GET /api/admin/push/status`
- `POST /api/admin/push/device-token`

Si FCM no esta configurado, la UI muestra estado deshabilitado y no rompe el admin.

## Cron-Job.org

Dominio de produccion: `https://carzoneaccesorios.vercel.app`

| nombre | URL completa | metodo | frecuencia recomendada | header requerido | que hace | prioridad |
|---|---|---:|---|---|---|---:|
| Reservas vencidas | `https://carzoneaccesorios.vercel.app/api/cron/check-expired-reservations` | GET o POST | Cada 1 hora | `Authorization: Bearer <CRON_SECRET>` | Detecta reservas vencidas, marca revision, crea alerta interna y encola correos. No libera stock automaticamente. | Alta |
| Procesar cola de correos | `https://carzoneaccesorios.vercel.app/api/cron/process-email-queue` | GET o POST | Cada 5-15 minutos | `Authorization: Bearer <CRON_SECRET>` | Toma correos pending/retrying, envia por Brevo si esta habilitado y reintenta fallos. | Alta |
| Seguimientos CRM vencidos | `https://carzoneaccesorios.vercel.app/api/cron/check-overdue-followups` | GET o POST | Cada 1 hora | `Authorization: Bearer <CRON_SECRET>` | Detecta followups vencidos y notifica responsables o roles operativos. | Alta |
| Tareas vencidas | `https://carzoneaccesorios.vercel.app/api/cron/check-overdue-tasks` | GET o POST | Cada 1-6 horas | `Authorization: Bearer <CRON_SECRET>` | Detecta tareas CRM vencidas y crea alertas internas. | Media |
| Stock bajo | `https://carzoneaccesorios.vercel.app/api/cron/check-low-stock` | GET o POST | Cada 6 horas o diario | `Authorization: Bearer <CRON_SECRET>` | Detecta productos bajo minimo o agotados y evita duplicados por producto. | Media |
| Mayoristas pendientes | `https://carzoneaccesorios.vercel.app/api/cron/check-pending-wholesale-requests` | GET o POST | Cada 6 horas | `Authorization: Bearer <CRON_SECRET>` | Detecta solicitudes mayoristas pendientes por mas de 24h. | Media |
| Backups | `https://carzoneaccesorios.vercel.app/api/cron/create-backup` | GET o POST | Diario | `Authorization: Bearer <CRON_SECRET>` | Verifica `backup_logs` y alerta a technical_owner si falta o fallo. | Alta |
| Salud del sistema | `https://carzoneaccesorios.vercel.app/api/cron/system-health-check` | GET o POST | Diario | `Authorization: Bearer <CRON_SECRET>` | Revisa crons fallidos, correos failed y errores operativos recientes. | Alta |

## Idempotencia

Las alertas usan `dedupe_key` por evento y entidad relacionada, por ejemplo:

- `inventory.low_stock:<product_id>`
- `crm.followup_overdue:<followup_id>`
- `wholesale.request_pending_24h:<customer_id>`
- `reservation-review:<notification_id>:<recipient>`

La cola usa `idempotency_key` unico para no duplicar correos si el cron corre dos veces.

## Brevo

Brevo queda aislado en `src/lib/email/email-provider.ts`. Los modulos de negocio no deben llamar el proveedor directamente; deben usar `enqueueEmail`.

La verificacion de cuenta de Supabase Auth no se reemplaza en esta fase. Cambiar ese flujo requiere una fase separada para auditar `auth/callback`, confirmacion de email y reenvio de verificacion sin romper registro/login.
