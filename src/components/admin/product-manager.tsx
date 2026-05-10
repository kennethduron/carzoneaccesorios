"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  Archive,
  CheckCircle2,
  Download,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  deleteProductAction,
  importProductsAction,
  saveProductAction,
  setProductActiveAction,
  uploadProductImageAction,
} from "@/app/admin/productos/actions";
import { Button, Input } from "@/components/ui";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { formatCurrency } from "@/utils/pricing";
import type { CategoryOption, ProductAdminRow, ProductFormInput, ProductImageInput, ProductStatus } from "@/types/products";

type ProductManagerProps = {
  products: ProductAdminRow[];
  categories: CategoryOption[];
  total: number;
  page: number;
  pageSize: number;
  filters: {
    query: string;
    status: string;
    categoryId: string;
  };
};

const statusLabels: Record<ProductStatus, string> = {
  active: "Activo",
  inactive: "Inactivo",
  draft: "Borrador",
  archived: "Archivado",
};

const emptyImage: ProductImageInput = {
  public_url: "",
  storage_path: "",
  angle: "principal",
  alt_text: "",
  sort_order: 0,
  is_primary: true,
};

const emptyProduct: ProductFormInput = {
  category_id: null,
  sku: "",
  internal_code: "",
  slug: "",
  name: "",
  brand: "",
  vehicle_brand: null,
  vehicle_model: null,
  vehicle_year_start: null,
  vehicle_year_end: null,
  description: "",
  stock: 0,
  min_stock: 5,
  cost_price: 0,
  retail_price: 0,
  wholesale_price: 0,
  wholesale_min_quantity: 1,
  status: "active",
  active: true,
  images: [emptyImage],
};

function toFormProduct(product: ProductAdminRow): ProductFormInput {
  return {
    id: product.id,
    category_id: product.category_id,
    sku: product.sku,
    internal_code: product.internal_code,
    slug: product.slug,
    name: product.name,
    brand: product.brand,
    vehicle_brand: product.vehicle_brand,
    vehicle_model: product.vehicle_model,
    vehicle_year_start: product.vehicle_year_start,
    vehicle_year_end: product.vehicle_year_end,
    description: product.description,
    stock: product.stock,
    min_stock: product.min_stock,
    cost_price: product.cost_price,
    retail_price: product.retail_price,
    wholesale_price: product.wholesale_price,
    wholesale_min_quantity: product.wholesale_min_quantity,
    status: product.status,
    active: product.active,
    images: product.images.length > 0 ? product.images : [emptyImage],
  };
}

function numberValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const productCsvHeaders = [
  "sku",
  "codigo_interno",
  "nombre",
  "marca",
  "marca_carro",
  "modelo_carro",
  "anio_inicial",
  "anio_final",
  "categoria",
  "stock",
  "stock_minimo",
  "precio_costo",
  "precio_detalle",
  "precio_mayorista",
  "cantidad_minima_mayorista",
  "estado",
  "activo",
  "url_imagen",
  "angulo_imagen",
];

function csvValue(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

export function ProductManager({ products, categories, total, page, pageSize, filters }: ProductManagerProps) {
  const [query, setQuery] = useState(filters.query);
  const [status, setStatus] = useState<ProductStatus | "all">(filters.status as ProductStatus | "all");
  const [categoryId, setCategoryId] = useState(filters.categoryId);
  const [editing, setEditing] = useState<ProductFormInput | null>(null);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const debouncedQuery = useDebouncedValue(query, 400);

  const filteredProducts = useMemo(() => {
    const normalizedQuery = debouncedQuery.trim().toLowerCase();

    return products.filter((product) => {
      const matchesQuery =
        !normalizedQuery ||
        `${product.sku} ${product.internal_code ?? ""} ${product.name} ${product.brand} ${product.description}`
          .toLowerCase()
          .includes(normalizedQuery);
      const matchesStatus = status === "all" || product.status === status;
      const matchesCategory = categoryId === "all" || product.category_id === categoryId;

      return matchesQuery && matchesStatus && matchesCategory;
    });
  }, [categoryId, debouncedQuery, products, status]);

  const lowStockCount = products.filter((product) => product.stock <= product.min_stock).length;
  const activeCount = products.filter((product) => product.active).length;
  const inventoryValue = products.reduce((sum, product) => sum + product.cost_price * product.stock, 0);
  const hasNextPage = page * pageSize < total;

  function buildPageHref(nextPage: number) {
    const params = new URLSearchParams();
    if (filters.query) {
      params.set("q", filters.query);
    }
    if (filters.status && filters.status !== "all") {
      params.set("status", filters.status);
    }
    if (filters.categoryId && filters.categoryId !== "all") {
      params.set("category", filters.categoryId);
    }
    if (nextPage > 1) {
      params.set("page", String(nextPage));
    }

    const queryString = params.toString();
    return queryString ? `/admin/productos?${queryString}` : "/admin/productos";
  }

  function updateField<K extends keyof ProductFormInput>(field: K, value: ProductFormInput[K]) {
    setEditing((current) => (current ? { ...current, [field]: value } : current));
  }

  function updateImage(index: number, patch: Partial<ProductImageInput>) {
    setEditing((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        images: current.images.map((image, imageIndex) => {
          if (imageIndex !== index) {
            return patch.is_primary ? { ...image, is_primary: false } : image;
          }
          return { ...image, ...patch };
        }),
      };
    });
  }

  function uploadImage(index: number, file: File | null) {
    if (!file || !editing) {
      return;
    }

    startTransition(async () => {
      const formData = new FormData();
      formData.set("file", file);
      formData.set("productSlug", editing.slug || editing.sku || editing.name || "producto");
      formData.set("angle", editing.images[index]?.angle || "principal");

      const result = await uploadProductImageAction(formData);
      setMessage(result.message);

      if (result.ok && result.publicUrl) {
        updateImage(index, {
          public_url: result.publicUrl,
          storage_path: result.storagePath,
        });
      }
    });
  }

  function submitProduct() {
    if (!editing) {
      return;
    }

    startTransition(async () => {
      const result = await saveProductAction(editing);
      setMessage(result.message);
      if (result.ok) {
        setEditing(null);
      }
    });
  }

  function toggleActive(product: ProductAdminRow) {
    startTransition(async () => {
      const result = await setProductActiveAction(product.id, !product.active);
      setMessage(result.message);
    });
  }

  function deleteProduct(product: ProductAdminRow) {
    const confirmed = window.confirm(`¿Eliminar ${product.name}? Esta acción no se puede deshacer.`);
    if (!confirmed) {
      return;
    }

    startTransition(async () => {
      const result = await deleteProductAction(product.id);
      setMessage(result.message);
    });
  }

  function exportCsv() {
    const headers = productCsvHeaders;
    const rows = filteredProducts.map((product) => [
      product.sku,
      product.internal_code,
      product.name,
      product.brand,
      product.vehicle_brand,
      product.vehicle_model,
      product.vehicle_year_start,
      product.vehicle_year_end,
      product.category_name,
      product.stock,
      product.min_stock,
      product.cost_price,
      product.retail_price,
      product.wholesale_price,
      product.wholesale_min_quantity,
      product.status,
      product.active,
      product.images[0]?.public_url ?? "",
      product.images[0]?.angle ?? "",
    ]);
    const csv = [headers.join(","), ...rows.map((row) => row.map(csvValue).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "car-zone-productos.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  function importCsv(file: File | null) {
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? "");
      const [headerLine, ...lines] = content.split(/\r?\n/).filter(Boolean);
      const headers = parseCsvLine(headerLine).map((header) => header.trim());
      const imported = lines.map((line) => {
        const values = parseCsvLine(line);
        const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
        const category = categories.find((item) => item.name === row.category || item.id === row.category_id);

        return {
          ...emptyProduct,
          sku: row.sku ?? "",
          internal_code: row.internal_code || row.codigo_interno || row["código_interno"] || null,
          name: row.name ?? row.nombre ?? "",
          brand: row.brand ?? row.marca ?? "",
          vehicle_brand: row.vehicle_brand || row.marca_carro || null,
          vehicle_model: row.vehicle_model || row.modelo_carro || null,
          vehicle_year_start: row.vehicle_year_start || row.anio_inicial ? numberValue(row.vehicle_year_start || row.anio_inicial) : null,
          vehicle_year_end: row.vehicle_year_end || row.anio_final ? numberValue(row.vehicle_year_end || row.anio_final) : null,
          category_id: category?.id ?? null,
          stock: numberValue(row.stock ?? "0"),
          min_stock: numberValue(row.min_stock ?? row.stock_minimo ?? row["stock_mínimo"] ?? "5"),
          cost_price: numberValue(row.cost_price ?? row.precio_costo ?? "0"),
          retail_price: numberValue(row.retail_price ?? row.precio_detalle ?? "0"),
          wholesale_price: numberValue(row.wholesale_price ?? row.precio_mayorista ?? "0"),
          wholesale_min_quantity: numberValue(row.wholesale_min_quantity ?? row.cantidad_minima_mayorista ?? row["cantidad_mínima_mayorista"] ?? "1"),
          status: (row.status as ProductStatus) || (row.estado as ProductStatus) || "active",
          active: row.active !== "false" && row.activo !== "false",
          images: row.image_url || row.url_imagen
            ? [{ ...emptyImage, public_url: row.image_url || row.url_imagen, angle: row.image_angle || row.angulo_imagen || row["ángulo_imagen"] || "principal" }]
            : [],
        };
      });

      startTransition(async () => {
        const result = await importProductsAction(imported);
        setMessage(result.message);
      });
    };
    reader.readAsText(file);
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-3">
        <Metric label="Productos activos" value={activeCount.toLocaleString("es-HN")} />
        <Metric label="Stock bajo" value={lowStockCount.toLocaleString("es-HN")} />
        <Metric label="Costo en inventario" value={formatCurrency(inventoryValue)} />
      </div>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <form action="/admin/productos" className="grid gap-3 lg:grid-cols-[1fr_180px_220px_auto_auto_auto]">
          <label className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2">
            <Search size={18} className="text-black/45" />
            <input
              name="q"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por SKU, código interno, producto o marca"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
          <select
            name="status"
            value={status}
            onChange={(event) => setStatus(event.target.value as ProductStatus | "all")}
            className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
          >
            <option value="all">Todos</option>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            name="category"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
          >
            <option value="all">Categorías</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <button className="rounded-md border border-black/10 bg-white px-4 py-2 text-sm font-medium">
            Filtrar
          </button>
          <Button onClick={() => setEditing(emptyProduct)} variant="dark">
            <Plus size={17} />
            Nuevo
          </Button>
          <Button onClick={exportCsv} variant="ghost">
            <Download size={17} />
            CSV
          </Button>
          <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-md bg-[#246a73] px-4 py-2 text-sm font-medium text-white">
            <Upload size={17} />
            Importar
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(event) => importCsv(event.target.files?.[0] ?? null)}
            />
          </label>
        </form>
        <p className="mt-3 text-sm text-black/55">
          Página {page}: mostrando {products.length.toLocaleString("es-HN")} de {total.toLocaleString("es-HN")} productos.
        </p>
        {message ? <p className="mt-3 text-sm text-black/60">{message}</p> : null}
      </section>

      <div className="flex justify-end gap-2">
        {page > 1 ? (
          <Link href={buildPageHref(page - 1)} className="rounded-md border border-black/10 bg-white px-4 py-2 text-sm font-medium">
            Anterior
          </Link>
        ) : null}
        {hasNextPage ? (
          <Link href={buildPageHref(page + 1)} className="rounded-md border border-black/10 bg-white px-4 py-2 text-sm font-medium">
            Siguiente
          </Link>
        ) : null}
      </div>

      <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="bg-[#f0ede2] text-xs uppercase text-black/55">
              <tr>
                <th className="px-4 py-3">Producto</th>
                <th className="px-4 py-3">Categoría</th>
                <th className="px-4 py-3">Stock</th>
                <th className="px-4 py-3">Costo</th>
                <th className="px-4 py-3">Precio al detalle</th>
                <th className="px-4 py-3">Precio mayorista</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {filteredProducts.map((product) => (
                <tr key={product.id}>
                  <td className="px-4 py-3">
                    <p className="font-semibold">{product.name}</p>
                    <p className="text-xs text-black/50">
                      {product.sku} {product.internal_code ? `/ ${product.internal_code}` : ""}
                    </p>
                  </td>
                  <td className="px-4 py-3">{product.category_name ?? "Sin categoría"}</td>
                  <td className="px-4 py-3">
                    <span className={product.stock <= product.min_stock ? "font-semibold text-[#bd4f30]" : ""}>
                      {product.stock}
                    </span>
                    <span className="text-black/45"> / mínimo {product.min_stock}</span>
                  </td>
                  <td className="px-4 py-3">{formatCurrency(product.cost_price)}</td>
                  <td className="px-4 py-3 font-semibold">{formatCurrency(product.retail_price)}</td>
                  <td className="px-4 py-3 font-semibold">{formatCurrency(product.wholesale_price)}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-md bg-[#e8f3f2] px-2 py-1 text-xs">{statusLabels[product.status]}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <IconButton label="Editar" onClick={() => setEditing(toFormProduct(product))}>
                        <Pencil size={16} />
                      </IconButton>
                      <IconButton label={product.active ? "Desactivar" : "Activar"} onClick={() => toggleActive(product)}>
                        {product.active ? <Archive size={16} /> : <CheckCircle2 size={16} />}
                      </IconButton>
                      <IconButton label="Eliminar" onClick={() => deleteProduct(product)}>
                        <Trash2 size={16} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editing ? (
        <ProductEditor
          categories={categories}
          product={editing}
          pending={isPending}
          onClose={() => setEditing(null)}
          onSubmit={submitProduct}
          onField={updateField}
          onImage={updateImage}
          onUploadImage={uploadImage}
          onAddImage={() => updateField("images", [...editing.images, { ...emptyImage, is_primary: false, sort_order: editing.images.length }])}
        />
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid size-9 place-items-center rounded-md border border-black/10 bg-white text-[#1c1d1b] transition-colors hover:bg-[#f7f7f2]"
    >
      {children}
    </button>
  );
}

function ProductEditor({
  categories,
  product,
  pending,
  onClose,
  onSubmit,
  onField,
  onImage,
  onUploadImage,
  onAddImage,
}: {
  categories: CategoryOption[];
  product: ProductFormInput;
  pending: boolean;
  onClose: () => void;
  onSubmit: () => void;
  onField: <K extends keyof ProductFormInput>(field: K, value: ProductFormInput[K]) => void;
  onImage: (index: number, patch: Partial<ProductImageInput>) => void;
  onUploadImage: (index: number, file: File | null) => void;
  onAddImage: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/45 p-4">
      <section className="mx-auto my-6 w-full max-w-5xl rounded-lg bg-white text-[#1c1d1b]">
        <div className="flex items-center justify-between border-b border-black/10 px-5 py-4">
          <div>
            <p className="text-sm text-black/50">{product.id ? "Editar producto" : "Crear producto"}</p>
            <h2 className="text-xl font-semibold">{product.name || "Nuevo producto"}</h2>
          </div>
          <button onClick={onClose} className="grid size-10 place-items-center rounded-md border border-black/10" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-5 p-5 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="SKU">
                <Input value={product.sku} onChange={(event) => onField("sku", event.target.value)} />
              </Field>
              <Field label="Código interno">
                <Input value={product.internal_code ?? ""} onChange={(event) => onField("internal_code", event.target.value)} />
              </Field>
              <Field label="Slug">
                <Input value={product.slug} onChange={(event) => onField("slug", event.target.value)} />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nombre">
                <Input value={product.name} onChange={(event) => onField("name", event.target.value)} />
              </Field>
              <Field label="Marca">
                <Input value={product.brand} onChange={(event) => onField("brand", event.target.value)} />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Marca del carro">
                <Input value={product.vehicle_brand ?? ""} onChange={(event) => onField("vehicle_brand", event.target.value || null)} />
              </Field>
              <Field label="Modelo del carro">
                <Input value={product.vehicle_model ?? ""} onChange={(event) => onField("vehicle_model", event.target.value || null)} />
              </Field>
              <Field label="Año inicial">
                <Input
                  type="number"
                  min={1900}
                  value={product.vehicle_year_start ?? ""}
                  onChange={(event) => onField("vehicle_year_start", event.target.value ? numberValue(event.target.value) : null)}
                />
              </Field>
              <Field label="Año final">
                <Input
                  type="number"
                  min={1900}
                  value={product.vehicle_year_end ?? ""}
                  onChange={(event) => onField("vehicle_year_end", event.target.value ? numberValue(event.target.value) : null)}
                />
              </Field>
            </div>

            <Field label="Descripción">
              <textarea
                value={product.description}
                onChange={(event) => onField("description", event.target.value)}
                className="min-h-28 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#246a73]"
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Categoría">
                <select
                  value={product.category_id ?? ""}
                  onChange={(event) => onField("category_id", event.target.value || null)}
                  className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
                >
                  <option value="">Sin categoría</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Estado">
                <select
                  value={product.status}
                  onChange={(event) => onField("status", event.target.value as ProductStatus)}
                  className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
                >
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={product.active}
                  onChange={(event) => onField("active", event.target.checked)}
                  className="size-4"
                />
                Visible en tienda
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Stock">
                <Input type="number" min={0} value={product.stock} onChange={(event) => onField("stock", numberValue(event.target.value))} />
              </Field>
              <Field label="Stock mínimo">
                <Input type="number" min={0} value={product.min_stock} onChange={(event) => onField("min_stock", numberValue(event.target.value))} />
              </Field>
              <Field label="Cantidad mínima mayorista">
                <Input
                  type="number"
                  min={1}
                  value={product.wholesale_min_quantity}
                  onChange={(event) => onField("wholesale_min_quantity", numberValue(event.target.value))}
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Precio de costo">
                <Input type="number" min={0} step="0.01" value={product.cost_price} onChange={(event) => onField("cost_price", numberValue(event.target.value))} />
              </Field>
              <Field label="Precio al detalle">
                <Input type="number" min={0} step="0.01" value={product.retail_price} onChange={(event) => onField("retail_price", numberValue(event.target.value))} />
              </Field>
              <Field label="Precio mayorista">
                <Input type="number" min={0} step="0.01" value={product.wholesale_price} onChange={(event) => onField("wholesale_price", numberValue(event.target.value))} />
              </Field>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Imágenes por ángulo</h3>
              <Button onClick={onAddImage} variant="ghost" className="px-3">
                <Plus size={16} />
              </Button>
            </div>
            {product.images.map((image, index) => (
              <div key={`${image.id ?? "new"}-${index}`} className="space-y-2 rounded-md border border-black/10 p-3">
                <Input
                  value={image.public_url}
                  onChange={(event) => onImage(index, { public_url: event.target.value })}
                  placeholder="URL de imagen"
                />
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-black/20 bg-[#f7f7f2] px-3 py-3 text-sm font-medium">
                  <Upload size={16} />
                  Subir a Cloudinary
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => onUploadImage(index, event.target.files?.[0] ?? null)}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <Input value={image.angle} onChange={(event) => onImage(index, { angle: event.target.value })} placeholder="principal, lateral..." />
                  <Input
                    type="number"
                    value={image.sort_order}
                    onChange={(event) => onImage(index, { sort_order: numberValue(event.target.value) })}
                    placeholder="Orden"
                  />
                </div>
                <Input value={image.alt_text ?? ""} onChange={(event) => onImage(index, { alt_text: event.target.value })} placeholder="Texto alternativo" />
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={image.is_primary}
                    onChange={(event) => onImage(index, { is_primary: event.target.checked })}
                    className="size-4"
                  />
                  Imagen principal
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-black/10 px-5 py-4">
          <Button onClick={onClose} variant="ghost">
            Cancelar
          </Button>
          <Button onClick={onSubmit} disabled={pending} variant="dark">
            <Save size={17} />
            {pending ? "Guardando..." : "Guardar producto"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase text-black/50">{label}</span>
      {children}
    </label>
  );
}
