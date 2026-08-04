# Rollback forward-only retenido

Este rollback no debe ejecutarse como operación normal. Reintroduciría en agosto la distorsión mensual que la reparación autorizada elimina.

Si una contingencia exige volver ambos `entry_date` a `2026-08-03`, se debe crear una migración compensatoria nueva —nunca editar ni revertir la migración ya aplicada— y exigir, dentro de una sola transacción:

- autorización contable escrita específica para el rollback;
- advisory lock exclusivo;
- los dos IDs exactos y `entry_date = 2026-07-31`;
- hashes de líneas, cuentas, montos, estados y relaciones iguales a los registrados por la reparación;
- julio y agosto abiertos;
- ausencia de cambios o reversos posteriores;
- excepción de inmutabilidad limitada a esos IDs, esa transacción y al campo `entry_date`;
- `ROW_COUNT = 2`, auditoría append-only before/after y restauración verificada del guard.

El rollback de aplicación se hará mediante un commit de reversión normal y un deployment nuevo, sin `reset`, rebase destructivo ni force push. El RPC V1 no debe recuperar el fallback silencioso basado en `now()`.
