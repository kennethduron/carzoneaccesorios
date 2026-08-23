# Contencion de artefactos sensibles en OneDrive

Inventario read-only del 15 de julio de 2026. No se leyo contenido, no se movio ni borro ningun archivo.

| Categoria | Cantidad | Riesgo | Accion futura |
| --- | ---: | --- | --- |
| Variables `.env` | 4 | Critico | Revisar exposicion, rotar si corresponde y conservar valores solo en vault |
| Exportes/resultados JSON | 41 | Alto/medio | Separar datos reales de resultados ficticios; cifrar lo necesario y destruir temporales con aprobacion |
| Scripts operativos MJS | 11 | Revision | Conservar solo runbooks aprobados; bloquear ejecucion accidental |
| Logs | 22 | Medio/alto | Revisar secretos/datos personales, definir retencion y destruccion segura |
| SQL | 7 | Alto | Distinguir DDL reproducible de dumps/datos; cifrar o destruir con aprobacion |
| Capturas PNG | 7 | Alto | Revisar sesiones/datos visibles; conservar cifrado o destruir con aprobacion |
| Total | 92 | 4 criticos, 50 altos, 27 medios, 11 de revision | Pendiente de decision |

Todos estan ignorados por Git, pero el proyecto esta bajo OneDrive y puede sincronizarlos. El gate registra una linea base de 92 candidatos y falla si el conteo aumenta o si un candidato queda tracked/no ignorado. Es contencion inicial, no sustituye una allowlist por hash ni un directorio externo.

Plan futuro, sujeto a aprobacion:

1. Crear fuera del repositorio y fuera de OneDrive un directorio seguro configurable.
2. Clasificar cada candidato como conservar cifrado, migrar a vault, recreable o destruir.
3. Confirmar que ningun archivo es copia unica antes de mover/destruir.
4. Rotar credenciales que aparezcan en copias locales.
5. Migrar scripts operativos aprobados a un repositorio privado sin datos.
6. Sustituir la linea base por hashes de rutas aprobadas y bloquear cualquier candidato nuevo.
7. Ejecutar destruccion segura con registro y doble aprobacion.

Estado actual: cero acciones destructivas y cero candidatos nuevos respecto de la linea base.

