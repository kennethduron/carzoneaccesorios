# Modern Backup V2 — Phase 4B.3

## Alcance y estado

Phase 4B.3 implementa artefactos canónicos, cifrados y verificables para `auth`, `storage_metadata`, `storage_objects` y `external_assets`. No activa scheduler, no conecta producción, no ejecuta restauraciones y no cambia esquemas. La base de datos sigue usando el artefacto Phase 4B.2.

Los cinco componentes requeridos por `CAR_ZONE_RECOVERY_POLICY` pertenecen a una sola `generation_key`. Ningún componente aislado permite declarar `full_dr_ready`: también se requieren copia primaria, copia secundaria independiente verificada y evidencia de disponibilidad de la llave de recuperación.

## Contrato común

Cada componente 4B.3 usa:

- manifest superior `car-zone-backup-v2-manifest-v1`, autoritativo y en JSON canónico;
- payload `car-zone-record-stream-v1`, ordenado por puntos de código Unicode;
- inventario paginado con cursores acotados, detección de duplicados y snapshot estable;
- trailer cifrado que repite snapshot, huella de inventario, componente, conteo y binding;
- streaming con backpressure, límites explícitos y concurrencia efectiva de una descarga por vez;
- gzip RFC 1952, AES-256-GCM y SHA-256 mediante el mismo módulo de streaming usado por Phase 4B.2;
- AAD ligado a run, generation, component, catálogo, preflight, snapshot, inventario, llave y formato;
- verificación completa por decrypt + gunzip + parser antes de publicar;
- segunda lectura de autoridad/lease antes de `rename` atómico de directorio parcial a canónico;
- reintento idempotente: un artefacto canónico existente solo se reutiliza después de verificación completa.

Los nombres de bucket, object keys y public IDs siempre se tratan como datos dentro del payload. Nunca se convierten en rutas locales. Un payload vacío es válido, y un objeto de cero bytes es distinto de un objeto ausente.

## AUTH: export directo del esquema Auth

El Admin API de Supabase no expone hashes de credenciales, por lo que no es suficiente para continuidad de login. El source adapter de 4B.3 exige una lectura directa, consistente y paginada del esquema `auth` desde una transacción read-only o snapshot equivalente.

Se incluyen, cuando existen en la versión desplegada:

- `users`, conservando `encrypted_password` y estado durable de seguridad;
- `identities` y vínculos de proveedor;
- `mfa_factors`, incluyendo secreto durable cifrado por el artefacto;
- `webauthn_credentials`;
- `oauth_clients`, `oauth_consents`, `sso_providers`, `sso_domains` y `saml_providers`.

Se excluyen por ser efímeros o recreables:

- `sessions`, `refresh_tokens`, `one_time_tokens`, `flow_state`;
- `mfa_challenges`, `mfa_amr_claims`;
- `oauth_authorizations`, `oauth_client_states`;
- relay state SAML transitorio;
- `webauthn_challenges`;
- columnas de token de un solo uso en `users`, como confirmation, recovery, email/phone change y reauthentication tokens;
- access/refresh/provider tokens y secretos OAuth de configuración, incluso si aparecen anidados en metadata.

Los secretos de configuración de proveedores OAuth/SMTP no se exportan. Solo debe respaldarse evidencia/fingerprint de configuración; los valores se recuperan desde el administrador de secretos. Fallan cerrado los cambios de snapshot entre tablas, cursores repetidos, IDs duplicados, páginas inválidas y filas no representables en JSON canónico.

La restauración sintética debe crear un proyecto Auth aislado, cargar primero usuarios, luego identities/MFA/WebAuthn y finalmente configuración durable, y comprobar login con contraseña, proveedores y MFA soportados. Nunca se valida contra producción.

## STORAGE_METADATA

Este componente preserva por separado buckets y filas de metadata: nombre, visibilidad pública/privada, límites, tipos MIME permitidos, propietario, object key, timestamps, tamaño, ETag/version y metadata definida por proveedor. La política pública/privada debe quedar explícita; no se infiere de la URL.

El inventario incluye buckets vacíos. Las pruebas sintéticas cubren buckets vacíos, públicos y privados, claves anidadas, Unicode y metadata de objetos de cero bytes. La restauración crea primero buckets/políticas y luego metadata compatible con la versión destino.

## STORAGE_OBJECTS

El source enumera todos los buckets y objetos usando paginación completa. Para cada objeto declara tamaño exacto y SHA-256 antes de abrir el stream; durante descarga vuelve a medir ambos. La lista completa se repite después de descargar y cualquier creación, eliminación, mutación, duplicado o drift de snapshot cancela la publicación.

El pipeline de `storage_objects` primero descifra y verifica el artefacto `storage_metadata` de la misma autoridad/generación. El manifest exige como `binding_fingerprint` la huella canónica de ese inventario, y cada ID de objeto debe existir también en el inventario de metadata descifrado. Sin esa relación el pipeline rechaza la ejecución.

La restauración sintética valida cantidad, claves exactas, tamaños, hashes y descargas de cero bytes después de reconstruir metadata.

## EXTERNAL_ASSETS: Cloudinary

La auditoría del código confirma Cloudinary como fuente externa actual. Se usa en imágenes de producto (`src/app/admin/productos/actions.ts`), banners (`src/services/supabase/holiday-banners.service.ts`), logo fiscal, comprobantes de transferencia (`src/app/checkout/actions.ts`) y comprobantes de proveedor (`src/services/supplier-payment-receipt.service.ts`). Supabase Storage sigue siendo otra fuente, actualmente con bucket por defecto `product-images` en `src/services/supabase/storage.service.ts`.

El reader de Cloudinary debe recorrer todas las páginas y tipos relevantes (`image`, `video`, `raw`, y delivery types usados) y devolver solo originales. El ID estable incluye `public_id`, `resource_type`, `type` y `version`. Las transformaciones derivadas no se copian porque se reconstruyen desde el original y su referencia/version; nunca se acepta una transformación como sustituto del original.

La descarga aplica defensa SSRF por cada salto:

- solo HTTPS;
- hostname exacto `res.cloudinary.com` y path bajo el `cloud_name` configurado;
- sin credenciales embebidas ni puerto alterno;
- redirects manuales, limitados y revalidados;
- resolución DNS obligatoria y rechazo de loopback, link-local, rangos privados, multicast y direcciones inválidas;
- tamaño máximo, Content-Length coherente cuando existe, tamaño real y SHA-256 exactos.

El fetcher y resolver son dependencias inyectadas para pruebas deterministas. El adaptador no lee ni serializa `CLOUDINARY_API_SECRET`; el API secret solo autoriza el listado en el reader implementado por el entorno.

## Fallos cerrados y operación

El pipeline elimina el directorio parcial si falla exportación, hash, drift, parsing, manifest, autoridad o lease. Nunca sobreescribe un directorio canónico. Un conflicto concurrente falla y obliga a verificar el ganador.

Los logs operativos deben registrar únicamente códigos, componente, run/generation y conteos; no payloads, URLs firmadas, tokens, hashes de contraseña, secretos MFA, llaves o cuerpos. Los manifests no contienen datos de negocio ni secretos, solo evidencia criptográfica y referencias seguras.

Antes de habilitar un runner futuro se deben implementar readers concretos con credenciales de mínimo privilegio, snapshot read-only, pinning de conexión/destino aprobado y almacenamiento primario/secundario independiente. Esa activación está fuera de Phase 4B.3.

## Evidencia de prueba requerida

`npm run test:backup-v2:phase4b3` ejecuta exclusivamente fixtures locales y comprueba round-trip de los cuatro componentes, tampering, drift, duplicados, Unicode, cero bytes, binding de storage, exclusiones Auth, SSRF/redirects, reuso canónico y evaluación del recovery set completo. `npm run test:backup-v2` conserva Phase 4B.1, Phase 4B.2 y agrega Phase 4B.3.
