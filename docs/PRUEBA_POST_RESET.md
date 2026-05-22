# Prueba manual post-reset

Esta guía valida que Car Zone Accesorios esté listo para demo, operación controlada y preparación comercial real después de limpiar datos o reiniciar el catálogo.

## Preparación

- Usar una cuenta administradora autorizada.
- Confirmar que no se trabajará con credenciales BAC reales hasta tener documentación oficial.
- Tener una imagen real de producto para probar carga visual.
- Validar CAI, rango fiscal y datos fiscales con la contadora antes de emitir facturas reales.

## Checklist operativo

1. Crear un producto real en `/admin/productos`.
   - Revisar nombre, SKU, categoría, marca, precios, descripción, compatibilidad y estado activo.

2. Subir imagen del producto.
   - Confirmar que se ve en admin, catálogo público y detalle de producto.

3. Cargar inventario en `/admin/inventario`.
   - Registrar una entrada.
   - Confirmar stock disponible, reservado y bajo mínimo.

4. Crear pedido desde la tienda pública.
   - Agregar producto al carrito.
   - Completar checkout con datos reales de prueba.
   - Confirmar que el pedido aparece en `/admin/pedidos`.

5. Confirmar pago.
   - Probar transferencia o método configurado.
   - Validar que el estado de pago cambie correctamente.

6. Generar factura.
   - Confirmar RTN, CAI, rango y datos del cliente.
   - Descargar o reimprimir PDF.

7. Rastrear pedido.
   - Copiar código de rastreo.
   - Buscarlo en `/rastreo`.
   - Confirmar que el estado público coincide con admin.

8. Crear cliente.
   - Revisar que el cliente aparezca en CRM.
   - Agregar nota: llamada, acuerdo o duda importante.
   - Crear seguimiento pendiente.

9. Solicitar cuenta mayorista.
   - Enviar solicitud desde el flujo público.
   - Confirmar que aparece como solicitud pendiente.

10. Aprobar mayorista.
    - Aprobar desde `/admin/clientes-mayoristas`.
    - Confirmar que el cliente queda con acceso mayorista.

11. Probar compra mayorista.
    - Entrar con cuenta mayorista aprobada.
    - Confirmar precio mayorista y mínimo de compra si aplica.
    - Crear pedido y revisar impacto en inventario.

12. Revisar CRM.
    - Confirmar prospectos, clientes, notas, seguimientos, pipeline y solicitudes mayoristas.
    - Verificar que los formularios se abren solo cuando se necesitan.

13. Revisar reportes.
    - Validar totales de ventas, ISV, productos, inventario y exportaciones.

14. Revisar BAC.
    - Abrir `/admin/revision-bac`.
    - Confirmar qué está completado, pendiente, requiere datos reales, credenciales BAC y revisión legal/contable.

15. Revisar usuarios y roles.
    - Crear una cuenta normal desde `/registro`.
    - Promoverla a `business_owner` desde `/admin/seguridad`.
    - Confirmar que el dueño entra a `/admin` y no ve secretos técnicos.

## Resultado esperado

- Cliente normal no entra a `/admin`.
- Dueño ve operación, reportes, clientes, mayoristas y configuración comercial.
- Bodega entiende entradas, salidas, ajustes, stock bajo, reservas y movimientos.
- Contadora ve advertencias fiscales antes de emitir facturas reales.
- Todo cambio sensible queda auditado.
- Checkout, inventario reservado, facturación, CRM, mayoristas y rastreo siguen funcionando.
