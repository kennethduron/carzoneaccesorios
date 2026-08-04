# Migraciones retenidas por gates externos

Estos archivos no forman parte de la secuencia que aplica `supabase db push`.

- `202608040005_retire_legacy_accounting_reversal_rpc.sql` requiere confirmar en logs y codigo desplegado que ningun consumidor sigue usando el RPC V1.

Antes de promover la migracion retenida, se debe copiar a `supabase/migrations` con el siguiente numero real disponible, conservar sus gates de aborto y ejecutar nuevamente pgTAP, build y fingerprint.

