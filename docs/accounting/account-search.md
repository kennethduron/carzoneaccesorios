# Búsqueda administrativa de cuentas

La búsqueda usa `search_accounting_accounts_v1` y consulta código y nombre con
normalización de mayúsculas, espacios y tildes. Ordena coincidencias exactas,
prefijos y coincidencias parciales, y devuelve solo cuentas activas y de
movimiento autorizadas.

El RPC vuelve a validar permisos contables. La API no descarga el catálogo: limita
cada página a 50 resultados (25 por defecto) y utiliza `offset` acotado. El
componente compartido aplica 300 ms de debounce, cancela solicitudes anteriores,
soporta teclado y comunica carga, error, cero resultados y “cargar más”.

Se integra en creación manual, edición de borradores, mapeos contables y filtro
del Libro Mayor. La consulta y su DTO permanecen separados de la búsqueda de
productos porque sus datos y permisos son distintos.
