# Servicios técnicos privados - Car Zone Accesorios

Este documento es operativo. No publicar su contenido en checkout, catálogo, footer, contacto, facturas ni correos para clientes.

## Cuenta técnica oficial

La cuenta administradora de servicios externos e integraciones es:

`carzonetech0@gmail.com`

Usarla para:

- Cron-Job.org.
- Cloudinary.
- Brevo.
- Backups.
- Alertas técnicas.
- Notificaciones técnicas.
- Integraciones futuras.

No usar cuentas técnicas anteriores.

## Cron-Job.org

Configurar el chequeo de reservas vencidas:

```http
GET https://carzoneaccesorios.com/api/cron/check-expired-reservations
Authorization: Bearer valor_de_CRON_SECRET
```

- También acepta `POST`.
- Variable requerida en Vercel: `CRON_SECRET`.
- Frecuencia inicial recomendada: cada 1 hora.
- No guardar el valor real del secreto en Git, tickets, capturas ni documentación.
- El endpoint es idempotente: conserva el stock, marca revisión humana y evita alertas abiertas duplicadas.
- Una respuesta exitosa tiene forma `{"ok":true,"reviewRequiredOrders":0,"email":{"sent":0,"failed":0}}`.
- Una llamada sin token válido responde HTTP `401` con `{"message":"No autorizado."}`.
- Cada ejecución autorizada se registra en `operational_cron_runs`.
- Cada reserva detectada registra auditoría `inventory.reservation.review_required`.

## Proveedores

- Cloudinary: productos, banners, comprobantes permitidos y assets del proyecto.
- Brevo: correo transaccional cuando el dominio esté verificado.
- Backups: respaldos, inventarios de variables y alertas de restauración.
- Alertas: cron fallido, backups, uso alto de Cloudinary, errores críticos, notificaciones fallidas y reservas no procesadas.

Las API keys, tokens y secretos viven fuera de Git y nunca deben aparecer en UI pública.
