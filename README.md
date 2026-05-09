# Car Zone Accesorios

Sistema web profesional para catalogo, carrito, checkout, pedidos y factura de una empresa de accesorios automotrices.

## Regla Principal De Precios

Los productos tienen dos precios reales e independientes:

- `retail_price`
- `wholesale_price`

La tienda muestra `retail_price` por defecto. Si el cliente ingresa un codigo mayorista valido, el sistema cambia a `wholesale_price` en catalogo, producto individual, carrito, checkout, pedido y factura.

No se usan descuentos porcentuales ni cupones para mayoristas.

## Stack

- Next.js, React, TypeScript y Tailwind CSS
- Supabase Auth, PostgreSQL y Storage/Cloudinary para imagenes
- Vercel para hosting frontend
- PDF con `jspdf`
- Exportacion CSV nativa compatible con Excel

## Desarrollo Local

```bash
npm install
npm run dev
```

Abre `http://localhost:3000`.

Codigos mayoristas de prueba:

- `MAYORISTA-CZ-2026`
- `TALLER-PRO`

## Supabase

La configuracion de Supabase esta en:

```bash
supabase/config.toml
supabase/migrations
supabase/seed/seed.sql
```

Antes de conectar datos reales, crea un archivo `.env.local` con:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SUPABASE_PRODUCT_IMAGES_BUCKET=product-images
```

La validacion final de codigos mayoristas debe moverse a una funcion segura en backend, guardando hashes en `wholesale_codes.code_hash`.

Para aplicar en un proyecto cloud:

```bash
npx supabase login
npx supabase link --project-ref TU_PROJECT_REF
npx supabase db push
```

## Orden De Desarrollo

El proyecto se construye y valida en este orden para evitar dependencias rotas entre tienda, admin, precios, pedidos y facturacion:

1. **Proyecto base**: Next.js, TypeScript, Tailwind CSS, ESLint, estructura `src/app`, componentes, servicios, tipos y utilidades.
2. **Supabase**: variables de entorno, cliente SSR/browser, Auth, Storage y configuracion local/cloud.
3. **Base de datos**: migraciones PostgreSQL, relaciones, indices, RLS y seed inicial.
4. **Login**: registro, inicio de sesion, cierre de sesion y perfil de usuario.
5. **Roles**: admin, vendedor, bodega, contadora y cliente con permisos separados.
6. **Productos**: CRUD, categorias, imagenes, importacion/exportacion, stock y precios reales `retail_price`/`wholesale_price`.
7. **Sistema mayorista**: codigos unicos por cliente, expiracion, estado, usos y validacion segura.
8. **Cambio de precios**: modo global `retail`/`wholesale` usando `getProductPrice(product, priceMode)`.
9. **Carrito**: agregar, quitar, cantidades, subtotal, ISV, total y respeto de stock/precio activo.
10. **Checkout**: datos del cliente, Honduras solamente, transferencia, tarjeta preparada y efectivo.
11. **Inventario**: entradas, salidas, ajustes, historial y alertas de bajo stock.
12. **Pedidos**: estados, items, tipo de precio usado, cliente, direccion, telefono y pago.
13. **Facturacion**: RTN, CAI, numero fiscal, ISV, PDF, reimpresion y anulacion.
14. **Reportes**: ventas, productos mas vendidos, bajo stock, facturas, pedidos y clientes frecuentes con PDF/Excel/CSV.
15. **CRM**: prospectos, seguimientos, llamadas, reuniones, notas, historial, valor estimado y mensualidad.
16. **Seguridad**: validacion server-side, permisos, rutas protegidas, audit logs, backups y error boundaries.
17. **Optimizacion**: paginacion, indices SQL, imagenes optimizadas, consultas limitadas y carga incremental de productos.
18. **Deploy final**: migraciones aplicadas, variables en Vercel/Supabase, build limpio, smoke test y dominio/SSL.

Antes de pasar al siguiente hito, deben pasar:

```bash
npm run lint
npm run build
```

Para el deploy final, aplica migraciones en Supabase, configura `.env` en Vercel y valida al menos estos flujos: login admin, catalogo paginado, codigo mayorista, carrito, checkout, pedido, factura, reporte, CRM y seguridad.

## Autenticacion

Rutas:

```txt
/login
/registro
/cuenta
/admin
/auth/logout
/sin-permiso
```

Roles configurados:

```txt
Admin
Vendedor
Bodega
Contadora
Cliente
```

`/cuenta` requiere sesion. `/admin` requiere un rol interno con permiso `admin:access`.

## Scripts

```bash
npm run lint
npm run build
```
