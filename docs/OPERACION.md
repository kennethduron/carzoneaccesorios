# Operacion interna - Car Zone Accesorios

Este documento resume los flujos que sostienen la operacion real del sistema. No reemplaza pruebas ni criterio contable, pero debe revisarse antes de cambios en checkout, inventario, facturacion o CRM.

## Checkout

- El frontend no debe enviar totales finales confiables. El precio, impuesto, envio, comision contra entrega, descuento mayorista y total se calculan en backend/RPC.
- Los pedidos deben crearse por `public.create_checkout_order`; no se deben reabrir permisos directos de escritura sobre `orders`, `order_items` o `payments`.
- Los comprobantes de transferencia se suben desde servidor. Si el pedido falla despues de subir archivo, puede quedar un comprobante huerfano; se debe auditar periodicamente.
- Las notificaciones de correo no deben bloquear el pedido. El error se registra en logs operativos.

## Correos transaccionales

- El codigo no debe llamar Resend o Brevo directamente desde flujos de negocio. Usar `src/lib/email/email-provider.ts`.
- `EMAIL_PROVIDER=resend` envia por Resend.
- `EMAIL_PROVIDER=brevo` envia por Brevo.
- Si falta proveedor o API key, el pedido debe crearse igual y `notification_logs` debe quedar en `skipped` o `failed`.
- No mezclar email marketing con transaccional: pedidos, avisos internos y solicitudes operativas son transaccionales.
- Recuperacion de contrasena y confirmacion de cuenta siguen en Supabase Auth, salvo que luego se configure SMTP custom en Supabase.

Variables Resend:

- `EMAIL_PROVIDER=resend`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`

Variables Brevo:

- `EMAIL_PROVIDER=brevo`
- `BREVO_API_KEY`
- `BREVO_FROM_EMAIL`
- `BREVO_SENDER_NAME=Car Zone Accesorios`

Para Brevo, crear API key en Brevo > SMTP & API, autenticar dominio y verificar DKIM/DMARC antes de usar produccion.

Comparacion revisada el 21 de mayo de 2026:

- Resend Free: 100 correos transaccionales/dia y 3,000/mes; buena API para desarrolladores.
- Brevo Free: 300 correos/dia; sirve para transaccional y API/SMTP; conviene si el volumen gratis diario importa mas.
- Recomendacion: mantener Resend si ya esta autenticado y el volumen es bajo; cambiar a Brevo cuando se quiera mas margen gratis o unificar CRM/email, despues de autenticar dominio.

## Mayoristas

- Un visitante no autenticado no debe activar precio mayorista.
- Un cliente regular puede solicitar acceso mayorista, pero no debe ver ni forzar precio mayorista.
- Un mayorista aprobado debe tener cliente activo, usuario activo y `customers.wholesale_status = 'approved'`. La cuenta aprobada es la credencial mayorista; no se usan codigos.
- La primera compra minima se valida en backend contra el total final a pagar. Las compras posteriores dependen del historial registrado del cliente mayorista.

## Inventario

- Las entradas, salidas y ajustes administrativos deben pasar por RPC con bloqueo de fila.
- El checkout reserva inventario al crear pedido pendiente.
- La reserva se confirma como venta al aprobar pago.
- La reserva se libera al cancelar pedido o al vencer.
- El stock disponible se calcula desde `stock - reserved_stock`.

## Facturacion

- La factura fiscal debe generarse desde pedido existente y datos fiscales vigentes.
- CAI, rango, correlativo, fecha limite y duplicados se validan en backend.
- La anulacion debe conservar auditoria. Cualquier cambio en datos de factura emitida debe ser aprobado por contabilidad.
- No se deben borrar facturas reales ni movimientos relacionados.

## CRM

- El CRM concentra clientes, prospectos, notas, seguimientos y solicitudes mayoristas.
- La fusion de clientes debe ser conservadora: no fusionar clientes con facturas reales sin revision.
- Para volumen alto, duplicados y resumenes deben moverse a vistas/consultas optimizadas.

## No tocar sin cuidado

- Funciones SQL de checkout, inventario y facturacion.
- Policies RLS y grants de tablas sensibles.
- Variables `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `BREVO_API_KEY`, `CLOUDINARY_API_SECRET`, `CRON_SECRET`.
- Migraciones ya aplicadas en produccion.

## Cron-job.org

Configurar en cron-job.org:

- URL: `https://carzoneaccesorios.vercel.app/api/cron/release-expired-reservations`
- Metodo: `POST`
- Header: `Authorization: Bearer valor_de_CRON_SECRET`
- Frecuencia recomendada: cada 15 minutos si hay alto volumen de checkout; cada 30 minutos si el volumen es moderado.

Endpoints disponibles:

- `POST /api/cron/release-expired-reservations`
- `POST /api/cron/cleanup-rate-limits`
- `POST /api/cron/cleanup-logs`

Todos requieren `CRON_SECRET`. Revisar resultados en `/admin/uso`, seccion Cron y notificaciones.
