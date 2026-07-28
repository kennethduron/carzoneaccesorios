# Contrato público de productos

`public_catalog_products_v1` es la única proyección pública del catálogo. Incluye
los campos requeridos por catálogo, detalle y sitemap, pero excluye `cost_price`,
proveedor, margen, controles internos de stock y auditoría.

`anon` y los usuarios autenticados ordinarios no tienen `SELECT` general sobre
`products`; `service_role` conserva el acceso administrativo. El costo de compras
se obtiene exclusivamente mediante `search_purchase_products_v1`, que vuelve a
validar permisos dentro de SQL. Los servicios administrativos de productos usan
el cliente confiable y además omiten el costo de los DTO enviados a roles sin el
permiso correspondiente.

La prueba de seguridad debe confirmar que la vista pública funciona, que
`products?select=cost_price` es rechazado para `anon` y que `anon` no puede invocar
la búsqueda administrativa. Después de aplicar la migración se deben regenerar
los tipos de Supabase para incorporar la vista y los RPC nuevos.
