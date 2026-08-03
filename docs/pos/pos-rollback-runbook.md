# Runbook de rollback técnico del POS

## Principios

- El rollback nunca borra ventas, pedidos, facturas, pagos, CxC, inventario, auditoría o correlativos válidos.
- No uses `git reset --hard`, force push ni restauraciones destructivas de snapshots productivos.
- Si existe una venta POS real, sus efectos económicos deben preservarse.

## Código

1. Identifica el commit exacto que introdujo la regresión.
2. Crea una rama operativa desde `origin/main`.
3. Ejecuta `git revert <SHA>`.
4. Repite TypeScript, ESLint, build, pgTAP, pruebas POS y smoke read-only.
5. Integra mediante fast-forward y verifica el nuevo deployment.

## Base de datos

Si es necesario desactivar una definición, crea una migración forward revisada. Puede revocar temporalmente ejecución o sustituir funciones, pero no debe eliminar tablas o registros económicos ni devolver el correlativo fiscal.

## Contención

Si la confirmación no es segura, restringe el acceso POS mediante permisos técnicos y conserva lectura/recuperación de ventas ya confirmadas. No modifiques los flags contables, cutover ni publicación manual.

## Verificación posterior

- Dominio y SHA correctos.
- Rutas protegidas.
- Cero errores 5xx.
- Fingerprints económicos sin diferencias atribuibles.
- CROMOS, Edgar, Auto Centro, Polarizados, COGS protegida, períodos, flags y cutover intactos.
