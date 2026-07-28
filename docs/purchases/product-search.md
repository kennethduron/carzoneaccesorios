# Búsqueda de productos en Compras e Inventario

Compras usa `search_purchase_products_v1`; busca por SKU, código interno, nombre o
marca y solo entrega costo a quien posee permisos `purchases:*`. Inventario usa
`search_inventory_products_v1`, con el mismo criterio pero sin costo y con los
campos de existencia autorizados.

Ambos RPC validan permisos en SQL, devuelven como máximo 50 filas, ordenan
coincidencias exactas, prefijos y parciales, y ofrecen paginación determinista. La
interfaz aplica debounce de 300 ms y cancelación con `AbortController`; no filtra
listas completas en React. El contrato se verificó localmente con 3,000 productos
transaccionales y `ROLLBACK`.

Compras rellena el costo al seleccionar un resultado autorizado. Inventario no
recibe costos. Las consultas pueden compartir el componente visual, pero conservan
endpoints, DTO y permisos independientes.
