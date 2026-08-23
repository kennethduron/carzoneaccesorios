# Inventario de variables para backups y DR

Este documento registra nombres y dependencias, nunca valores.

| Categoria | Variables | Ambientes | Estado | Criticidad | Recuperacion |
| --- | --- | --- | --- | --- | --- |
| Supabase cliente | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Production, Preview, Development | Existentes en la aplicacion | Alta | Inventario de Vercel + configuracion del proyecto |
| Supabase servidor | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN` | Servidor/operacion | Presencia parcial; verificar por ambiente | Critica | Vault separado y procedimiento Supabase |
| Backup v2 | `BACKUP_ENCRYPTION_KEY_BASE64`, `BACKUP_ENCRYPTION_KEY_ID`, `BACKUP_PRIMARY_PROVIDER`, `BACKUP_COMMIT_SHA` | Production, Preview, Development | Requeridas; no configuradas/aprobadas para Produccion | Critica | Dos custodios; clave fuera del proveedor de backups |
| Email secundario | `TECHNICAL_BACKUP_EMAIL`, `EMAIL_PROVIDER`, `EMAIL_ENABLED`, variables Resend/Brevo | Production, Preview, Development | Proveedor existente; correo solo secundario | Alta | Inventario del proveedor y cuenta institucional |
| Cron | `CRON_SECRET` | Production | Existente; valor no auditado | Critica | Vault y rotacion documentada |
| Cloudinary | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Production, Preview, Development | Integracion existente; backup de bytes no confirmado | Critica | Cuenta Cloudinary + vault |
| Firebase/FCM | variables `NEXT_PUBLIC_FIREBASE_*`, `FCM_*` | Segun ambiente | Integracion existente; cobertura DR separada | Alta | Consola Firebase + vault |
| Google Drive legado | `GOOGLE_DRIVE_CLIENT_EMAIL`, `GOOGLE_DRIVE_PRIVATE_KEY`, `GOOGLE_DRIVE_BACKUP_FOLDER_ID` | Servidor | Desactivado/no aprobado | Alta | No configurar sin decision expresa |
| Seguridad auxiliar | `VERIFICATION_SIGNING_SECRET`, `RATE_LIMIT_SALT`, `ERROR_LOG_HASH_SALT` | Servidor | Verificar inventario y rotacion | Alta | Vault y runbook |

Responsable propuesto: `technical_owner`. El `business_owner` recibe estado y evidencia de recuperacion, no valores. Admin y contadora reciben solo fecha/cobertura/integridad segun permisos. Otros roles no reciben acceso.

Custodia minima recomendada:

- valor en un vault externo con MFA y registro de acceso;
- copia de recuperacion offline cifrada bajo control de dos custodios;
- identificador de clave en Vercel y DB, nunca el valor;
- prueba trimestral de recuperacion de clave;
- rotacion al menos anual o inmediata tras sospecha de exposicion;
- no depender de `.env.local` ni de la misma cuenta/proveedor que almacena el backup.

