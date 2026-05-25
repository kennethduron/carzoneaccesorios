# Prueba de Operacion Real

Objetivo: validar que Car Zone Accesorios puede operar de punta a punta sin romper checkout, inventario, facturacion, CRM, mayoristas, roles, BAC, cron ni backups.

## Preparacion

- Usar un correo de prueba controlado.
- Confirmar que el ambiente apunta al proyecto Supabase/Vercel correcto.
- Tener permisos de admin para productos, inventario, pedidos, facturas, clientes, reportes y seguridad.
- No usar datos fiscales reales si la prueba no sera declarada contablemente.

## Flujo Cliente

1. Crear cliente desde `/registro`.
   - Resultado esperado: se crea `auth.users`, `users`, `customers` y seguimiento CRM automatico.

2. Verificar correo.
   - Resultado esperado: la cuenta entra sin mensaje de correo pendiente.

3. Login.
   - Resultado esperado: el menu de cuenta muestra pedidos/facturas del cliente.

## Flujo Producto e Inventario

4. Crear producto en `/admin/productos`.
   - Incluir SKU, nombre, categoria, precios, stock minimo y estado activo.

5. Subir imagen.
   - Resultado esperado: imagen principal visible en catalogo y detalle.

6. Cargar inventario en `/admin/inventario`.
   - Buscar el producto por SKU o nombre.
   - Registrar entrada.
   - Resultado esperado: stock disponible actualizado e historial creado.

## Flujo Pedido

7. Crear pedido desde `/checkout`.
   - Resultado esperado: pedido aparece en `/admin/pedidos`.
   - Confirmar reserva de inventario si aplica.

8. Confirmar pago.
   - Si es transferencia, revisar referencia/comprobante.
   - Resultado esperado: pago aprobado y pedido listo para preparar.

9. Generar factura en `/admin/facturas`.
   - Resultado esperado: factura emitida, numero fiscal asignado y PDF descargable.

10. Rastrear pedido en `/rastreo`.
    - Resultado esperado: codigo publico muestra estado correcto sin exponer datos internos.

## Flujo Mayorista

11. Crear solicitud mayorista.
    - Resultado esperado: cliente queda en estado pendiente y aparece en CRM/mayoristas.

12. Aprobar mayorista en `/admin/clientes-mayoristas`.
    - Resultado esperado: cuenta tiene acceso mayorista aprobado.

13. Compra mayorista.
    - Resultado esperado: catalogo/checkout aplica precio mayorista solo con cuenta aprobada y reglas configuradas.

## CRM y Reportes

14. Revisar CRM en `/admin/clientes`.
    - Confirmar perfil, notas, seguimientos, historial de pedidos y solicitud mayorista.

15. Revisar reportes en `/admin/reportes`.
    - Confirmar que pedidos, pagos, facturas, productos y clientes aparecen paginados.
    - No usar esta vista como cierre fiscal final sin validacion contable.

## Seguridad y Operacion

- Confirmar que usuarios internos no pueden eliminarse desde eliminacion de cliente.
- Confirmar que la cuenta Kenneth y roles `admin`, `business_owner`, `technical_owner` siguen protegidos.
- Confirmar que la eliminacion segura solo permite cuentas sin historial comercial/fiscal critico.
- Confirmar que `/admin/uso` muestra cron, backups, logs y reservas.
- Confirmar que `/admin/revision-bac` refleja estado real de BAC.

## Criterios de Aprobacion

- Checkout funciona sin errores.
- Inventario reservado se libera o confirma correctamente.
- Facturacion genera documentos correctos.
- CRM no pierde notas ni seguimientos reales.
- Mayoristas dependen de cuenta aprobada.
- Roles y permisos bloquean accesos no autorizados.
- Dashboard carga rapido y no trae miles de filas al frontend.
- Catalogo, productos, clientes, pedidos, facturas y reportes estan paginados.
