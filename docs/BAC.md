# Preparacion BAC Credomatic

## Estado del sistema

La web ya incluye catalogo con precios, carrito, checkout, paginas de resultado de pago, politicas, HTTPS en produccion y mensaje de no almacenamiento de tarjetas.

## Pendiente antes de integracion real

- Credenciales productivas BAC.
- Codigo oficial de integracion.
- Webhook/backend con validacion de firma o respuesta bancaria.
- Confirmacion de 3D Secure segun documentacion BAC.
- Pruebas bancarias de aprobado, rechazado, cancelado y pendiente.
- Revision legal/contable de terminos, devoluciones, cancelaciones y comisiones.

## Reglas de seguridad

- No guardar numero de tarjeta, CVV ni fecha de vencimiento.
- No exponer credenciales BAC en `NEXT_PUBLIC_*`.
- Validar toda respuesta bancaria en backend.
- Registrar auditoria de pago sin guardar datos sensibles de tarjeta.
- No emitir factura fiscal automaticamente si el pago aun no esta confirmado, salvo criterio contable aprobado.

## Revision interna

Usar `/admin/revision-bac` como checklist operativo. Esa pantalla no reemplaza la aprobacion del banco ni la revision legal/contable.
