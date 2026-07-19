"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  Archive,
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileImage,
  HelpCircle,
  ImageOff,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  deleteUploadedProductImageAction,
  deleteProductAction,
  getProductImportSkuStatusAction,
  importProductsAction,
  saveProductAction,
  setProductActiveAction,
  uploadProductImageAction,
} from "@/app/admin/productos/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { normalizeImportedProductCategoryName, officialProductCategories } from "@/lib/product-categories";
import { formatCurrency } from "@/utils/pricing";
import { productShortDescriptionMaxLength } from "@/utils/product-content";
import {
  allowedProductImportImageExtensions,
  createProductImportImageCandidate,
  createProductImportImageIndex,
  matchProductImportImage,
  type ProductImportImageCandidate,
  type ProductImportImageIndex,
} from "@/utils/product-import-image-matching";
import {
  formatMegapixels,
  isAllowedProductImageMimeType,
  productImageAccept,
  productImageHelpText,
  productImageInvalidFormatMessage,
  productImageMaxBytes,
  productImageMaxDisplayDimension,
  productImageMaxPixels,
  productImageTooLargeMessage,
  productImageTooManyPixelsMessage,
} from "@/utils/product-image-rules";
import { normalizeVehicleBrand, normalizeVehicleModel } from "@/utils/vehicle-compatibility";
import type { ProductCapabilities } from "@/lib/auth/product-access";
import type { CategoryOption, ProductAdminRow, ProductFormInput, ProductImageInput, ProductStatus } from "@/types/products";

type ProductManagerProps = {
  products: ProductAdminRow[];
  categories: CategoryOption[];
  vehicleBrands: string[];
  vehicleModels: string[];
  total: number;
  page: number;
  pageSize: number;
  capabilities: ProductCapabilities;
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

type ProductImportMode = "create_and_update" | "create_only" | "update_only";

type ProductImportPreviewRow = {
  rowNumber: number;
  product: ProductFormInput;
  imageName: string;
  matchedImageName: string | null;
  matchedImagePath: string | null;
  imageMatchMethod: string | null;
  imageFile?: File;
  exists: boolean;
  duplicateSku: boolean;
  action: "create" | "update" | "skip";
  errors: string[];
  warnings: string[];
};

type ProductImportPreview = {
  rows: ProductImportPreviewRow[];
  zipWarnings: string[];
  criticalErrors: string[];
};

type EditableProductNumericField =
  | "stock"
  | "min_stock"
  | "wholesale_min_quantity"
  | "cost_price"
  | "retail_price"
  | "wholesale_price"
  | "vehicle_year_start"
  | "vehicle_year_end";

type EditableProductInput = Omit<ProductFormInput, EditableProductNumericField> & {
  stock: number | string;
  min_stock: number | string;
  wholesale_min_quantity: number | string;
  cost_price: number | string;
  retail_price: number | string;
  wholesale_price: number | string;
  vehicle_year_start: number | string | null;
  vehicle_year_end: number | string | null;
};

const productDraftStorageKey = "car-zone-product-editor-draft";
const maxProductImages = 5;
const imageAngleOptions = ["principal", "frontal", "lateral", "trasera", "detalle", "otro"];
const integerInputPattern = /^\d*$/;
const decimalInputPattern = /^$|^\d+(?:\.\d{0,2})?$/;

const productImportModeCopy: Record<ProductImportMode, { label: string; description: string; confirmation: string }> = {
  create_and_update: {
    label: "Crear y actualizar (Recomendado)",
    description: "Si el SKU ya existe, se actualizará. Si no existe, se creará como producto nuevo.",
    confirmation: "Esta acción puede crear productos nuevos y actualizar productos existentes.",
  },
  create_only: {
    label: "Crear solo productos nuevos",
    description: "Solo se crearán productos que no existan. Los SKU existentes no se modificarán.",
    confirmation: "Esta acción creará productos nuevos y omitirá los SKU que ya existen.",
  },
  update_only: {
    label: "Actualizar productos existentes",
    description: "Solo se actualizarán productos que ya existen. Los SKU nuevos no se crearán.",
    confirmation: "Esta acción actualizará productos existentes y omitirá los SKU nuevos.",
  },
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
  public_id: "",
  angle: "principal",
  alt_text: "",
  sort_order: 0,
  is_primary: true,
};

const emptyProduct: EditableProductInput = {
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
  short_description: null,
  description: "",
  features: null,
  specifications: null,
  compatibility_notes: null,
  stock: 0,
  min_stock: 5,
  cost_price: 0,
  retail_price: 0,
  wholesale_price: 0,
  wholesale_min_quantity: 1,
  is_new: false,
  status: "active",
  active: true,
  images: [emptyImage],
};

function toFormProduct(product: ProductAdminRow): EditableProductInput {
  return {
    id: product.id,
    category_id: product.category_id,
    sku: product.sku,
    internal_code: product.internal_code,
    slug: product.slug,
    name: product.name,
    brand: product.brand,
    vehicle_brand: normalizeVehicleBrand(product.vehicle_brand),
    vehicle_model: normalizeVehicleModel(product.vehicle_model),
    vehicle_year_start: product.vehicle_year_start,
    vehicle_year_end: product.vehicle_year_end,
    short_description: product.short_description,
    description: product.description,
    features: product.features,
    specifications: product.specifications,
    compatibility_notes: product.compatibility_notes,
    stock: product.stock,
    min_stock: product.min_stock,
    cost_price: product.cost_price,
    retail_price: product.retail_price,
    wholesale_price: product.wholesale_price,
    wholesale_min_quantity: product.wholesale_min_quantity,
    is_new: product.is_new,
    status: product.status,
    active: product.active,
    images: product.images.length > 0 ? product.images : [emptyImage],
  };
}

function readImageDimensions(file: File) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(dimensions);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo leer la imagen."));
    };
    image.src = url;
  });
}

async function optimizeImageInBrowser(file: File, dimensions: { width: number; height: number }) {
  const scale = Math.min(1, productImageMaxDisplayDimension / Math.max(dimensions.width, dimensions.height));
  const width = Math.max(1, Math.round(dimensions.width * scale));
  const height = Math.max(1, Math.round(dimensions.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });

  if (!context) {
    return file;
  }

  const bitmap = await createImageBitmap(file);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
  if (!blob || blob.size >= file.size) {
    return file;
  }

  return new File([blob], file.name.replace(/\.[^.]+$/, ".webp"), { type: "image/webp" });
}

function numberValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function editableInputValue(value: number | string | null) {
  return value === null ? "" : String(value);
}

function integerValueForSave(value: number | string | null, fallback: number) {
  if (value === "" || value === null) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function decimalValueForSave(value: number | string, fallback: number) {
  if (value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

const productExcelHeaders = [
  "SKU",
  "Código OEM / proveedor",
  "Nombre del producto",
  "Descripción corta",
  "Descripción completa",
  "Categoría",
  "Stock",
  "Stock mínimo",
  "Precio costo",
  "Precio al detalle",
  "Precio mayorista",
  "Cantidad mínima mayorista",
  "Producto nuevo",
  "Estado",
  "Marca del vehículo",
  "Modelo del vehículo",
  "Año inicial",
  "Año final",
  "Notas de compatibilidad",
  "Nombre de imagen",
];

const productTechnicalCsvHeaders = [
  "sku",
  "codigo_proveedor",
  "nombre",
  "marca_producto",
  "marca_carro",
  "modelo_carro",
  "anio_inicial",
  "anio_final",
  "descripcion_corta",
  "descripcion_completa",
  "notas_compatibilidad",
  "categoria",
  "stock",
  "stock_minimo",
  "precio_costo",
  "precio_detalle",
  "precio_mayorista",
  "cantidad_minima_mayorista",
  "producto_nuevo",
  "estado",
  "activo",
  "url_imagen",
  "public_id",
];

const productCsvHeaders = productTechnicalCsvHeaders;

const productOperationalExportHeaders = [
  "SKU",
  "Código OEM / proveedor",
  "Nombre del producto",
  "Descripción corta",
  "Descripción completa",
  "Categoría",
  "Stock",
  "Stock mínimo",
  "Precio costo",
  "Precio al detalle",
  "Precio mayorista",
  "Cantidad mínima mayorista",
  "Producto nuevo",
  "Estado",
  "Marca del vehículo",
  "Modelo del vehículo",
  "Año inicial",
  "Año final",
  "Notas de compatibilidad",
  "Imagen",
];

const requiredImportHeaders = ["SKU", "Nombre del producto", "Categoría", "Stock", "Precio al detalle"];
const zipMaxBytes = 250 * 1024 * 1024;

function spreadsheetSafeValue(value: unknown) {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
}

function csvValue(value: unknown) {
  return `"${spreadsheetSafeValue(value).replaceAll('"', '""')}"`;
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

function htmlEscape(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function downloadBlob(content: BlobPart, fileName: string, type: string) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function buildExcelTable(title: string, columns: string[], rows: unknown[][]) {
  const header = columns.map((column) => `<th>${htmlEscape(column)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((value) => `<td>${htmlEscape(spreadsheetSafeValue(value))}</td>`).join("")}</tr>`)
    .join("");

  return `
    <html>
      <head><meta charset="utf-8" /></head>
      <body>
        <h1>${htmlEscape(title)}</h1>
        <table border="1">
          <thead><tr>${header}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </body>
    </html>
  `;
}

function normalizeHeader(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findImportedCategory(categories: CategoryOption[], value: string | null | undefined) {
  const normalizedName = normalizeImportedProductCategoryName(value);
  return normalizedName ? categories.find((category) => category.name === normalizedName) ?? null : null;
}

function readExcelCell(row: Record<string, unknown>, labels: string[]) {
  const normalizedLabels = labels.map(normalizeHeader);
  const entry = Object.entries(row).find(([key]) => normalizedLabels.includes(normalizeHeader(key)));
  return String(entry?.[1] ?? "").trim();
}

function excelCellToText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const cellObject = value as { text?: unknown; result?: unknown; richText?: Array<{ text?: unknown }> };
    if (cellObject.text !== undefined) return String(cellObject.text);
    if (cellObject.result !== undefined) return String(cellObject.result);
    if (Array.isArray(cellObject.richText)) return cellObject.richText.map((part) => String(part.text ?? "")).join("");
  }
  return String(value);
}

function yesNo(value: boolean) {
  return value ? "Sí" : "No";
}

function parseYesNo(value: string) {
  const normalized = normalizeHeader(value);
  return ["si", "sí", "yes", "true", "1", "nuevo", "activa", "activo"].includes(normalized);
}

function parseStatus(value: string): ProductStatus {
  const normalized = normalizeHeader(value);
  if (["inactivo", "inactive"].includes(normalized)) return "inactive";
  if (["borrador", "draft"].includes(normalized)) return "draft";
  if (["archivado", "archived"].includes(normalized)) return "archived";
  return "active";
}

function displayStatus(status: ProductStatus) {
  return statusLabels[status] ?? status;
}

function productStateLabel(product: ProductAdminRow) {
  if (product.auto_disabled_by_stock) {
    return "Inactivo por falta de inventario";
  }

  return product.active ? displayStatus(product.status) : "Inactivo manualmente";
}

function persistProductDraft(product: EditableProductInput | null) {
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

export function ProductManager({
  products,
  categories,
  vehicleBrands,
  vehicleModels,
  total,
  page,
  pageSize,
  capabilities,
  filters,
}: ProductManagerProps) {
  const [query, setQuery] = useState(filters.query);
  const [status, setStatus] = useState<ProductStatus | "all">(filters.status as ProductStatus | "all");
  const [categoryId, setCategoryId] = useState(filters.categoryId);
  const [editing, setEditing] = useState<EditableProductInput | null>(null);
  const [message, setMessage] = useState<MessageState | null>(null);
  const [imageUploads, setImageUploads] = useState<Record<number, ImageUploadState>>({});
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [importMode, setImportMode] = useState<ProductImportMode>("create_and_update");
  const [importPreview, setImportPreview] = useState<ProductImportPreview | null>(null);
  const [isPreparingImport, setIsPreparingImport] = useState(false);
  const [isImportingProducts, setIsImportingProducts] = useState(false);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();
  const debouncedQuery = useDebouncedValue(query, 400);

  const filteredProducts = useMemo(() => {
    const normalizedQuery = debouncedQuery.trim().toLowerCase();

    return products.filter((product) => {
      const matchesQuery =
        !normalizedQuery ||
        `${product.sku} ${product.internal_code ?? ""} ${product.name} ${product.brand} ${product.category_name ?? ""} ${product.vehicle_brand ?? ""} ${product.vehicle_model ?? ""} ${product.vehicle_year_start ?? ""} ${product.vehicle_year_end ?? ""} ${product.short_description ?? ""} ${product.description} ${product.features ?? ""} ${product.specifications ?? ""} ${product.compatibility_notes ?? ""}`
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
    let draft: EditableProductInput | null = null;

    if (typeof window !== "undefined") {
      try {
        const storedDraft = window.sessionStorage.getItem(productDraftStorageKey);
        draft = storedDraft ? (JSON.parse(storedDraft) as EditableProductInput) : null;
      } catch {
        draft = null;
      }
    }

    setEditing(draft ?? { ...emptyProduct, images: [{ ...emptyImage }] });
    setImageUploads({});
    showMessage(
      draft
        ? "Se recuperó un borrador local. Revisa los datos antes de guardar."
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

  function updateField<K extends keyof EditableProductInput>(field: K, value: EditableProductInput[K]) {
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

  function normalizeVehicleFields(product: EditableProductInput): EditableProductInput {
    return {
      ...product,
      vehicle_brand: normalizeVehicleBrand(product.vehicle_brand),
      vehicle_model: normalizeVehicleModel(product.vehicle_model),
    };
  }

  function normalizeProductForSave(product: EditableProductInput): ProductFormInput {
    const normalized = normalizeVehicleFields(product);

    return {
      ...normalized,
      stock: integerValueForSave(normalized.stock, 0),
      min_stock: integerValueForSave(normalized.min_stock, 0),
      wholesale_min_quantity: integerValueForSave(normalized.wholesale_min_quantity, 1),
      cost_price: decimalValueForSave(normalized.cost_price, 0),
      retail_price: decimalValueForSave(normalized.retail_price, 0),
      wholesale_price: decimalValueForSave(normalized.wholesale_price, 0),
      vehicle_year_start: integerValueForSave(normalized.vehicle_year_start, 0) || null,
      vehicle_year_end: integerValueForSave(normalized.vehicle_year_end, 0) || null,
    };
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

  function setPrimaryImage(index: number) {
    setEditing((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        images: current.images.map((image, imageIndex) => ({
          ...image,
          is_primary: imageIndex === index,
        })),
      };
    });
    showMessage("Imagen principal actualizada. Guarda el producto para aplicar el cambio.", "neutral");
  }

  async function removeProductImage(index: number) {
    if (!editing) {
      return;
    }

    const confirmed = await toast.confirm({
      title: "Eliminar imagen",
      message: "Esta imagen se quitará del producto. ¿Deseas continuar?",
      confirmLabel: "Eliminar imagen",
      cancelLabel: "Cancelar",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    const imageToRemove = editing.images[index];
    const unsavedPublicId = !imageToRemove?.id ? imageToRemove?.public_id || imageToRemove?.storage_path : null;

    setEditing((current) => {
      if (!current) {
        return current;
      }

      const remaining = current.images.filter((_, imageIndex) => imageIndex !== index);
      const normalizedImages = remaining.length > 0 ? remaining : [{ ...emptyImage }];
      const hasPrimary = normalizedImages.some((image) => image.is_primary && image.public_url);

      return {
        ...current,
        images: normalizedImages.map((image, imageIndex) => ({
          ...image,
          sort_order: imageIndex,
          is_primary: hasPrimary ? image.is_primary : imageIndex === 0,
        })),
      };
    });

    setImageUploads((current) => {
      const next: Record<number, ImageUploadState> = {};
      Object.entries(current).forEach(([key, value]) => {
        const imageIndex = Number(key);
        if (imageIndex < index) {
          next[imageIndex] = value;
        } else if (imageIndex > index) {
          next[imageIndex - 1] = value;
        } else if (value.previewUrl) {
          URL.revokeObjectURL(value.previewUrl);
        }
      });
      return next;
    });

    if (unsavedPublicId) {
      startTransition(async () => {
        await deleteUploadedProductImageAction(unsavedPublicId);
      });
    }

    showMessage("Imagen removida del formulario. Guarda el producto para confirmar el cambio.", "neutral");
  }

  async function uploadImage(index: number, file: File | null) {
    if (!file || !editing) {
      return;
    }

    if (!isAllowedProductImageMimeType(file.type)) {
      setImageUploads((current) => ({
        ...current,
        [index]: {
          status: "error",
          message: productImageInvalidFormatMessage,
          fileName: file.name,
          file,
        },
      }));
      showMessage(productImageInvalidFormatMessage, "error");
      return;
    }

    if (file.size > productImageMaxBytes) {
      setImageUploads((current) => ({
        ...current,
        [index]: {
          status: "error",
          message: productImageTooLargeMessage,
          fileName: file.name,
          file,
        },
      }));
      showMessage(productImageTooLargeMessage, "error");
      return;
    }

    let uploadFile = file;
    let dimensions: { width: number; height: number };

    try {
      dimensions = await readImageDimensions(file);
    } catch {
      setImageUploads((current) => ({
        ...current,
        [index]: {
          status: "error",
          message: productImageInvalidFormatMessage,
          fileName: file.name,
          file,
        },
      }));
      showMessage(productImageInvalidFormatMessage, "error");
      return;
    }

    if (dimensions.width * dimensions.height > productImageMaxPixels) {
      const megapixels = formatMegapixels(dimensions.width, dimensions.height);
      setImageUploads((current) => ({
        ...current,
        [index]: {
          status: "error",
          message: `${productImageTooManyPixelsMessage} Esta imagen tiene ${megapixels} MP.`,
          fileName: file.name,
          file,
        },
      }));
      showMessage(productImageTooManyPixelsMessage, "error");
      return;
    }

    try {
      uploadFile = await optimizeImageInBrowser(file, dimensions);
    } catch {
      uploadFile = file;
    }

    const previewUrl = URL.createObjectURL(uploadFile);
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
          fileName: uploadFile.name,
          previewUrl,
          file: uploadFile,
        },
      };
    });
    showMessage("Subiendo imagen. El formulario permanecerá abierto aunque falle.", "neutral");

    startTransition(async () => {
      const formData = new FormData();
      formData.set("file", uploadFile);
      formData.set("productSlug", editing.slug || editing.sku || editing.name || "producto");
      formData.set("angle", editing.images[index]?.angle || "principal");

      const result = await uploadProductImageAction(formData);
      showMessage(result.message, result.ok ? "success" : "error");

      if (result.ok && result.publicUrl) {
        const previousImage = editing.images[index];
        const previousUnsavedPublicId = !previousImage?.id ? previousImage?.public_id || previousImage?.storage_path : null;
        if (previousUnsavedPublicId && previousUnsavedPublicId !== (result.publicId ?? result.storagePath)) {
          await deleteUploadedProductImageAction(previousUnsavedPublicId);
        }

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
    if (!product.category_id) {
      return "Selecciona una categoría para guardar el producto.";
    }

    if (!product.sku.trim()) {
      return "El SKU es requerido para inventario y búsquedas internas.";
    }

    if (!product.name.trim()) {
      return "Escribe el nombre del producto.";
    }

    if (!product.brand.trim()) {
      return "Escribe la marca del producto.";
    }

    if ((product.short_description?.length ?? 0) > productShortDescriptionMaxLength) {
      return `La descripción corta no puede superar ${productShortDescriptionMaxLength} caracteres.`;
    }

    if (product.stock < 0) {
      return "El stock no puede ser negativo.";
    }

    if (product.min_stock < 0) {
      return "El stock mínimo no puede ser negativo.";
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
      return "La cantidad mínima mayorista debe ser al menos 1.";
    }

    return null;
  }

  function addProductImageSlot() {
    if (!editing) {
      return;
    }

    if (editing.images.length >= maxProductImages) {
      showMessage(`Puedes subir hasta ${maxProductImages} imágenes por producto.`, "error");
      return;
    }

    updateField("images", [...editing.images, { ...emptyImage, is_primary: false, sort_order: editing.images.length }]);
  }

  function submitProduct() {
    if (!editing) {
      return;
    }

    const normalizedProduct = normalizeProductForSave(editing);
    const validationError = validateProductBeforeSave(normalizedProduct);
    if (validationError) {
      showMessage(validationError, "error");
      return;
    }

    startTransition(async () => {
      setEditing(normalizedProduct);
      const result = await saveProductAction(normalizedProduct);
      showMessage(result.message, result.ok ? "success" : "error");
      if (result.ok) {
        persistProductDraft(null);
        setEditing(null);
        setImageUploads({});
      }
    });
  }

  async function toggleActive(product: ProductAdminRow) {
    if (!product.active && product.available_stock <= 0) {
      const confirmed = await toast.confirm({
        title: "Producto sin inventario disponible",
        message:
          "Puedes solicitar la activacion, pero el producto permanecera inactivo y no podra comprarse hasta que vuelva a tener existencias.",
        confirmLabel: "Continuar",
        cancelLabel: "Cancelar",
        tone: "neutral",
      });

      if (!confirmed) {
        return;
      }
    }

    startTransition(async () => {
      const result = await setProductActiveAction(product.id, !product.active);
      showMessage(result.message, result.ok ? "success" : "error");
    });
  }

  async function deleteProduct(product: ProductAdminRow) {
    const isTestProduct = /\btest\b|^test-|test-|prueba/i.test(
      `${product.sku} ${product.name} ${product.slug} ${product.internal_code ?? ""}`,
    );
    const confirmed = await toast.confirm({
      title: "Confirmar eliminación",
      message: `¿Eliminar ${product.name}? Esta acción no se puede deshacer.`,
      confirmLabel: isTestProduct ? "ELIMINAR TEST" : "Eliminar",
      cancelLabel: "Cancelar",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    startTransition(async () => {
      const result = await deleteProductAction(product.id, isTestProduct ? "ELIMINAR TEST" : undefined);
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
      product.short_description,
      product.description,
      product.features,
      product.specifications,
      product.compatibility_notes,
      normalizeImportedProductCategoryName(product.category_name) ?? "",
      product.stock,
      product.min_stock,
      product.cost_price,
      product.retail_price,
      product.wholesale_price,
      product.wholesale_min_quantity,
      product.is_new,
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
      "Radio Android con pantalla tactil para Hilux.",
      "Radio Android con pantalla táctil, Bluetooth y soporte para cámara de retroceso.",
      "Bluetooth; USB; pantalla táctil; cámara de retroceso",
      "Pantalla 9 pulgadas; Android; memoria según lote",
      "Validar arnes y moldura antes de instalar.",
      categories[0]?.name ?? "",
      "10",
      "2",
      "50.00",
      "100.00",
      "80.00",
      "1",
      "false",
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
        showMessage("El CSV está vacío o no tiene filas de productos.", "error");
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
        const importedCategory = row.category || row.categoria;
        const category = categories.find((item) => item.id === row.category_id) ?? findImportedCategory(categories, importedCategory);

        return {
          ...emptyProduct,
          sku: row.sku ?? "",
          internal_code: row.internal_code || row.codigo_proveedor || row.codigo_oem || row.codigo_interno || row["código_interno"] || null,
          name: row.name ?? row.nombre ?? "",
          brand: row.brand ?? row.marca ?? "",
          vehicle_brand: normalizeVehicleBrand(row.vehicle_brand || row.marca_carro || null),
          vehicle_model: normalizeVehicleModel(row.vehicle_model || row.modelo_carro || null),
          vehicle_year_start: row.vehicle_year_start || row.anio_inicial ? numberValue(row.vehicle_year_start || row.anio_inicial) : null,
          vehicle_year_end: row.vehicle_year_end || row.anio_final ? numberValue(row.vehicle_year_end || row.anio_final) : null,
          short_description: row.short_description || row.descripcion_corta || null,
          description: row.description || row.descripcion_completa || row.descripcion || "",
          features: row.features || row.caracteristicas || row["características"] || null,
          specifications: row.specifications || row.especificaciones || null,
          compatibility_notes: row.compatibility_notes || row.notas_compatibilidad || null,
          category_id: category?.id ?? null,
          stock: numberValue(row.stock ?? "0"),
          min_stock: numberValue(row.min_stock ?? row.stock_minimo ?? row["stock_mínimo"] ?? "5"),
          cost_price: numberValue(row.cost_price ?? row.precio_costo ?? "0"),
          retail_price: numberValue(row.retail_price ?? row.precio_detalle ?? "0"),
          wholesale_price: numberValue(row.wholesale_price ?? row.precio_mayorista ?? "0"),
          wholesale_min_quantity: numberValue(row.wholesale_min_quantity ?? row.cantidad_minima_mayorista ?? row["cantidad_mínima_mayorista"] ?? "1"),
          is_new: ["true", "1", "si", "sí", "yes"].includes(String(row.is_new ?? row.producto_nuevo ?? "false").trim().toLowerCase()),
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

  void downloadImportTemplate;
  void importCsv;

  function exportTechnicalCsv() {
    if (!capabilities.technicalExports) return;
    exportCsv();
  }

  function productExportRows() {
    return filteredProducts.map((product) => [
      product.sku,
      product.internal_code ?? "",
      product.name,
      product.short_description ?? "",
      product.description ?? "",
      normalizeImportedProductCategoryName(product.category_name) ?? "",
      product.stock,
      product.min_stock,
      formatCurrency(product.cost_price),
      formatCurrency(product.retail_price),
      formatCurrency(product.wholesale_price),
      product.wholesale_min_quantity,
      yesNo(product.is_new),
      displayStatus(product.status),
      product.vehicle_brand ?? "",
      product.vehicle_model ?? "",
      product.vehicle_year_start ?? "",
      product.vehicle_year_end ?? "",
      product.compatibility_notes ?? "",
      yesNo(product.images.length > 0),
    ]);
  }

  function exportExcel() {
    downloadBlob(
      buildExcelTable("Productos - Car Zone Accesorios", productOperationalExportHeaders, productExportRows()),
      "car-zone-productos.xlsx.xls",
      "application/vnd.ms-excel;charset=utf-8",
    );
    toast.success("Excel operativo descargado correctamente.");
  }

  async function downloadExcelImportTemplate() {
    const sampleRow = [
      "ACCU088053",
      "OEM-088053",
      "Cámara Reversa Universal",
      "Cámara de reversa universal para instalación automotriz.",
      "Cámara de reversa universal con cableado para instalación automotriz.",
      categories[0]?.name ?? "",
      "10",
      "2",
      "50.00",
      "100.00",
      "80.00",
      "1",
      "Sí",
      "Activo",
      "Toyota",
      "Hilux",
      "2018",
      "2026",
      "Validar arnés y moldura antes de instalar.",
      "Cámara Reversa Universal.jpeg",
    ];

    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Productos");
    worksheet.addRow(productExcelHeaders);
    worksheet.addRow(sampleRow);
    worksheet.columns = productExcelHeaders.map((header) => ({ width: Math.max(16, header.length + 4) }));
    worksheet.getRow(1).font = { bold: true };
    for (let rowNumber = 2; rowNumber <= 5000; rowNumber += 1) {
      worksheet.getCell(rowNumber, 6).dataValidation = {
        type: "list",
        allowBlank: false,
        formulae: [`"${officialProductCategories.map((category) => category.name).join(",")}"`],
        showErrorMessage: true,
        errorTitle: "Categoría obligatoria",
        error: "Selecciona una de las siete categorías oficiales.",
      };
    }
    const buffer = await workbook.xlsx.writeBuffer();
    downloadBlob(
      new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      "plantilla-productos-car-zone.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    toast.success("Plantilla Excel descargada correctamente.");
  }

  async function readZipImages(file: File | null) {
    const warnings: string[] = [];
    const criticalErrors: string[] = [];
    const images: Array<ProductImportImageCandidate<File>> = [];

    if (!file) return { index: createProductImportImageIndex<File>([]), warnings, criticalErrors };
    if (!file.name.toLowerCase().endsWith(".zip")) {
      criticalErrors.push("El archivo de imágenes debe ser ZIP.");
      return { index: createProductImportImageIndex<File>([]), warnings, criticalErrors };
    }
    if (file.size > zipMaxBytes) {
      criticalErrors.push("El ZIP es demasiado grande. Divide las imágenes en lotes más pequeños.");
      return { index: createProductImportImageIndex<File>([]), warnings, criticalErrors };
    }

    try {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(file);
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        const originalPath = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
        const blob = await entry.async("blob");
        if (blob.size > 5 * 1024 * 1024) {
          criticalErrors.push(`Se rechazó ${originalPath}: supera 5 MB.`);
          continue;
        }
        const extension = originalPath.split(".").pop()?.toLowerCase() ?? "";
        const type = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
        const imageFile = new File([blob], originalPath.split("/").pop() ?? originalPath, { type });
        const candidate = createProductImportImageCandidate(originalPath, imageFile, blob.size, type);
        if (!candidate.ok) {
          criticalErrors.push(candidate.message);
          continue;
        }
        images.push(candidate.image);
      }
    } catch {
      criticalErrors.push("No se pudo leer el ZIP. Verifica que no esté corrupto e intenta nuevamente.");
    }

    return { index: createProductImportImageIndex(images), warnings, criticalErrors };
  }

  function matchImageForRow(imageName: string, sku: string, index: ProductImportImageIndex<File>) {
    return matchProductImportImage(imageName, sku, index);
  }

  async function prepareProductImportPreview() {
    if (!excelFile) {
      showMessage("Selecciona la plantilla Excel antes de validar.", "error");
      return;
    }
    if (!excelFile.name.toLowerCase().match(/\.(xlsx|xls)$/)) {
      showMessage("Selecciona un archivo Excel .xlsx o .xls.", "error");
      return;
    }

    setIsPreparingImport(true);
    setImportPreview(null);
    showMessage("Validando Excel e imágenes...", "neutral");

    try {
      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await excelFile.arrayBuffer());
      const worksheet = workbook.worksheets[0] ?? null;
      const headerValues = worksheet
        ? (worksheet.getRow(1).values as unknown[]).slice(1).map((value) => excelCellToText(value).trim())
        : [];
      const rows: Array<Record<string, unknown>> = [];
      worksheet?.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const values = row.values as unknown[];
        const rowObject = Object.fromEntries(headerValues.map((header, index) => [header, excelCellToText(values[index + 1]).trim()]));
        if (Object.values(rowObject).some((value) => String(value).trim())) {
          rows.push(rowObject);
        }
      });
      if (rows.length === 0) {
        showMessage("El Excel está vacío o no tiene filas de productos.", "error");
        return;
      }

      const headers = Object.keys(rows[0] ?? {});
      const missingHeaders = requiredImportHeaders.filter((header) => !headers.some((value) => normalizeHeader(value) === normalizeHeader(header)));
      if (missingHeaders.length > 0) {
        showMessage(`El Excel no tiene columnas requeridas: ${missingHeaders.join(", ")}. Descarga la plantilla oficial.`, "error");
        return;
      }

      const zipImages = await readZipImages(zipFile);
      const skuCounts = new Map<string, number>();
      const parsedRows = rows.map((row, index): ProductImportPreviewRow => {
        const sku = readExcelCell(row, ["SKU"]).toUpperCase();
        skuCounts.set(sku, (skuCounts.get(sku) ?? 0) + 1);
        const categoryName = readExcelCell(row, ["Categoría", "Categoria"]);
        const category = findImportedCategory(categories, categoryName);
        const imageName = readExcelCell(row, ["Nombre de imagen"]);
        const matchedImage = matchImageForRow(imageName, sku, zipImages.index);
        const statusValue = parseStatus(readExcelCell(row, ["Estado"]));
        const stock = numberValue(readExcelCell(row, ["Stock"]));
        const minStock = numberValue(readExcelCell(row, ["Stock mínimo", "Stock minimo"]));
        const retailPrice = numberValue(readExcelCell(row, ["Precio al detalle"]));
        const wholesalePrice = numberValue(readExcelCell(row, ["Precio mayorista"]));
        const wholesaleMinQuantity = numberValue(readExcelCell(row, ["Cantidad mínima mayorista", "Cantidad minima mayorista"]) || "1");
        const name = readExcelCell(row, ["Nombre del producto"]);
        const errors: string[] = [];
        const warnings: string[] = [];

        if (!sku) errors.push("SKU obligatorio.");
        if (!name) errors.push("Nombre del producto obligatorio.");
        if (!category) errors.push(`Categoría inválida: ${categoryName || "vacía"}.`);
        if (capabilities.adjustStock && stock < 0) errors.push("Stock no puede ser negativo.");
        if (!capabilities.adjustStock) warnings.push("Stock ignorado: los productos existentes conservarán su stock y los nuevos se crearán con stock 0.");
        if (minStock < 0) errors.push("Stock mínimo no puede ser negativo.");
        if (retailPrice <= 0) errors.push("Precio al detalle debe ser mayor a 0.");
        if (wholesalePrice < 0) errors.push("Precio mayorista no puede ser negativo.");
        if (wholesaleMinQuantity < 1) errors.push("Cantidad mínima mayorista debe ser al menos 1.");
        if (imageName && !matchedImage) {
          warnings.push(`Imagen faltante: no se encontró ${imageName} con extensiones jpg, jpeg, png o webp.`);
        }
        if (matchedImage?.warning) warnings.push(matchedImage.warning);

        return {
          rowNumber: index + 2,
          product: {
            ...emptyProduct,
            sku,
            internal_code: readExcelCell(row, ["Código OEM / proveedor", "Codigo OEM / proveedor"]) || null,
            name,
            brand: "General",
            vehicle_brand: normalizeVehicleBrand(readExcelCell(row, ["Marca del vehículo", "Marca del vehiculo"]) || null),
            vehicle_model: normalizeVehicleModel(readExcelCell(row, ["Modelo del vehículo", "Modelo del vehiculo"]) || null),
            vehicle_year_start: readExcelCell(row, ["Año inicial", "Anio inicial"]) ? numberValue(readExcelCell(row, ["Año inicial", "Anio inicial"])) : null,
            vehicle_year_end: readExcelCell(row, ["Año final", "Anio final"]) ? numberValue(readExcelCell(row, ["Año final", "Anio final"])) : null,
            short_description: readExcelCell(row, ["Descripción corta", "Descripcion corta"]) || null,
            description: readExcelCell(row, ["Descripción completa", "Descripcion completa"]) || "",
            compatibility_notes: readExcelCell(row, ["Notas de compatibilidad"]) || null,
            category_id: category?.id ?? null,
            stock,
            min_stock: minStock,
            cost_price: numberValue(readExcelCell(row, ["Precio costo"])),
            retail_price: retailPrice,
            wholesale_price: wholesalePrice,
            wholesale_min_quantity: wholesaleMinQuantity,
            is_new: parseYesNo(readExcelCell(row, ["Producto nuevo"])),
            status: statusValue,
            active: statusValue === "active",
            images: [],
          },
          imageName,
          matchedImageName: matchedImage?.image.fileName ?? null,
          matchedImagePath: matchedImage?.image.path ?? null,
          imageMatchMethod: matchedImage?.method ?? null,
          imageFile: matchedImage?.image.file,
          exists: false,
          duplicateSku: false,
          action: "create",
          errors,
          warnings,
        };
      });

      const skuStatus = await getProductImportSkuStatusAction(parsedRows.map((row) => row.product.sku));
      if (!skuStatus.ok) {
        throw new Error(skuStatus.message);
      }
      const existingSkus = new Set((skuStatus.existingSkus ?? []).map((sku) => sku.toUpperCase()));
      const previewRows = parsedRows.map((row) => {
        const exists = existingSkus.has(row.product.sku);
        const duplicateSku = (skuCounts.get(row.product.sku) ?? 0) > 1;
        const errors = duplicateSku ? [...row.errors, "SKU duplicado en el Excel."] : row.errors;
        const action: ProductImportPreviewRow["action"] = exists
          ? (importMode === "create_only" ? "skip" : "update")
          : importMode === "update_only"
            ? "skip"
            : "create";
        return { ...row, exists, duplicateSku, action, errors };
      });

      setImportPreview({ rows: previewRows, zipWarnings: zipImages.warnings, criticalErrors: zipImages.criticalErrors });
      showMessage("Preview listo. Revisa errores y confirma para importar.", "success");
    } catch (error) {
      showMessage(error instanceof Error ? `No se pudo preparar la importación: ${error.message}` : "No se pudo preparar la importación.", "error");
    } finally {
      setIsPreparingImport(false);
    }
  }

  async function confirmProductImport() {
    if (!importPreview) return;
    const rowsToImport = importPreview.rows.filter((row) => row.action !== "skip");
    if (importPreview.criticalErrors.length > 0 || rowsToImport.some((row) => row.errors.length > 0)) {
      showMessage("Corrige los errores del preview antes de importar.", "error");
      return;
    }

    const modeCopy = productImportModeCopy[importMode];
    const confirmed = await toast.confirm({
      title: "Confirmar importación",
      message: `Vas a importar productos con el modo: ${modeCopy.label}. ${modeCopy.confirmation}${capabilities.adjustStock ? "" : " La columna Stock será ignorada: los productos existentes conservarán su stock y los nuevos se crearán con stock 0."}`,
      confirmLabel: "Confirmar importación",
      cancelLabel: "Cancelar",
    });
    if (!confirmed) {
      return;
    }

    setIsImportingProducts(true);
    showMessage("Subiendo imágenes y guardando productos...", "neutral");
    let uploaded = 0;
    let missing = 0;
    let imageErrors = 0;
    const uploadedAssetIds: string[] = [];

    try {
      const productsToSave: ProductFormInput[] = [];
      for (const row of rowsToImport) {
        let product: ProductFormInput = { ...row.product, images: [] };
        if (row.imageFile) {
          const formData = new FormData();
          formData.set("file", row.imageFile);
          formData.set("productSlug", row.product.slug || row.product.sku || row.product.name);
          formData.set("angle", "principal");
          const upload = await uploadProductImageAction(formData);
          if (upload.ok && upload.publicUrl) {
            uploaded += 1;
            const uploadedAssetId = upload.publicId ?? upload.storagePath;
            if (uploadedAssetId) uploadedAssetIds.push(uploadedAssetId);
            product = {
              ...product,
              images: [{
                ...emptyImage,
                public_url: upload.publicUrl,
                storage_path: upload.storagePath,
                public_id: upload.publicId ?? upload.storagePath,
                alt_text: row.product.name,
              }],
            };
          } else {
            imageErrors += 1;
          }
        } else if (row.imageName) {
          missing += 1;
        }
        productsToSave.push(product);
      }

      const result = await importProductsAction(productsToSave, {
        mode: importMode,
        fileName: excelFile?.name,
        imageSummary: { uploaded, missing, errors: imageErrors },
      });
      showMessage(result.message, result.ok ? "success" : "error");
      if (!result.ok) {
        await Promise.all(uploadedAssetIds.map((publicId) => deleteUploadedProductImageAction(publicId)));
      }
      if (result.ok) {
        setImportPreview(null);
        setExcelFile(null);
        setZipFile(null);
      }
    } catch (error) {
      await Promise.all(uploadedAssetIds.map((publicId) => deleteUploadedProductImageAction(publicId)));
      showMessage(error instanceof Error ? `No se pudo importar: ${error.message}` : "No se pudo importar.", "error");
    } finally {
      setIsImportingProducts(false);
    }
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
              placeholder="Buscar por SKU, código proveedor/OEM, producto o marca"
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
          <Link
            href="/admin/productos"
            className="inline-flex items-center justify-center rounded-md border border-black/10 bg-white px-4 py-2 text-sm font-semibold transition-all hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:bg-[#fff1f2]"
          >
            Limpiar filtros
          </Link>
          {capabilities.create ? (
            <Button onClick={openNewProduct} variant="dark">
              <Plus size={17} />
              Nuevo
            </Button>
          ) : null}
          {capabilities.exportProducts ? (
            <Button onClick={exportExcel} variant="ghost">
              <FileSpreadsheet size={17} />
              Excel
            </Button>
          ) : null}
          {capabilities.exportProducts && capabilities.technicalExports ? (
            <Button onClick={exportTechnicalCsv} variant="ghost" title="Exportación técnica disponible solo para el Technical Owner">
              <Download size={17} />
              CSV técnico
            </Button>
          ) : null}
        </form>
        <p className="mt-3 text-sm text-black/55">
          Página {page}: mostrando {products.length.toLocaleString("es-HN")} de {total.toLocaleString("es-HN")} productos.
        </p>
        {message ? (
          <p
            className={`mt-3 rounded-md px-3 py-2 text-sm ${
              message.type === "success"
                ? "bg-[#fff1f2] text-[#b91c25]"
                : message.type === "error"
                  ? "bg-[#fff0ea] text-[#9b341b]"
                  : "bg-[#f4f4f5] text-black/60"
            }`}
            aria-live="polite"
          >
            {message.text}
          </p>
        ) : null}
      </section>

      {capabilities.importProducts ? (
      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h2 className="font-semibold">Importación masiva</h2>
            <p className="mt-1 text-sm text-black/55">Sube un Excel de productos y un ZIP opcional de imágenes.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button onClick={() => void downloadExcelImportTemplate()} variant="ghost" title="Descargar plantilla Excel para importar productos">
              <FileSpreadsheet size={17} />
              Descargar plantilla
            </Button>
            <select
              aria-label="Modo de importación"
              value={importMode}
              onChange={(event) => {
                setImportMode(event.target.value as ProductImportMode);
                setImportPreview(null);
              }}
              className="h-10 rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
            >
              <option value="create_and_update">Crear y actualizar (Recomendado)</option>
              <option value="create_only">Crear solo productos nuevos</option>
              <option value="update_only">Actualizar productos existentes</option>
            </select>
          </div>
        </div>

        <p className="mt-2 rounded-md bg-[#f8fafc] px-3 py-2 text-xs text-black/65">
          {productImportModeCopy[importMode].description}
        </p>

        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
          <label className="rounded-md border border-black/10 bg-[#f8fafc] px-3 py-2.5 text-sm">
            <span className="block text-sm font-semibold">Excel de productos</span>
            <input
              type="file"
              accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              className="mt-2 block w-full text-sm"
              onChange={(event) => {
                setExcelFile(event.target.files?.[0] ?? null);
                setImportPreview(null);
              }}
            />
            <span className="mt-1 block truncate text-xs text-black/55">{excelFile ? excelFile.name : "Selecciona un archivo .xlsx o .xls."}</span>
          </label>

          <label className="rounded-md border border-black/10 bg-[#f8fafc] px-3 py-2.5 text-sm">
            <span className="block text-sm font-semibold">ZIP de imágenes</span>
            <input
              type="file"
              accept=".zip,application/zip"
              className="mt-2 block w-full text-sm"
              onChange={(event) => {
                setZipFile(event.target.files?.[0] ?? null);
                setImportPreview(null);
              }}
            />
            <span className="mt-1 block truncate text-xs text-black/55">{zipFile ? zipFile.name : "Opcional."}</span>
          </label>

          <div className="flex flex-col gap-2 sm:flex-row lg:flex-col">
            <Button onClick={() => void prepareProductImportPreview()} disabled={isPreparingImport || !excelFile} variant="dark" className="h-10 whitespace-nowrap">
              {isPreparingImport ? <Loader2 size={17} className="animate-spin" /> : <Upload size={17} />}
              Validar archivos
            </Button>
            {!importPreview ? (
              <Button disabled variant="ghost" className="h-10 whitespace-nowrap" title="Valida los archivos y revisa el preview antes de importar.">
                <Save size={17} />
                Importar productos
              </Button>
            ) : null}
          </div>
        </div>

        <p className="mt-2 text-xs text-black/55">
          Las imágenes se relacionan por Nombre de imagen o SKU. Acepta JPG, PNG y WEBP.
        </p>
        <p className="mt-1 text-xs text-black/55">
          Puedes escribir el nombre con o sin extensión. También aceptamos imágenes dentro de carpetas del ZIP.
          Ejemplo: <span className="font-medium">toyota yaris 14-17</span> o <span className="font-medium">toyota yaris 14-17.jpg</span>.
        </p>

        {importPreview ? (
          <ImportPreviewPanel
            preview={importPreview}
            mode={importMode}
            pending={isImportingProducts}
            onConfirm={() => void confirmProductImport()}
            onCancel={() => setImportPreview(null)}
          />
        ) : null}
      </section>
      ) : null}

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
        <div className="grid gap-3 p-3 md:hidden">
          {filteredProducts.length === 0 ? (
            <p className="rounded-md bg-[#f4f4f5] p-4 text-center text-sm text-black/55">
              {total === 0 && !filters.query && !filters.status && !filters.categoryId
                ? "Aun no hay productos cargados. Usa Crear producto o Importar CSV para cargar el primer producto real."
                : "No se encontraron resultados con estos filtros."}
            </p>
          ) : (
            filteredProducts.map((product) => (
              <article key={product.id} className="rounded-md border border-black/10 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words text-base font-semibold [overflow-wrap:anywhere]">{product.name}</h3>
                    {product.short_description ? <p className="mt-1 line-clamp-2 text-sm text-black/55">{product.short_description}</p> : null}
                    <p className="mt-2 break-words text-xs text-black/50 [overflow-wrap:anywhere]">
                      {product.sku} {product.internal_code ? `/ ${product.internal_code}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-md bg-[#fff1f2] px-2 py-1 text-xs font-semibold">{productStateLabel(product)}</span>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Categoria</dt>
                    <dd className="mt-1 font-medium">{product.category_name ?? "Categoría pendiente"}</dd>
                  </div>
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Stock</dt>
                    <dd className={product.stock <= product.min_stock ? "mt-1 font-semibold text-[#b91c25]" : "mt-1 font-semibold"}>
                      {product.stock}
                      <span className="font-normal text-black/45"> / min. {product.min_stock}</span>
                    </dd>
                  </div>
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Detalle</dt>
                    <dd className="mt-1 font-semibold">{formatCurrency(product.retail_price)}</dd>
                  </div>
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Mayorista</dt>
                    <dd className="mt-1 font-semibold">{formatCurrency(product.wholesale_price)}</dd>
                  </div>
                </dl>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  {capabilities.update ? (
                    <IconButton label="Editar" onClick={() => openExistingProduct(product)}>
                      <Pencil size={16} />
                    </IconButton>
                  ) : null}
                  {capabilities.update ? (
                    <IconButton label={product.active ? "Desactivar" : "Activar"} onClick={() => toggleActive(product)}>
                      {product.active ? <Archive size={16} /> : <CheckCircle2 size={16} />}
                    </IconButton>
                  ) : null}
                  {capabilities.deleteProducts ? (
                    <IconButton label="Eliminar" onClick={() => deleteProduct(product)}>
                      <Trash2 size={16} />
                    </IconButton>
                  ) : null}
                </div>
              </article>
            ))
          )}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-4 py-3">Producto</th>
                <th className="px-4 py-3">Categoría</th>
                <th className="px-4 py-3">Stock</th>
                <th className="px-4 py-3">Costo</th>
                <th className="px-4 py-3">Precio al detalle</th>
                <th className="px-4 py-3">Precio mayorista</th>
                <th className="px-4 py-3">Etiqueta</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-black/55">
                    {total === 0 && !filters.query && !filters.status && !filters.categoryId
                      ? "Aún no hay productos cargados. Usa Crear producto o Importar CSV para cargar el primer producto real."
                      : "No se encontraron resultados con estos filtros."}
                  </td>
                </tr>
              ) : (
                filteredProducts.map((product) => (
                <tr key={product.id} className="transition-colors hover:bg-[#f4f4f5]">
                  <td className="px-4 py-3">
                    <p className="font-semibold">{product.name}</p>
                    {product.short_description ? <p className="mt-1 line-clamp-1 max-w-md text-xs text-black/55">{product.short_description}</p> : null}
                    <p className="text-xs text-black/50">
                      {product.sku} {product.internal_code ? `/ ${product.internal_code}` : ""}
                    </p>
                  </td>
                  <td className="px-4 py-3">{product.category_name ?? "Categoría pendiente"}</td>
                  <td className="px-4 py-3">
                    <span className={product.stock <= product.min_stock ? "font-semibold text-[#b91c25]" : ""}>
                      {product.stock}
                    </span>
                    <span className="text-black/45"> / mínimo {product.min_stock}</span>
                  </td>
                  <td className="px-4 py-3">{formatCurrency(product.cost_price)}</td>
                  <td className="px-4 py-3 font-semibold">{formatCurrency(product.retail_price)}</td>
                  <td className="px-4 py-3 font-semibold">{formatCurrency(product.wholesale_price)}</td>
                  <td className="px-4 py-3">
                    {product.is_new ? <span className="rounded-md bg-black px-2 py-1 text-xs font-semibold text-white">Nuevo</span> : "-"}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-md bg-[#fff1f2] px-2 py-1 text-xs">{productStateLabel(product)}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      {capabilities.update ? (
                    <IconButton label="Editar" onClick={() => openExistingProduct(product)}>
                      <Pencil size={16} />
                    </IconButton>
                  ) : null}
                      {capabilities.update ? (
                    <IconButton label={product.active ? "Desactivar" : "Activar"} onClick={() => toggleActive(product)}>
                      {product.active ? <Archive size={16} /> : <CheckCircle2 size={16} />}
                    </IconButton>
                  ) : null}
                      {capabilities.deleteProducts ? (
                    <IconButton label="Eliminar" onClick={() => deleteProduct(product)}>
                      <Trash2 size={16} />
                    </IconButton>
                  ) : null}
                    </div>
                  </td>
                </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {editing ? (
        <ProductEditor
          categories={categories}
          vehicleBrands={vehicleBrands}
          vehicleModels={vehicleModels}
          product={editing}
          pending={isPending}
          imageUploads={imageUploads}
          canAdjustStock={capabilities.adjustStock}
          canManageImages={capabilities.manageImages}
          onClose={closeEditor}
          onSubmit={submitProduct}
          onField={updateField}
          onImage={updateImage}
          onUploadImage={uploadImage}
          onRetryImage={retryImageUpload}
          onAddImage={addProductImageSlot}
          onRemoveImage={removeProductImage}
          onPrimaryImage={setPrimaryImage}
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

function ImportPreviewPanel({
  preview,
  mode,
  pending,
  onConfirm,
  onCancel,
}: {
  preview: ProductImportPreview;
  mode: ProductImportMode;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const validRows = preview.rows.filter((row) => row.errors.length === 0 && row.action !== "skip");
  const errorRows = preview.rows.filter((row) => row.errors.length > 0);
  const createRows = preview.rows.filter((row) => row.action === "create" && row.errors.length === 0);
  const updateRows = preview.rows.filter((row) => row.action === "update" && row.errors.length === 0);
  const skippedRows = preview.rows.filter((row) => row.action === "skip");
  const foundImages = preview.rows.filter((row) => row.imageFile).length;
  const missingImages = preview.rows.filter((row) => row.imageName && !row.imageFile).length;
  const detectedErrors = errorRows.length + preview.criticalErrors.length;
  const existingSkippedRows = skippedRows.filter((row) => row.exists);
  const newSkippedRows = skippedRows.filter((row) => !row.exists);
  const hasModeWarning =
    (mode === "create_only" && existingSkippedRows.length > 0) ||
    (mode === "update_only" && newSkippedRows.length > 0);

  return (
    <div className="mt-4 rounded-lg border border-black/10 bg-[#f8fafc] p-4">
      <p className="text-sm font-semibold">
        Se crearán {createRows.length} productos nuevos y se actualizarán {updateRows.length} productos existentes.
      </p>
      <div className="mt-3 grid gap-2 md:grid-cols-3 xl:grid-cols-6">
        <PreviewMetric label="Productos nuevos que se crearán" value={createRows.length} />
        <PreviewMetric label="Productos existentes que se actualizarán" value={updateRows.length} />
        <PreviewMetric label="Productos que se omitirán" value={skippedRows.length} />
        <PreviewMetric label="Imágenes encontradas" value={foundImages} />
        <PreviewMetric label="Imágenes faltantes" value={missingImages} tone={missingImages > 0 ? "warning" : "neutral"} />
        <PreviewMetric label="Errores detectados" value={detectedErrors} tone={detectedErrors > 0 ? "danger" : "neutral"} />
      </div>

      <div className={`mt-3 rounded-md px-3 py-2 text-sm ${hasModeWarning ? "bg-[#fff7ed] text-[#7c2d12]" : "bg-[#f1faf8] text-[#166534]"}`}>
        {mode === "create_and_update"
          ? "Este modo creará productos nuevos y actualizará los existentes según el SKU."
          : mode === "create_only" && existingSkippedRows.length > 0
            ? `Hay ${existingSkippedRows.length} productos que ya existen y no serán modificados porque seleccionaste Crear solo productos nuevos.`
            : mode === "update_only" && newSkippedRows.length > 0
              ? `Hay ${newSkippedRows.length} productos nuevos que no serán creados porque seleccionaste Actualizar productos existentes.`
              : productImportModeCopy[mode].description}
      </div>

      {preview.criticalErrors.length > 0 ? (
        <div className="mt-3 rounded-md bg-[#fff0ea] px-3 py-2 text-sm text-[#9b341b]">
          {preview.criticalErrors.map((error) => <p key={error}>{error}</p>)}
        </div>
      ) : null}

      {preview.zipWarnings.length > 0 ? (
        <div className="mt-3 rounded-md bg-[#fff7ed] px-3 py-2 text-sm text-[#7c2d12]">
          {preview.zipWarnings.slice(0, 6).map((warning) => <p key={warning}>{warning}</p>)}
          {preview.zipWarnings.length > 6 ? <p>Hay {preview.zipWarnings.length - 6} advertencias adicionales del ZIP.</p> : null}
        </div>
      ) : null}

      <div className="mt-4 max-h-80 overflow-auto rounded-md border border-black/10 bg-white">
        <div className="grid gap-2 p-3 md:hidden">
          {preview.rows.slice(0, 200).map((row) => (
            <article key={`${row.rowNumber}-${row.product.sku}-mobile`} className="rounded-md border border-black/10 p-3 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">Fila {row.rowNumber}</p>
                  <p className="mt-1 break-words [overflow-wrap:anywhere]">{row.product.name || "-"}</p>
                  <p className="mt-1 break-words text-black/50 [overflow-wrap:anywhere]">{row.product.sku || "-"}</p>
                </div>
                <span className="shrink-0 rounded-md bg-[#f4f4f5] px-2 py-1">
                  {row.action === "create" ? "Crear" : row.action === "update" ? "Actualizar" : "Omitir"}
                </span>
              </div>
              <dl className="mt-3 grid gap-2">
                <div className="rounded-md bg-[#f8fafc] p-2">
                  <dt className="uppercase text-black/45">Imagen Excel</dt>
                  <dd className="mt-1 break-words font-medium [overflow-wrap:anywhere]">{row.imageName || "Sin nombre; se busco por SKU"}</dd>
                </div>
                <div className="rounded-md bg-[#f8fafc] p-2">
                  <dt className="uppercase text-black/45">Archivo encontrado</dt>
                  <dd className="mt-1 break-words font-medium [overflow-wrap:anywhere]">
                    {row.matchedImagePath ?? (row.imageName ? "Imagen faltante" : "No se encontro imagen por SKU")}
                  </dd>
                </div>
                <div className="rounded-md bg-[#f8fafc] p-2">
                  <dt className="uppercase text-black/45">Validacion</dt>
                  <dd className="mt-1 break-words font-medium [overflow-wrap:anywhere]">
                    {row.errors.length > 0 ? row.errors.join(" ") : row.warnings.length > 0 ? row.warnings.join(" ") : "Listo"}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
        <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[1120px] text-left text-xs">
          <thead className="bg-[#e7e5e4] uppercase text-black/55">
            <tr>
              <th className="px-3 py-2">Fila</th>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Producto</th>
              <th className="px-3 py-2">Acción</th>
              <th className="px-3 py-2">Imagen Excel</th>
              <th className="px-3 py-2">Archivo encontrado</th>
              <th className="px-3 py-2">Coincidencia</th>
              <th className="px-3 py-2">Validación</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/10">
            {preview.rows.slice(0, 200).map((row) => (
              <tr key={`${row.rowNumber}-${row.product.sku}`}>
                <td className="px-3 py-2">{row.rowNumber}</td>
                <td className="px-3 py-2 font-semibold">{row.product.sku || "-"}</td>
                <td className="px-3 py-2">{row.product.name || "-"}</td>
                <td className="px-3 py-2">
                  {row.action === "create" ? "Crear" : row.action === "update" ? "Actualizar" : "Omitir"}
                </td>
                <td className="px-3 py-2">
                  {row.imageName || "Sin nombre; se buscó por SKU"}
                </td>
                <td className="px-3 py-2">
                  {row.matchedImagePath ?? (row.imageName ? "Imagen faltante" : "No se encontró imagen por SKU")}
                </td>
                <td className="px-3 py-2">
                  {row.imageMatchMethod ?? `Sin coincidencia en ${allowedProductImportImageExtensions.join(", ")}`}
                </td>
                <td className="px-3 py-2">
                  {row.errors.length > 0 ? (
                    <span className="text-[#b91c25]">{row.errors.join(" ")}</span>
                  ) : row.warnings.length > 0 ? (
                    <span className="text-[#7c2d12]">{row.warnings.join(" ")}</span>
                  ) : (
                    <span className="text-[#166534]">Listo</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:flex sm:flex-wrap sm:justify-end">
        <Button onClick={onCancel} variant="ghost" disabled={pending} className="w-full sm:w-auto">
          Cancelar
        </Button>
        <Button onClick={onConfirm} variant="dark" disabled={pending || detectedErrors > 0 || validRows.length === 0} className="w-full sm:w-auto">
          {pending ? <Loader2 size={17} className="animate-spin" /> : <Save size={17} />}
          {pending ? "Importando productos..." : "Importar productos"}
        </Button>
      </div>
    </div>
  );
}

function PreviewMetric({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "warning" | "danger" }) {
  return (
    <div className={`rounded-md px-3 py-2 ${tone === "danger" ? "bg-[#fff0ea]" : tone === "warning" ? "bg-[#fffbeb]" : "bg-white"}`}>
      <p className="text-[11px] font-medium uppercase text-black/50">{label}</p>
      <p className="text-lg font-semibold">{value.toLocaleString("es-HN")}</p>
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
      className="grid size-9 place-items-center rounded-md border border-black/10 bg-white text-[#080808] transition-colors hover:bg-[#f4f4f5]"
    >
      {children}
    </button>
  );
}

function IntegerProductInput({
  value,
  onChange,
  placeholder,
}: {
  value: number | string | null;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <Input
      type="text"
      inputMode="numeric"
      value={editableInputValue(value)}
      onChange={(event) => {
        const nextValue = event.target.value;
        if (integerInputPattern.test(nextValue)) {
          onChange(nextValue);
        }
      }}
      placeholder={placeholder}
    />
  );
}

function DecimalProductInput({ value, onChange }: { value: number | string; onChange: (value: string) => void }) {
  return (
    <Input
      type="text"
      inputMode="decimal"
      value={editableInputValue(value)}
      onChange={(event) => {
        const nextValue = event.target.value;
        if (decimalInputPattern.test(nextValue)) {
          onChange(nextValue);
        }
      }}
    />
  );
}

function ProductEditor({
  categories,
  vehicleBrands,
  vehicleModels,
  product,
  pending,
  imageUploads,
  canAdjustStock,
  canManageImages,
  onClose,
  onSubmit,
  onField,
  onImage,
  onUploadImage,
  onRetryImage,
  onAddImage,
  onRemoveImage,
  onPrimaryImage,
}: {
  categories: CategoryOption[];
  vehicleBrands: string[];
  vehicleModels: string[];
  product: EditableProductInput;
  pending: boolean;
  imageUploads: Record<number, ImageUploadState>;
  canAdjustStock: boolean;
  canManageImages: boolean;
  onClose: () => void;
  onSubmit: () => void;
  onField: <K extends keyof EditableProductInput>(field: K, value: EditableProductInput[K]) => void;
  onImage: (index: number, patch: Partial<ProductImageInput>) => void;
  onUploadImage: (index: number, file: File | null) => void;
  onRetryImage: (index: number) => void;
  onAddImage: () => void;
  onRemoveImage: (index: number) => void;
  onPrimaryImage: (index: number) => void;
}) {
  const [slugEditable, setSlugEditable] = useState(false);
  const vehicleHasData = Boolean(
    product.vehicle_brand || product.vehicle_model || product.vehicle_year_start || product.vehicle_year_end,
  );
  const [vehicleUniversal, setVehicleUniversal] = useState(!vehicleHasData);
  const generatedSlug = slugifyProductUrl(product.name);
  const displayedSlug = product.slug || generatedSlug;
  const categoryMissing = !product.category_id;

  function toggleUniversalVehicle(checked: boolean) {
    setVehicleUniversal(checked);
    if (checked) {
      onField("vehicle_brand", null);
      onField("vehicle_model", null);
      onField("vehicle_year_start", null);
      onField("vehicle_year_end", null);
    }
  }

  function normalizeVehicleField(field: "vehicle_brand" | "vehicle_model") {
    const normalized =
      field === "vehicle_brand"
        ? normalizeVehicleBrand(product.vehicle_brand)
        : normalizeVehicleModel(product.vehicle_model);
    onField(field, normalized);
  }

  return (
    <div className="cz-layer-modal fixed inset-0 overflow-y-auto bg-black/45 p-3 sm:p-4">
      <section className="mx-auto my-4 max-h-[90vh] w-full max-w-6xl overflow-y-auto rounded-lg bg-white text-[#080808] sm:my-6">
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
            <FormSection title="Información básica" description="Datos principales que el cliente y el equipo verán al buscar el producto.">
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
                  help="Marca comercial del producto o fabricante del accesorio. Ej. Pioneer, JBL, Osram, Toyota o Genérico."
                  tooltip="Marca del producto no es lo mismo que marca del vehículo."
                >
                  <Input value={product.brand} onChange={(event) => onField("brand", event.target.value)} placeholder="Ej. Pioneer" />
                </Field>
              </div>

              <Field
                label="Descripción corta"
                help="Se usa en catálogo, tarjetas y SEO. Máximo 160 caracteres."
                action={
                  <span
                    className={`text-xs font-medium ${
                      (product.short_description?.length ?? 0) > productShortDescriptionMaxLength ? "text-[#b91c25]" : "text-black/45"
                    }`}
                  >
                    {(product.short_description?.length ?? 0).toLocaleString("es-HN")}/{productShortDescriptionMaxLength}
                  </span>
                }
              >
                <textarea
                  value={product.short_description ?? ""}
                  onChange={(event) => onField("short_description", event.target.value.slice(0, productShortDescriptionMaxLength))}
                  placeholder="Ej. Radio Android con pantalla tactil compatible con Toyota Corolla."
                  maxLength={productShortDescriptionMaxLength}
                  className="min-h-20 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                />
              </Field>

              <Field label="Descripción" help="Resume el uso, compatibilidad o contenido del producto.">
                <textarea
                  value={product.description}
                  onChange={(event) => onField("description", event.target.value)}
                  placeholder="Describe el producto de forma clara para ventas y clientes."
                  className="min-h-36 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                />
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Características" help="Una por línea o separadas por punto y coma.">
                  <textarea
                    value={product.features ?? ""}
                    onChange={(event) => onField("features", event.target.value || null)}
                    placeholder={"Ej. Bluetooth\nUSB\nControl desde volante"}
                    className="min-h-28 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                  />
                </Field>
                <Field label="Especificaciones" help="Datos técnicos que ayudan a confirmar compatibilidad.">
                  <textarea
                    value={product.specifications ?? ""}
                    onChange={(event) => onField("specifications", event.target.value || null)}
                    placeholder={"Ej. Pantalla 9 pulgadas\nAndroid\nVoltaje 12V"}
                    className="min-h-28 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                  />
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_180px_180px]">
                <Field label="Categoría">
                  <select
                    value={product.category_id ?? ""}
                    onChange={(event) => onField("category_id", event.target.value || null)}
                    required
                    aria-invalid={categoryMissing}
                    aria-describedby={categoryMissing ? "product-category-error" : undefined}
                    className={`w-full rounded-md border bg-white px-3 py-2 text-sm outline-none ${
                      categoryMissing ? "border-[#b91c25]" : "border-black/10"
                    }`}
                  >
                    <option value="">Sin categoría</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                  {categoryMissing ? (
                    <p id="product-category-error" className="mt-1 text-xs font-medium text-[#b91c25]">
                      Selecciona una categoría para guardar el producto.
                    </p>
                  ) : null}
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
              <label className="flex items-start gap-3 rounded-md border border-black/10 bg-[#f8f8f8] px-3 py-3 text-sm">
                <input
                  type="checkbox"
                  checked={product.is_new}
                  onChange={(event) => onField("is_new", event.target.checked)}
                  className="mt-0.5 size-4"
                />
                <span>
                  <span className="block font-semibold">Producto nuevo</span>
                  <span className="mt-1 block text-xs text-black/50">Mostrar etiqueta Nuevo en el catálogo.</span>
                </span>
              </label>
            </FormSection>

            <FormSection title="Identificación interna" description="Códigos para inventario, búsquedas internas y referencias de proveedor.">
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
                  help="Opcional. Código del proveedor, fabricante u OEM."
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
            </FormSection>

            <FormSection title="Precios e inventario" description="Controla stock, costo y precios para venta al detalle y mayorista.">
              <div className="grid gap-3 sm:grid-cols-3">
                {canAdjustStock ? (
                  <Field label="Stock" help="No puede ser negativo.">
                    <IntegerProductInput value={product.stock} onChange={(value) => onField("stock", value)} />
                  </Field>
                ) : (
                  <Field label="Stock" help="Solo lectura. Se administra desde Inventario.">
                    <div className="rounded-md border border-black/10 bg-[#f4f4f5] px-3 py-2 text-sm font-semibold">
                      {product.id ? product.stock : 0}
                      <span className="ml-2 font-normal text-black/50">{product.id ? "Se conservará sin cambios" : "Nuevo producto: stock 0"}</span>
                    </div>
                  </Field>
                )}
                <Field label="Stock mínimo" help="Activa alertas cuando el producto llega a este nivel.">
                  <IntegerProductInput value={product.min_stock} onChange={(value) => onField("min_stock", value)} />
                </Field>
                <Field label="Cantidad mínima mayorista" help="Cantidad mínima requerida para aplicar precio mayorista.">
                  <IntegerProductInput value={product.wholesale_min_quantity} onChange={(value) => onField("wholesale_min_quantity", value)} />
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Precio de costo" help="Costo interno. No puede ser negativo.">
                  <DecimalProductInput value={product.cost_price} onChange={(value) => onField("cost_price", value)} />
                </Field>
                <Field label="Precio al detalle" help="Precio normal para clientes sin cuenta mayorista.">
                  <DecimalProductInput value={product.retail_price} onChange={(value) => onField("retail_price", value)} />
                </Field>
                <Field label="Precio mayorista" help="Precio especial para clientes mayoristas autorizados.">
                  <DecimalProductInput value={product.wholesale_price} onChange={(value) => onField("wholesale_price", value)} />
                </Field>
              </div>
              {decimalValueForSave(product.wholesale_price, 0) > decimalValueForSave(product.retail_price, 0) ? (
                <p className="rounded-md bg-[#fff0ea] px-3 py-2 text-sm font-medium text-[#9b341b]">
                  El precio mayorista no puede ser mayor que el precio al detalle.
                </p>
              ) : null}
            </FormSection>

            <FormSection title="Compatibilidad del vehículo" description="Indica para qué vehículo es compatible este producto.">
              <div className="flex flex-wrap items-start gap-3">
                <label className="inline-flex max-w-md items-start gap-3 rounded-md border border-black/10 bg-[#f4f4f5] px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={vehicleUniversal}
                    onChange={(event) => toggleUniversalVehicle(event.target.checked)}
                    className="mt-1 size-4 shrink-0 accent-[#e4252c]"
                  />
                  <span>
                    <span className="block font-medium">Producto universal</span>
                    <span className="block text-xs text-black/55">
                      Compatible con múltiples vehículos.
                    </span>
                  </span>
                </label>
              </div>

              {!vehicleUniversal ? (
                <>
                  <p className="rounded-md bg-[#fff1f2] px-3 py-2 text-xs text-[#b91c25]">
                    Marca del producto no es lo mismo que marca del vehículo. Ejemplo: marca del producto Pioneer,
                    marca del vehículo Toyota, modelo Corolla, años 2010 - 2014.
                  </p>

                  <div className="grid gap-3 sm:grid-cols-4">
                    <Field label="Marca del vehículo">
                      <Input
                        value={product.vehicle_brand ?? ""}
                        onChange={(event) => onField("vehicle_brand", event.target.value || null)}
                        onBlur={() => normalizeVehicleField("vehicle_brand")}
                        list="vehicle-brand-options"
                        placeholder="Ej. Toyota"
                        autoComplete="off"
                      />
                      <datalist id="vehicle-brand-options">
                        {vehicleBrands.map((brand) => (
                          <option key={brand} value={brand} />
                        ))}
                      </datalist>
                    </Field>
                    <Field label="Modelo del vehículo">
                      <Input
                        value={product.vehicle_model ?? ""}
                        onChange={(event) => onField("vehicle_model", event.target.value || null)}
                        onBlur={() => normalizeVehicleField("vehicle_model")}
                        list="vehicle-model-options"
                        placeholder="Ej. Corolla"
                        autoComplete="off"
                      />
                      <datalist id="vehicle-model-options">
                        {vehicleModels.map((model) => (
                          <option key={model} value={model} />
                        ))}
                      </datalist>
                    </Field>
                    <Field label="Año inicial">
                      <IntegerProductInput value={product.vehicle_year_start} onChange={(value) => onField("vehicle_year_start", value)} placeholder="2010" />
                    </Field>
                    <Field label="Año final">
                      <IntegerProductInput value={product.vehicle_year_end} onChange={(value) => onField("vehicle_year_end", value)} placeholder="2014" />
                    </Field>
                  </div>
                </>
              ) : null}

              <Field label="Notas de compatibilidad" help="Aclara excepciones, arneses, molduras o verificaciones antes de instalar.">
                <textarea
                  value={product.compatibility_notes ?? ""}
                  onChange={(event) => onField("compatibility_notes", event.target.value || null)}
                  placeholder="Ej. Validar arnes original antes de instalar. Puede requerir moldura adicional."
                  className="min-h-24 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                />
              </Field>
            </FormSection>

            <FormSection title="Opciones avanzadas" description="Normalmente no necesitas tocar estos campos.">
              <Field
                label="URL amigable"
                help="URL amigable generada automáticamente desde el nombre del producto."
                tooltip="Solo cambia esto si necesitas una URL específica."
                action={
                  <button
                    type="button"
                    onClick={() => setSlugEditable((current) => !current)}
                    className="text-xs font-semibold text-[#e4252c]"
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
                  className={!slugEditable ? "bg-[#f4f4f5] text-black/55" : ""}
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
                  className="text-xs font-semibold text-[#e4252c]"
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
                className={!slugEditable ? "bg-[#f4f4f5] text-black/55" : ""}
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
                <IntegerProductInput value={product.vehicle_year_start} onChange={(value) => onField("vehicle_year_start", value)} />
              </Field>
              <Field label="Año final">
                <IntegerProductInput value={product.vehicle_year_end} onChange={(value) => onField("vehicle_year_end", value)} />
              </Field>
            </div>

            <Field label="Descripción">
              <textarea
                value={product.description}
                onChange={(event) => onField("description", event.target.value)}
                className="min-h-28 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
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
              {canAdjustStock ? (
                <Field label="Stock">
                  <IntegerProductInput value={product.stock} onChange={(value) => onField("stock", value)} />
                </Field>
              ) : (
                <Field label="Stock">
                  <div className="rounded-md border border-black/10 bg-[#f4f4f5] px-3 py-2 text-sm font-semibold">
                    {product.id ? product.stock : 0}
                    <span className="ml-2 block font-normal text-black/50">{product.id ? "Se conservará" : "Stock inicial 0"}</span>
                  </div>
                </Field>
              )}
              <Field label="Stock mínimo">
                <IntegerProductInput value={product.min_stock} onChange={(value) => onField("min_stock", value)} />
              </Field>
              <Field label="Cantidad mínima mayorista">
                <IntegerProductInput value={product.wholesale_min_quantity} onChange={(value) => onField("wholesale_min_quantity", value)} />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Precio de costo">
                <DecimalProductInput value={product.cost_price} onChange={(value) => onField("cost_price", value)} />
              </Field>
              <Field label="Precio al detalle">
                <DecimalProductInput value={product.retail_price} onChange={(value) => onField("retail_price", value)} />
              </Field>
              <Field label="Precio mayorista">
                <DecimalProductInput value={product.wholesale_price} onChange={(value) => onField("wholesale_price", value)} />
              </Field>
            </div>
            </div>
          </div>

          {canManageImages ? (
          <FormSection
            title="Imágenes del producto"
            description="Sube la imagen principal y, si hace falta, imágenes adicionales para la galería."
            className="self-start"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold">Imagen principal</h3>
                <p className="text-xs text-black/50">{productImageHelpText}</p>
              </div>
              <Button onClick={onAddImage} disabled={product.images.length >= maxProductImages} variant="ghost" className="px-3">
                <Plus size={16} />
                Agregar otra imagen
              </Button>
            </div>
            <p className="hidden text-xs text-black/50">
              Sube de 3 a 5 imágenes JPG, PNG o WEBP. La tienda servirá versiones optimizadas desde Cloudinary.
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
                    {index === 0 ? <span className="rounded-md bg-[#fff1f2] px-2 py-1 text-xs text-[#b91c25]">Principal</span> : null}
                  </div>
                  <div className="grid aspect-[4/3] place-items-center overflow-hidden rounded-md border border-black/10 bg-[#f4f4f5]">
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
                  <div className="grid grid-cols-3 gap-2">
                    <a
                      href={previewUrl || "#"}
                      target="_blank"
                      rel="noreferrer"
                      aria-disabled={!previewUrl}
                      className={`inline-flex items-center justify-center rounded-md border border-black/10 px-3 py-2 text-xs font-semibold ${
                        previewUrl ? "bg-white text-[#080808]" : "pointer-events-none bg-[#f4f4f5] text-black/35"
                      }`}
                    >
                      Ver preview
                    </a>
                    <button
                      type="button"
                      onClick={() => onPrimaryImage(index)}
                      disabled={!image.public_url || image.is_primary}
                      className="inline-flex items-center justify-center gap-1 rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <Star size={13} />
                      Principal
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveImage(index)}
                      className="inline-flex items-center justify-center gap-1 rounded-md border border-[#e4252c]/30 bg-[#fff7ed] px-3 py-2 text-xs font-semibold text-[#9b341b]"
                    >
                      <Trash2 size={13} />
                      Eliminar
                    </button>
                  </div>
                  <label
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      onUploadImage(index, event.dataTransfer.files?.[0] ?? null);
                    }}
                    className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-black/20 bg-[#f4f4f5] px-3 py-4 text-center text-sm font-medium"
                  >
                    {isUploading ? <Loader2 size={18} className="animate-spin" /> : <FileImage size={18} />}
                    <span>{isUploading ? "Subiendo imagen..." : image.public_url ? "Cambiar imagen" : uploadLabel}</span>
                    <span className="text-xs font-normal text-black/50">También puedes arrastrar la imagen aquí.</span>
                    <span className="text-xs font-normal text-black/50">{productImageHelpText}</span>
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
                            ? "bg-[#fff1f2] text-[#b91c25]"
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
                    <Field label="Tipo/ángulo" help="Opcional. Ayuda a ordenar la galería.">
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
          ) : (
          <FormSection title="Imágenes del producto" description="Solo lectura para este perfil.">
            <p className="rounded-md bg-[#f4f4f5] px-3 py-2 text-sm text-black/60">
              No tienes permiso para agregar, reemplazar ni eliminar imágenes.
            </p>
          </FormSection>
          )}
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


