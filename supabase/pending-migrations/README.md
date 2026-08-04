# Migraciones retenidas por gates externos

Estos archivos no forman parte de la secuencia que aplica `supabase db push`.

- `202608040004_repair_technical_duplicate_reversal_dates.sql` requiere autorización contable escrita, un preflight productivo nuevo y confirmar que el número de migración sigue disponible.
- `202608040005_retire_legacy_accounting_reversal_rpc.sql` requiere confirmar en logs y código desplegado que ningún consumidor sigue usando el RPC V1.

Antes de promover cualquiera, se debe copiar a `supabase/migrations` con el siguiente número real disponible, conservar sus gates de aborto y ejecutar nuevamente pgTAP, build y fingerprint.
