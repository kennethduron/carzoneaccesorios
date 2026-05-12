"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  Archive,
  AlertCircle,
  CheckCircle2,
  Download,
  FileImage,
  HelpCircle,
  ImageOff,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
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
import { useToast } from "@/contexts/toast-context";
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

type MessageState = {
  text: string;
  type: "neutral" | "success" | "error";
};

type ImageUploadState = {
  status: "idle" | "ready" | "uploading" | "success" | "error";
  message: string;
  fileName?: string;
  previewUrl?: string;
  file?: File;
};

const productDraftStorageKey = "car-zone-product-editor-draft";
const maxProductImages = 5;
const allowedProductImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
const productImageAccept = "image/jpeg,image/png,image/webp,image/avif";
const imageAngleOptions = ["principal", "frontal", "lateral", "trasera", "detalle", "otro"];

const statusLabels: Record<ProductStatus, string> = {
  active: "Activo",
  inactive: "Inactivo",
  draft: "Borrador",
  archived: "Archivado",
};

const emptyImage: ProductImageInput = {
  public_url: "",
  storage_path: "",
  public_id: "",
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

function slugifyProductUrl(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const productCsvHeaders = [
  "sku",
  "codigo_proveedor",
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

const requiredImportHeaders = ["sku", "nombre", "marca", "stock", "precio_detalle", "precio_mayorista"];

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

function persistProductDraft(product: ProductFormInput | null) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (product) {
      window.sessionStorage.setItem(productDraftStorageKey, JSON.stringify(product));
    } else {
      window.sessionStorage.removeItem(productDraftStorageKey);
    }
  } catch {
    // Session storage is best-effort; the form state in React remains the source of truth.
  }
}

export function ProductManager({ products, categories, total, page, pageSize, filters }: ProductManagerProps) {
  const [query, setQuery] = useState(filters.query);
  const [status, setStatus] = useState<ProductStatus | "all">(filters.status as ProductStatus | "all");
  const [categoryId, setCategoryId] = useState(filters.categoryId);
  const [editing, setEditing] = useState<ProductFormInput | null>(null);
  const [message, setMessage] = useState<MessageState | null>(null);
  const [imageUploads, setImageUploads] = useState<Record<number, ImageUploadState>>({});
  const [isPending, startTransition] = useTransition();
  const toast = useToast();
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

  useEffect(() => {
    persistProductDraft(editing);
  }, [editing]);

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

  function showMessage(text: string, type: MessageState["type"] = "neutral") {
    setMessage({ text, type });
    if (type === "success") {
      toast.success(text);
    } else if (type === "error") {
      toast.error(text);
    } else {
      toast.info(text);
    }
  }

  function openNewProduct() {
    let draft: ProductFormInput | null = null;

    if (typeof window !== "undefined") {
      try {
        const storedDraft = window.sessionStorage.getItem(productDraftStorageKey);
        draft = storedDraft ? (JSON.parse(storedDraft) as ProductFormInput) : null;
      } catch {
        draft = null;
      }
    }

    setEditing(draft ?? { ...emptyProduct, images: [{ ...emptyImage }] });
    setImageUploads({});
    showMessage(
      draft
        ? "Se recupero un borrador local. Revisa los datos antes de guardar."
        : "Completa los datos del producto. Si algo falla, el formulario se mantiene abierto.",
    );
  }

  function openExistingProduct(product: ProductAdminRow) {
    const nextProduct = toFormProduct(product);
    setEditing(nextProduct);
    setImageUploads({});
    persistProductDraft(nextProduct);
    setMessage(null);
  }

  function closeEditor() {
    setEditing(null);
    setImageUploads((current) => {
      Object.values(current).forEach((state) => {
        if (state.previewUrl) {
          URL.revokeObjectURL(state.previewUrl);
        }
      });
      return {};
    });
  }

  function updateField<K extends keyof ProductFormInput>(field: K, value: ProductFormInput[K]) {
    setEditing((current) => {
      if (!current) {
        return current;
      }

      if (field === "name") {
        const nextName = String(value ?? "");
        const currentGeneratedSlug = slugifyProductUrl(current.name);
        const shouldSyncSlug = !current.slug || current.slug === currentGeneratedSlug;

        return {
          ...current,
          name: nextName,
          slug: shouldSyncSlug ? slugifyProductUrl(nextName) : current.slug,
        };
      }

      return { ...current, [field]: value };
    });
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

    if (!allowedProductImageTypes.has(file.type)) {
      setImageUploads((current) => ({
        ...current,
        [index]: {
          status: "error",
          message: "Solo se permiten imagenes JPG, PNG, WebP o AVIF.",
          fileName: file.name,
          file,
        },
      }));
      showMessage("Solo se permiten imagenes JPG, PNG, WebP o AVIF para productos.", "error");
      return;
    }

    if (file.size > 8 * 1024 * 1024) {
      setImageUploads((current) => ({
        ...current,
        [index]: {
          status: "error",
          message: "La imagen no puede superar 8 MB.",
          fileName: file.name,
          file,
        },
      }));
      showMessage("La imagen no puede superar 8 MB.", "error");
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setImageUploads((current) => {
      const previousPreview = current[index]?.previewUrl;
      if (previousPreview) {
        URL.revokeObjectURL(previousPreview);
      }

      return {
        ...current,
        [index]: {
          status: "uploading",
          message: "Subiendo imagen a Cloudinary...",
          fileName: file.name,
          previewUrl,
          file,
        },
      };
    });
    showMessage("Subiendo imagen. El formulario permanecera abierto aunque falle.", "neutral");

    startTransition(async () => {
      const formData = new FormData();
      formData.set("file", file);
      formData.set("productSlug", editing.slug || editing.sku || editing.name || "producto");
      formData.set("angle", editing.images[index]?.angle || "principal");

      const result = await uploadProductImageAction(formData);
      showMessage(result.message, result.ok ? "success" : "error");

      if (result.ok && result.publicUrl) {
        updateImage(index, {
          public_url: result.publicUrl,
          storage_path: result.storagePath,
          public_id: result.publicId ?? result.storagePath,
        });
        setImageUploads((current) => ({
          ...current,
          [index]: {
            ...current[index],
            status: "success",
            message: "Imagen subida. Revisa la vista previa y guarda el producto.",
          },
        }));
        return;
      }

      setImageUploads((current) => ({
        ...current,
        [index]: {
          ...current[index],
          status: "error",
          message: result.message,
        },
      }));
    });
  }

  function retryImageUpload(index: number) {
    const file = imageUploads[index]?.file;
    if (file) {
      uploadImage(index, file);
    }
  }

  function validateProductBeforeSave(product: ProductFormInput) {
    if (!product.sku.trim()) {
      return "El SKU es requerido para inventario y busquedas internas.";
    }

    if (!product.name.trim()) {
      return "Escribe el nombre del producto.";
    }

    if (!product.brand.trim()) {
      return "Escribe la marca del producto.";
    }

    if (product.stock < 0) {
      return "El stock no puede ser negativo.";
    }

    if (product.min_stock < 0) {
      return "El stock minimo no puede ser negativo.";
    }

    if (product.cost_price < 0) {
      return "El precio de costo no puede ser negativo.";
    }

    if (product.retail_price <= 0) {
      return "El precio al detalle debe ser mayor a 0.";
    }

    if (product.wholesale_price < 0) {
      return "El precio mayorista no puede ser negativo.";
    }

    if (product.wholesale_price > product.retail_price) {
      return "El precio mayorista no puede ser mayor que el precio al detalle.";
    }

    if (product.wholesale_min_quantity < 1) {
      return "La cantidad minima mayorista debe ser al menos 1.";
    }

    return null;
  }

  function addProductImageSlot() {
    if (!editing) {
      return;
    }

    if (editing.images.length >= maxProductImages) {
      showMessage(`Puedes subir hasta ${maxProductImages} imagenes por producto.`, "error");
      return;
    }

    updateField("images", [...editing.images, { ...emptyImage, is_primary: false, sort_order: editing.images.length }]);
  }

  function submitProduct() {
    if (!editing) {
      return;
    }

    const validationError = validateProductBeforeSave(editing);
    if (validationError) {
      showMessage(validationError, "error");
      return;
    }

    startTransition(async () => {
      const result = await saveProductAction(editing);
      showMessage(result.message, result.ok ? "success" : "error");
      if (result.ok) {
        persistProductDraft(null);
        setEditing(null);
        setImageUploads({});
      }
    });
  }

  function toggleActive(product: ProductAdminRow) {
    startTransition(async () => {
      const result = await setProductActiveAction(product.id, !product.active);
      showMessage(result.message, result.ok ? "success" : "error");
    });
  }

  async function deleteProduct(product: ProductAdminRow) {
    const confirmed = await toast.confirm({
      title: "Confirmar eliminacion",
      message: `Eliminar ${product.name}? Esta accion no se puede deshacer.`,
      confirmLabel: "Eliminar",
      cancelLabel: "Cancelar",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    startTransition(async () => {
      const result = await deleteProductAction(product.id);
      showMessage(result.message, result.ok ? "success" : "error");
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
    toast.success("CSV descargado correctamente.");
  }

  function downloadImportTemplate() {
    const sampleRow = [
      "TEST-SKU-001",
      "OEM-TEST-001",
      "Producto de ejemplo",
      "Marca ejemplo",
      "Toyota",
      "Hilux",
      "2018",
      "2026",
      categories[0]?.name ?? "",
      "10",
      "2",
      "50.00",
      "100.00",
      "80.00",
      "1",
      "active",
      "true",
      "https://res.cloudinary.com/tu-cloud/image/upload/ejemplo.png",
      "principal",
    ];
    const csv = [productCsvHeaders.join(","), sampleRow.map(csvValue).join(",")].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "plantilla-productos-car-zone.csv";
    link.click();
    URL.revokeObjectURL(url);
    toast.success("Plantilla CSV descargada correctamente.");
  }

  function importCsv(file: File | null) {
    if (!file) {
      return;
    }

    if (!file.name.toLowerCase().endsWith(".csv")) {
      showMessage("Selecciona un archivo CSV usando la plantilla oficial.", "error");
      return;
    }

    showMessage("Leyendo archivo CSV...", "neutral");

    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? "");
      const [headerLine, ...lines] = content.split(/\r?\n/).filter(Boolean);

      if (!headerLine || lines.length === 0) {
        showMessage("El CSV esta vacio o no tiene filas de productos.", "error");
        return;
      }

      const headers = parseCsvLine(headerLine).map((header) => header.trim());
      const missingHeaders = requiredImportHeaders.filter((header) => !headers.includes(header));
      if (missingHeaders.length > 0) {
        showMessage(`El CSV no tiene columnas requeridas: ${missingHeaders.join(", ")}. Descarga la plantilla oficial.`, "error");
        return;
      }

      const imported = lines.map((line) => {
        const values = parseCsvLine(line);
        const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
        const category = categories.find((item) => item.name === row.category || item.id === row.category_id);

        return {
          ...emptyProduct,
          sku: row.sku ?? "",
          internal_code: row.internal_code || row.codigo_proveedor || row.codigo_oem || row.codigo_interno || row["código_interno"] || null,
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
        showMessage(result.message, result.ok ? "success" : "error");
      });
    };
    reader.onerror = () => {
      showMessage("No se pudo leer el archivo CSV. Intenta de nuevo o descarga la plantilla oficial.", "error");
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
        <form action="/admin/productos" className="grid gap-3 lg:grid-cols-[1fr_180px_220px_auto_auto_auto_auto]">
          <label className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2">
            <Search size={18} className="text-black/45" />
            <input
              name="q"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por SKU, codigo proveedor/OEM, producto o marca"
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
          <Button onClick={openNewProduct} variant="dark">
            <Plus size={17} />
            Nuevo
          </Button>
          <Button onClick={exportCsv} variant="ghost">
            <Download size={17} />
            CSV
          </Button>
          <Button onClick={downloadImportTemplate} variant="ghost" title="Descargar plantilla CSV para importar productos">
            <HelpCircle size={17} />
            Plantilla
          </Button>
          <label
            className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-md bg-[#246a73] px-4 py-2 text-sm font-medium text-white"
            title="Importa productos desde CSV usando la plantilla oficial."
          >
            <Upload size={17} />
            Importar CSV
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
        <p className="mt-2 text-sm text-black/55">
          Importa productos desde CSV usando la plantilla oficial. El sistema valida columnas antes de guardar.
        </p>
        {message ? (
          <p
            className={`mt-3 rounded-md px-3 py-2 text-sm ${
              message.type === "success"
                ? "bg-[#e8f3f2] text-[#1e5960]"
                : message.type === "error"
                  ? "bg-[#fff0ea] text-[#9b341b]"
                  : "bg-[#f7f7f2] text-black/60"
            }`}
            aria-live="polite"
          >
            {message.text}
          </p>
        ) : null}
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
                      <IconButton label="Editar" onClick={() => openExistingProduct(product)}>
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
          imageUploads={imageUploads}
          onClose={closeEditor}
          onSubmit={submitProduct}
          onField={updateField}
          onImage={updateImage}
          onUploadImage={uploadImage}
          onRetryImage={retryImageUpload}
          onAddImage={addProductImageSlot}
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
  imageUploads,
  onClose,
  onSubmit,
  onField,
  onImage,
  onUploadImage,
  onRetryImage,
  onAddImage,
}: {
  categories: CategoryOption[];
  product: ProductFormInput;
  pending: boolean;
  imageUploads: Record<number, ImageUploadState>;
  onClose: () => void;
  onSubmit: () => void;
  onField: <K extends keyof ProductFormInput>(field: K, value: ProductFormInput[K]) => void;
  onImage: (index: number, patch: Partial<ProductImageInput>) => void;
  onUploadImage: (index: number, file: File | null) => void;
  onRetryImage: (index: number) => void;
  onAddImage: () => void;
}) {
  const [slugEditable, setSlugEditable] = useState(false);
  const vehicleHasData = Boolean(
    product.vehicle_brand || product.vehicle_model || product.vehicle_year_start || product.vehicle_year_end,
  );
  const [vehicleUniversal, setVehicleUniversal] = useState(!vehicleHasData);
  const generatedSlug = slugifyProductUrl(product.name);
  const displayedSlug = product.slug || generatedSlug;

  function toggleUniversalVehicle(checked: boolean) {
    setVehicleUniversal(checked);
    if (checked) {
      onField("vehicle_brand", null);
      onField("vehicle_model", null);
      onField("vehicle_year_start", null);
      onField("vehicle_year_end", null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/45 p-4">
      <section className="mx-auto my-6 w-full max-w-6xl rounded-lg bg-white text-[#1c1d1b]">
        <div className="flex items-center justify-between border-b border-black/10 px-5 py-4">
          <div>
            <p className="text-sm text-black/50">{product.id ? "Editar producto" : "Crear producto"}</p>
            <h2 className="text-xl font-semibold">{product.name || "Nuevo producto"}</h2>
          </div>
          <button onClick={onClose} className="grid size-10 place-items-center rounded-md border border-black/10" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <FormSection title="Informacion basica" description="Datos principales que el cliente y el equipo veran al buscar el producto.">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Nombre del producto" help="Nombre comercial que vera el cliente en la tienda.">
                  <Input
                    value={product.name}
                    onChange={(event) => onField("name", event.target.value)}
                    placeholder="Ej. Radio Android Toyota Corolla 2010"
                  />
                </Field>
                <Field
                  label="Marca del producto"
                  help="Marca comercial del producto o fabricante del accesorio. Ej. Pioneer, JBL, Osram, Toyota o Generico."
                  tooltip="Marca del producto no es lo mismo que marca del vehiculo."
                >
                  <Input value={product.brand} onChange={(event) => onField("brand", event.target.value)} placeholder="Ej. Pioneer" />
                </Field>
              </div>

              <Field label="Descripcion" help="Resume el uso, compatibilidad o contenido del producto.">
                <textarea
                  value={product.description}
                  onChange={(event) => onField("description", event.target.value)}
                  placeholder="Describe el producto de forma clara para ventas y clientes."
                  className="min-h-28 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#246a73]"
                />
              </Field>

              <div className="grid gap-3 sm:grid-cols-[1fr_180px_180px]">
                <Field label="Categoria">
                  <select
                    value={product.category_id ?? ""}
                    onChange={(event) => onField("category_id", event.target.value || null)}
                    className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
                  >
                    <option value="">Sin categoria</option>
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
                <div className="flex items-end">
                  <label className="flex min-h-10 items-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={product.active}
                      onChange={(event) => onField("active", event.target.checked)}
                      className="size-4"
                    />
                    Visible en tienda
                  </label>
                </div>
              </div>
            </FormSection>

            <FormSection title="Identificacion interna" description="Codigos para inventario, busquedas internas y referencias de proveedor.">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="SKU"
                  help="Codigo unico para inventario y busquedas internas."
                  tooltip="Usa el codigo principal que bodega, ventas e inventario reconocen."
                >
                  <Input
                    value={product.sku}
                    onChange={(event) => onField("sku", event.target.value)}
                    placeholder="Ej. CZ-LUZ-001"
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label="Codigo proveedor/OEM"
                  help="Opcional. Codigo del proveedor, fabricante u OEM."
                  tooltip="Util cuando el empaque, proveedor o fabricante maneja otro codigo distinto al SKU."
                >
                  <Input
                    value={product.internal_code ?? ""}
                    onChange={(event) => onField("internal_code", event.target.value || null)}
                    placeholder="Ej. OEM-12345 o PROV-7788"
                    autoComplete="off"
                  />
                </Field>
              </div>
            </FormSection>

            <FormSection title="Precios e inventario" description="Controla stock, costo y precios para venta retail y mayorista.">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Stock" help="No puede ser negativo.">
                  <Input type="number" min={0} value={product.stock} onChange={(event) => onField("stock", numberValue(event.target.value))} />
                </Field>
                <Field label="Stock minimo" help="Activa alertas cuando el producto llega a este nivel.">
                  <Input type="number" min={0} value={product.min_stock} onChange={(event) => onField("min_stock", numberValue(event.target.value))} />
                </Field>
                <Field label="Cantidad minima mayorista" help="Cantidad minima requerida para aplicar precio mayorista.">
                  <Input
                    type="number"
                    min={1}
                    value={product.wholesale_min_quantity}
                    onChange={(event) => onField("wholesale_min_quantity", numberValue(event.target.value))}
                  />
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Precio de costo" help="Costo interno. No puede ser negativo.">
                  <Input type="number" min={0} step="0.01" value={product.cost_price} onChange={(event) => onField("cost_price", numberValue(event.target.value))} />
                </Field>
                <Field label="Precio al detalle" help="Precio normal para clientes sin cuenta mayorista.">
                  <Input type="number" min={0.01} step="0.01" value={product.retail_price} onChange={(event) => onField("retail_price", numberValue(event.target.value))} />
                </Field>
                <Field label="Precio mayorista" help="Precio especial para clientes mayoristas autorizados.">
                  <Input type="number" min={0} step="0.01" value={product.wholesale_price} onChange={(event) => onField("wholesale_price", numberValue(event.target.value))} />
                </Field>
              </div>
              {product.wholesale_price > product.retail_price ? (
                <p className="rounded-md bg-[#fff0ea] px-3 py-2 text-sm font-medium text-[#9b341b]">
                  El precio mayorista no puede ser mayor que el precio al detalle.
                </p>
              ) : null}
            </FormSection>

            <FormSection title="Compatibilidad del vehiculo" description="Indica para que vehiculo es compatible este producto.">
              <div className="flex flex-wrap items-start gap-3">
                <label className="inline-flex max-w-md items-start gap-3 rounded-md border border-black/10 bg-[#f7f7f2] px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={vehicleUniversal}
                    onChange={(event) => toggleUniversalVehicle(event.target.checked)}
                    className="mt-1 size-4 shrink-0 accent-[#246a73]"
                  />
                  <span>
                    <span className="block font-medium">Producto universal</span>
                    <span className="block text-xs text-black/55">
                      Compatible con multiples vehiculos.
                    </span>
                  </span>
                </label>
              </div>

              {!vehicleUniversal ? (
                <>
                  <p className="rounded-md bg-[#eef5f4] px-3 py-2 text-xs text-[#1e5960]">
                    Marca del producto no es lo mismo que marca del vehiculo. Ejemplo: marca del producto Pioneer,
                    marca del vehiculo Toyota, modelo Corolla, anos 2010 - 2014.
                  </p>

                  <div className="grid gap-3 sm:grid-cols-4">
                    <Field label="Marca del vehiculo">
                      <Input value={product.vehicle_brand ?? ""} onChange={(event) => onField("vehicle_brand", event.target.value || null)} placeholder="Ej. Toyota" />
                    </Field>
                    <Field label="Modelo del vehiculo">
                      <Input value={product.vehicle_model ?? ""} onChange={(event) => onField("vehicle_model", event.target.value || null)} placeholder="Ej. Corolla" />
                    </Field>
                    <Field label="Ano inicial">
                      <Input
                        type="number"
                        min={1900}
                        value={product.vehicle_year_start ?? ""}
                        onChange={(event) => onField("vehicle_year_start", event.target.value ? numberValue(event.target.value) : null)}
                        placeholder="2010"
                      />
                    </Field>
                    <Field label="Ano final">
                      <Input
                        type="number"
                        min={1900}
                        value={product.vehicle_year_end ?? ""}
                        onChange={(event) => onField("vehicle_year_end", event.target.value ? numberValue(event.target.value) : null)}
                        placeholder="2014"
                      />
                    </Field>
                  </div>
                </>
              ) : null}
            </FormSection>

            <FormSection title="Opciones avanzadas" description="Normalmente no necesitas tocar estos campos.">
              <Field
                label="URL amigable"
                help="URL amigable generada automaticamente desde el nombre del producto."
                tooltip="Solo cambia esto si necesitas una URL especifica."
                action={
                  <button
                    type="button"
                    onClick={() => setSlugEditable((current) => !current)}
                    className="text-xs font-semibold text-[#246a73]"
                  >
                    {slugEditable ? "Bloquear edicion" : "Editar slug"}
                  </button>
                }
              >
                <Input
                  value={displayedSlug}
                  onChange={(event) => onField("slug", slugifyProductUrl(event.target.value))}
                  placeholder="Se genera al escribir el nombre"
                  disabled={!slugEditable}
                  className={!slugEditable ? "bg-[#f7f7f2] text-black/55" : ""}
                  autoComplete="off"
                />
                {product.name ? (
                  <p className="mt-1 text-xs text-black/45">
                    Ejemplo: {generatedSlug || "nombre-del-producto"}
                  </p>
                ) : null}
              </Field>
            </FormSection>

            <div className="hidden">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="SKU"
                help="Código único para inventario y búsquedas internas."
                tooltip="Usa el código principal que bodega, ventas e inventario reconocen."
              >
                <Input
                  value={product.sku}
                  onChange={(event) => onField("sku", event.target.value)}
                  placeholder="Ej. CZ-LUZ-001"
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Código proveedor/OEM"
                help="Opcional. Código del proveedor o fabricante."
                tooltip="Útil cuando el empaque, proveedor o fabricante maneja otro código distinto al SKU."
              >
                <Input
                  value={product.internal_code ?? ""}
                  onChange={(event) => onField("internal_code", event.target.value || null)}
                  placeholder="Ej. OEM-12345 o PROV-7788"
                  autoComplete="off"
                />
              </Field>
            </div>

            <Field
              label="URL amigable"
              help="URL amigable generada automáticamente desde el nombre del producto."
              tooltip="Normalmente no necesitas editar esto. Solo cámbialo si quieres una URL específica."
              action={
                <button
                  type="button"
                  onClick={() => setSlugEditable((current) => !current)}
                  className="text-xs font-semibold text-[#246a73]"
                >
                  {slugEditable ? "Bloquear edición" : "Editar slug"}
                </button>
              }
            >
              <Input
                value={displayedSlug}
                onChange={(event) => onField("slug", slugifyProductUrl(event.target.value))}
                placeholder="Se genera al escribir el nombre"
                disabled={!slugEditable}
                className={!slugEditable ? "bg-[#f7f7f2] text-black/55" : ""}
                autoComplete="off"
              />
              {product.name ? (
                <p className="mt-1 text-xs text-black/45">
                  Ejemplo: {generatedSlug || "nombre-del-producto"}
                </p>
              ) : null}
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nombre" help="Nombre comercial que verá el cliente en la tienda.">
                <Input
                  value={product.name}
                  onChange={(event) => onField("name", event.target.value)}
                  placeholder="Ej. Radio Android Toyota Corolla 2010"
                />
              </Field>
              <Field label="Marca" help="Marca del producto o fabricante visible para búsqueda.">
                <Input value={product.brand} onChange={(event) => onField("brand", event.target.value)} placeholder="Ej. Pioneer" />
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
          </div>

          <FormSection
            title="Imagenes del producto"
            description="Sube la imagen principal y, si hace falta, imagenes adicionales para la galeria."
            className="self-start"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold">Imagen principal</h3>
                <p className="text-xs text-black/50">JPG, PNG, WebP o AVIF hasta 8 MB.</p>
              </div>
              <Button onClick={onAddImage} disabled={product.images.length >= maxProductImages} variant="ghost" className="px-3">
                <Plus size={16} />
                Agregar otra imagen
              </Button>
            </div>
            <p className="hidden text-xs text-black/50">
              Sube de 3 a 5 imagenes JPG, PNG, WebP o AVIF. La tienda servira versiones optimizadas desde Cloudinary.
            </p>
            {product.images.map((image, index) => {
              const uploadState = imageUploads[index];
              const previewUrl = uploadState?.previewUrl || image.public_url;
              const isUploading = uploadState?.status === "uploading";
              const angleOptions = imageAngleOptions.includes(image.angle) ? imageAngleOptions : [...imageAngleOptions, image.angle];
              const imageTitle = index === 0 ? "Imagen principal" : `Imagen adicional ${index}`;
              const uploadLabel = index === 0 ? "Subir imagen principal" : "Subir imagen adicional";

              return (
                <div key={`${image.id ?? "new"}-${index}`} className="space-y-2 rounded-md border border-black/10 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">{imageTitle}</p>
                    {index === 0 ? <span className="rounded-md bg-[#e8f3f2] px-2 py-1 text-xs text-[#1e5960]">Principal</span> : null}
                  </div>
                  <div className="grid aspect-[4/3] place-items-center overflow-hidden rounded-md border border-black/10 bg-[#f7f7f2]">
                    {previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={previewUrl} alt={image.alt_text || "Vista previa del producto"} className="h-full w-full object-cover" />
                    ) : (
                      <div className="grid place-items-center gap-2 text-center text-sm text-black/45">
                        <ImageOff size={24} />
                        Sin imagen
                      </div>
                    )}
                  </div>
                  <Input
                    value={image.public_url}
                    onChange={(event) => onImage(index, { public_url: event.target.value })}
                    placeholder="URL de imagen"
                    className="hidden"
                  />
                  <label
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      onUploadImage(index, event.dataTransfer.files?.[0] ?? null);
                    }}
                    className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-black/20 bg-[#f7f7f2] px-3 py-4 text-center text-sm font-medium"
                  >
                    {isUploading ? <Loader2 size={18} className="animate-spin" /> : <FileImage size={18} />}
                    <span>{isUploading ? "Subiendo imagen..." : uploadLabel}</span>
                    <span className="text-xs font-normal text-black/50">Tambien puedes arrastrar la imagen aqui.</span>
                    <span className="text-xs font-normal text-black/50">JPG, PNG, WebP o AVIF hasta 8 MB</span>
                    <input
                      type="file"
                      accept={productImageAccept}
                      className="hidden"
                      onChange={(event) => onUploadImage(index, event.target.files?.[0] ?? null)}
                    />
                  </label>
                  {uploadState?.message ? (
                    <div
                      className={`rounded-md px-3 py-2 text-xs ${
                        uploadState.status === "error"
                          ? "bg-[#fff0ea] text-[#9b341b]"
                          : uploadState.status === "success"
                            ? "bg-[#e8f3f2] text-[#1e5960]"
                            : "bg-white text-black/60"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {uploadState.status === "error" ? <AlertCircle size={15} className="mt-0.5 shrink-0" /> : null}
                        <span className="min-w-0 flex-1">
                          {uploadState.fileName ? `${uploadState.fileName}: ` : ""}
                          {uploadState.message}
                        </span>
                        {uploadState.status === "error" && uploadState.file ? (
                          <button
                            type="button"
                            onClick={() => onRetryImage(index)}
                            className="inline-flex shrink-0 items-center gap-1 font-semibold"
                          >
                            <RefreshCw size={13} />
                            Reintentar
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Tipo/angulo" help="Opcional. Ayuda a ordenar la galeria.">
                      <select
                        value={image.angle}
                        onChange={(event) => onImage(index, { angle: event.target.value })}
                        className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
                      >
                        {angleOptions.map((angle) => (
                          <option key={angle} value={angle}>
                            {angle}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Texto alternativo" help="Opcional. Describe la imagen para accesibilidad.">
                      <Input value={image.alt_text ?? ""} onChange={(event) => onImage(index, { alt_text: event.target.value })} placeholder="Ej. Vista frontal" />
                    </Field>
                  </div>
                  {index !== 0 ? (
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={image.is_primary}
                        onChange={(event) => onImage(index, { is_primary: event.target.checked })}
                        className="size-4"
                      />
                      Usar como imagen principal
                    </label>
                  ) : null}
                </div>
              );
            })}
          </FormSection>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-black/10 px-5 py-4">
          <Button onClick={onClose} variant="ghost">
            Cancelar
          </Button>
          <Button onClick={onSubmit} disabled={pending} variant="dark">
            <Save size={17} />
            {pending ? "Guardando producto..." : "Guardar producto"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function FormSection({
  title,
  description,
  className = "",
  children,
}: {
  title: string;
  description?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`space-y-3 rounded-lg border border-black/10 bg-white p-4 ${className}`}>
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        {description ? <p className="mt-1 text-sm text-black/55">{description}</p> : null}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  help,
  tooltip,
  action,
  children,
}: {
  label: string;
  help?: string;
  tooltip?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="block">
      <span className="mb-1 flex items-center justify-between gap-2 text-xs font-medium uppercase text-black/50">
        <span className="inline-flex items-center gap-1">
          {label}
          {tooltip ? (
            <span title={tooltip} aria-label={tooltip}>
              <HelpCircle size={13} className="text-black/35" aria-hidden="true" />
            </span>
          ) : null}
        </span>
        {action}
      </span>
      {children}
      {help ? <span className="mt-1 block text-xs normal-case text-black/45">{help}</span> : null}
    </div>
  );
}
