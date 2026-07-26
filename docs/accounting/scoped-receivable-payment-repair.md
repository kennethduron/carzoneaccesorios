# Reparacion dirigida de un abono historico

Esta herramienta solo admite un `accounts_receivable_payments.id` completo. No
recopila todos los abonos ni ofrece un modo de escritura global.

## Preview

```bash
node --env-file=.env.local scripts/accounting/repair-missing-receivable-payment-events.mjs \
  --payment-id=<UUID>
```

El preview consulta el abono mediante `id = paymentId` y carga solamente su CxC,
evento exacto, outbox exacta, partida vinculada, posibles equivalentes manuales
de la misma fecha, mapeos aplicables, periodo y evento de control. Enmascara los
identificadores y no ejecuta RPC mutables.

## Apply

```bash
RECEIVABLE_PAYMENT_REPAIR_CONFIRM=APPLY_RECEIVABLE_PAYMENT_REPAIR \
node --env-file=.env.local scripts/accounting/repair-missing-receivable-payment-events.mjs \
  --apply \
  --payment-id=<UUID> \
  --expected-event-id=<UUID> \
  --expected-amount=<DECIMAL> \
  --expected-date=<YYYY-MM-DD> \
  --expected-method=<METHOD>
```

`--apply` exige siempre `--payment-id`, importe, fecha y metodo esperados, ademas
de la confirmacion por entorno. El event ID esperado es una guarda adicional
recomendada y obligatoria para intervenciones productivas autorizadas.

La herramienta bloquea abonos inexistentes, ambiguos, anulados, con datos
distintos de las expectativas, sin evento exacto, con otro event ID, con
partida vinculada o equivalente manual, sin mapeos, en periodo cerrado o con
outbox en procesamiento.

La reparacion reutiliza el evento `receivable_payment/v1`, crea o reconcilia una
sola outbox y genera una partida en `borrador`. Las cuentas se resuelven de nuevo
desde los mapeos persistidos. Nunca publica, no cambia saldos, no crea otro
abono y excluye expresamente `receivable_paid`.

Nunca se debe utilizar `--apply` sin un UUID completo. Una segunda ejecucion
despues de crear la partida se rechaza como innecesaria y no crea duplicados.
