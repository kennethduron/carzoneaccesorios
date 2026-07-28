# Reversas de partidas contables

## Contrato

Las partidas con estado `publicada` y las partidas originales con estado `reversada`
continúan contabilizadas. Libro Mayor, saldo inicial, Balanza de Comprobación,
Balance General, Estado de Resultados, PDF y Excel deben incluir ambos estados.
La reversa permanece `publicada`, por lo que original y reversa se compensan sin
borrar el historial.

Si un rango contiene solamente uno de los dos movimientos, el otro debe formar
parte del saldo inicial cuando su fecha contable sea anterior al rango.

## Operación

`reverse_journal_entry` exige un motivo normalizado de 10 a 500 caracteres. En una
sola transacción bloquea la original, comprueba permiso, período, estado, cuadre y
duplicidad, copia sus líneas invirtiendo débito y crédito, publica la reversa,
marca la original `reversada` y registra la relación, actor, motivo, fecha, IP y
agente de usuario.

No se puede reversar una partida cuyo `source_type` sea `journal_reversal` o cuyo
`metadata.entry_kind` sea `reversal`. Tampoco se permite una segunda reversa de la
misma original. La interfaz oculta la acción en ambos casos, pero la protección
autoritativa reside en el RPC.

## Procedimiento correcto

1. Reversar una vez la partida publicada, indicando el motivo real.
2. Verificar la relación visual entre original y reversa.
3. Registrar después una sola partida nueva con las cuentas correctas.

No se debe borrar la original, regresarla a borrador ni crear otra partida para
“eliminar” la reversa. La migración no repara ni modifica partidas históricas.
