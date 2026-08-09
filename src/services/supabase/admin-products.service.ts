import {
  getOfficialProductCategory,
  normalizeImportedProductCategoryName,
  officialProductCategories,
  sortOfficialProductCategories,
} from "@/lib/product-categories";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import type { CategoryOption, ProductAdminRow, ProductStatus } from "@/types/products";
import { normalizeVehicleBrand, normalizeVehicleModel, suggestedVehicleBrands, uniqueVehicleValues } from "@/utils/vehicle-compatibility";

export type AdminProductCatalogFilters = {
  page?: number;
  pageSize?: number;
  query?: string;
  status?: string;
  categoryId?: string;
};

export type AdminProductCatalogSummary = {
  activeProducts: number;
  lowStockProducts: number;
  inventoryCost: number | null;
};

type ProductQueryRow = Omit<ProductAdminRow, "category_name" | "images" | "cost_price"> & {
  cost_price?: number | null;
  categories: { name: string } | null;
  product_images?: ProductAdminRow["images"] | null;
};

type ProductSummaryRow = {
  active: boolean;
  stock: number | null;
  min_stock: number | null;
  cost_price?: number | null;
};

type ProductVehicleOptionRow = {
  vehicle_brand: string | null;
  vehicle_model: string | null;
};

type ProductCatalogFilterContract = {
  searchExpression: string | null;
  status: ProductStatus | "all";
  categoryId: string | "all";
};

type CatalogFilterBuilder = {
  or(filters: string): CatalogFilterBuilder;
  eq(column: string, value: string): CatalogFilterBuilder;
};

const productStatuses = new Set<ProductStatus>(["active", "inactive", "draft", "archived"]);
const catalogChunkSize = 1_000;
export const MAX_PRODUCT_EXPORT_ROWS = 5_000;

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function normalizeProduct(row: ProductQueryRow): ProductAdminRow {
  return {
    id: row.id,
    category_id: row.category_id,
    category_name: normalizeImportedProductCategoryName(row.categories?.name),
    sku: row.sku,
    internal_code: row.internal_code,
    slug: row.slug,
    name: row.name,
    brand: row.brand,
    vehicle_brand: normalizeVehicleBrand(row.vehicle_brand),
    vehicle_model: normalizeVehicleModel(row.vehicle_model),
    vehicle_year_start: row.vehicle_year_start,
    vehicle_year_end: row.vehicle_year_end,
    short_description: row.short_description,
    description: row.description,
    features: row.features,
    specifications: row.specifications,
    compatibility_notes: row.compatibility_notes,
    stock: toNumber(row.stock),
    min_stock: toNumber(row.min_stock),
    ...(typeof row.cost_price === "number" ? { cost_price: toNumber(row.cost_price) } : {}),
    retail_price: toNumber(row.retail_price),
    wholesale_price: toNumber(row.wholesale_price),
    wholesale_min_quantity: toNumber(row.wholesale_min_quantity),
    tax_category: row.tax_category,
    tracks_inventory: Boolean(row.tracks_inventory),
    product_sales_version: toNumber(row.product_sales_version),
    is_new: Boolean(row.is_new),
    status: row.status,
    active: row.active,
    reserved_stock: toNumber(row.reserved_stock),
    available_stock: toNumber(row.available_stock),
    auto_disabled_by_stock: Boolean(row.auto_disabled_by_stock),
    created_at: row.created_at,
    updated_at: row.updated_at,
    images: row.product_images ?? [],
  };
}

export async function getAdminProductCatalog() {
  return getAdminProductCatalogPage();
}

function normalizePage(value: unknown) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value: unknown) {
  const pageSize = Number(value);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return 50;
  }

  return Math.min(Math.floor(pageSize), 100);
}

function sanitizePostgrestSearch(value: string) {
  return value.replace(/[(),]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeComparable(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

async function getCatalogCategories() {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("categories")
    .select("id, name, slug")
    .eq("active", true)
    .in("slug", officialProductCategories.map((category) => category.slug))
    .returns<CategoryOption[]>();

  if (error) {
    throw new Error(error.message);
  }

  return sortOfficialProductCategories(data ?? []);
}

function createProductCatalogFilterContract(
  filters: AdminProductCatalogFilters,
  categories: CategoryOption[],
): ProductCatalogFilterContract {
  const query = filters.query?.trim() ?? "";
  const requestedStatus = filters.status?.trim() ?? "all";
  const requestedCategoryId = filters.categoryId?.trim() ?? "all";

  if (requestedStatus !== "all" && !productStatuses.has(requestedStatus as ProductStatus)) {
    throw new Error("El filtro de estado no es válido.");
  }

  if (requestedCategoryId !== "all" && !categories.some((category) => category.id === requestedCategoryId)) {
    throw new Error("El filtro de categoría no es válido.");
  }

  let searchExpression: string | null = null;
  if (query) {
    const search = sanitizePostgrestSearch(query);
    if (search) {
      const normalizedSearch = normalizeComparable(search);
      const aliasedCategory = getOfficialProductCategory(search);
      const matchingCategoryIds = categories
        .filter(
          (category) =>
            normalizeComparable(category.name).includes(normalizedSearch) ||
            normalizeComparable(category.slug).includes(normalizedSearch) ||
            category.slug === aliasedCategory?.slug,
        )
        .map((category) => category.id);
      const searchConditions = [
        `sku.ilike.%${search}%`,
        `internal_code.ilike.%${search}%`,
        `name.ilike.%${search}%`,
        `brand.ilike.%${search}%`,
        `vehicle_brand.ilike.%${search}%`,
        `vehicle_model.ilike.%${search}%`,
        `short_description.ilike.%${search}%`,
        `description.ilike.%${search}%`,
        `features.ilike.%${search}%`,
        `specifications.ilike.%${search}%`,
        `compatibility_notes.ilike.%${search}%`,
      ];

      if (matchingCategoryIds.length > 0) {
        searchConditions.push(`category_id.in.(${matchingCategoryIds.join(",")})`);
      }
      searchExpression = searchConditions.join(",");
    }
  }

  return {
    searchExpression,
    status: requestedStatus as ProductStatus | "all",
    categoryId: requestedCategoryId,
  };
}

function applyProductCatalogFilters<TBuilder>(builder: TBuilder, contract: ProductCatalogFilterContract): TBuilder {
  let filtered = builder as unknown as CatalogFilterBuilder;
  if (contract.searchExpression) {
    filtered = filtered.or(contract.searchExpression);
  }
  if (contract.status !== "all") {
    filtered = filtered.eq("status", contract.status);
  }
  if (contract.categoryId !== "all") {
    filtered = filtered.eq("category_id", contract.categoryId);
  }
  return filtered as unknown as TBuilder;
}

function productSelection(includeCost: boolean, includeImages: boolean) {
  return `
      id,
      category_id,
      sku,
      internal_code,
      slug,
      name,
      brand,
      vehicle_brand,
      vehicle_model,
      vehicle_year_start,
      vehicle_year_end,
      short_description,
      description,
      features,
      specifications,
      compatibility_notes,
      stock,
      min_stock,
      ${includeCost ? "cost_price," : ""}
      retail_price,
      wholesale_price,
      wholesale_min_quantity,
      tax_category,
      tracks_inventory,
      product_sales_version,
      is_new,
      status,
      active,
      reserved_stock,
      available_stock,
      auto_disabled_by_stock,
      created_at,
      updated_at,
      categories(name)
      ${includeImages ? `,
      product_images(
        id,
        public_url,
        storage_path,
        public_id,
        angle,
        alt_text,
        sort_order,
        is_primary
      )` : ""}
    `;
}

async function getCatalogSummary(
  contract: ProductCatalogFilterContract,
  total: number,
  includeCost: boolean,
): Promise<AdminProductCatalogSummary> {
  const rows: ProductSummaryRow[] = [];
  for (let from = 0; from < total; from += catalogChunkSize) {
    const supabase = getSupabaseAdminClient();
    const selection = includeCost ? "active, stock, min_stock, cost_price" : "active, stock, min_stock";
    const query = applyProductCatalogFilters(
      supabase.from("products").select(selection),
      contract,
    )
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, Math.min(from + catalogChunkSize - 1, total - 1))
      .returns<ProductSummaryRow[]>();
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
  }

  return {
    activeProducts: rows.filter((product) => product.active).length,
    lowStockProducts: rows.filter((product) => toNumber(product.stock) <= toNumber(product.min_stock)).length,
    inventoryCost: includeCost
      ? Number(rows.reduce((sum, product) => sum + toNumber(product.cost_price) * toNumber(product.stock), 0).toFixed(2))
      : null,
  };
}

export async function getAdminProductCatalogPage(
  filters: AdminProductCatalogFilters = {},
  options: { includeCost?: boolean } = {},
) {
  const supabase = getSupabaseAdminClient();
  const page = normalizePage(filters.page);
  const pageSize = normalizePageSize(filters.pageSize);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const includeCost = options.includeCost === true;
  const categories = await getCatalogCategories();
  const contract = createProductCatalogFilterContract(filters, categories);

  const productsQuery = applyProductCatalogFilters(
    supabase.from("products").select(productSelection(includeCost, true), { count: "exact" }),
    contract,
  )
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to)
    .returns<ProductQueryRow[]>();

  const [{ data: products, error: productsError, count }, { data: vehicleRows, error: vehicleRowsError }] = await Promise.all([
    productsQuery,
    supabase.from("products").select("vehicle_brand, vehicle_model").returns<ProductVehicleOptionRow[]>(),
  ]);

  if (productsError) throw new Error(productsError.message);
  if (vehicleRowsError) throw new Error(vehicleRowsError.message);

  const total = count ?? 0;
  const summary = await getCatalogSummary(contract, total, includeCost);

  return {
    products: (products ?? []).map(normalizeProduct),
    categories,
    vehicleBrands: uniqueVehicleValues([...suggestedVehicleBrands, ...(vehicleRows ?? []).map((row) => row.vehicle_brand)], "brand"),
    vehicleModels: uniqueVehicleValues((vehicleRows ?? []).map((row) => row.vehicle_model), "model"),
    total,
    page,
    pageSize,
    summary,
  };
}

export async function getAdminProductCatalogExport(
  filters: AdminProductCatalogFilters = {},
  options: { includeCost?: boolean } = {},
) {
  const includeCost = options.includeCost === true;
  const categories = await getCatalogCategories();
  const contract = createProductCatalogFilterContract(filters, categories);
  const rows: ProductQueryRow[] = [];
  let total = 0;

  for (let from = 0; from === 0 || from < total; from += catalogChunkSize) {
    const supabase = getSupabaseAdminClient();
    const query = applyProductCatalogFilters(
      supabase.from("products").select(productSelection(includeCost, false), from === 0 ? { count: "exact" } : undefined),
      contract,
    )
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + catalogChunkSize - 1)
      .returns<ProductQueryRow[]>();
    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    if (from === 0) {
      total = count ?? 0;
      if (total > MAX_PRODUCT_EXPORT_ROWS) {
        throw new Error(`La exportación contiene ${total.toLocaleString("es-HN")} productos y supera el límite explícito de 5,000.`);
      }
    }
    rows.push(...(data ?? []));
  }

  if (rows.length !== total) {
    throw new Error(`La exportación esperaba ${total} productos, pero solo pudo recuperar ${rows.length}. No se generó un archivo truncado.`);
  }

  return { products: rows.map(normalizeProduct), total };
}
