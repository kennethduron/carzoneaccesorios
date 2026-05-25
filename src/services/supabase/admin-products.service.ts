import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { CategoryOption, ProductAdminRow } from "@/types/products";
import { normalizeVehicleBrand, normalizeVehicleModel, suggestedVehicleBrands, uniqueVehicleValues } from "@/utils/vehicle-compatibility";

export type AdminProductCatalogFilters = {
  page?: number;
  pageSize?: number;
  query?: string;
  status?: string;
  categoryId?: string;
};

type ProductQueryRow = Omit<ProductAdminRow, "category_name" | "images"> & {
  categories: { name: string } | null;
  product_images: ProductAdminRow["images"] | null;
};

type ProductVehicleOptionRow = {
  vehicle_brand: string | null;
  vehicle_model: string | null;
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function normalizeProduct(row: ProductQueryRow): ProductAdminRow {
  return {
    id: row.id,
    category_id: row.category_id,
    category_name: row.categories?.name ?? null,
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
    cost_price: toNumber(row.cost_price),
    retail_price: toNumber(row.retail_price),
    wholesale_price: toNumber(row.wholesale_price),
    wholesale_min_quantity: toNumber(row.wholesale_min_quantity),
    status: row.status,
    active: row.active,
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

export async function getAdminProductCatalogPage(filters: AdminProductCatalogFilters = {}) {
  const supabase = await getSupabaseServerClient();
  const page = normalizePage(filters.page);
  const pageSize = normalizePageSize(filters.pageSize);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const query = filters.query?.trim() ?? "";
  const status = filters.status?.trim() ?? "all";
  const categoryId = filters.categoryId?.trim() ?? "all";

  let productsQuery = supabase
    .from("products")
    .select(
      `
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
      cost_price,
      retail_price,
      wholesale_price,
      wholesale_min_quantity,
      status,
      active,
      created_at,
      updated_at,
      categories(name),
      product_images(
        id,
        public_url,
        storage_path,
        public_id,
        angle,
        alt_text,
        sort_order,
        is_primary
      )
    `,
      { count: "exact" },
    );

  if (query) {
    const search = sanitizePostgrestSearch(query);
    if (search) {
      productsQuery = productsQuery.or(
        `sku.ilike.%${search}%,internal_code.ilike.%${search}%,name.ilike.%${search}%,brand.ilike.%${search}%,vehicle_brand.ilike.%${search}%,vehicle_model.ilike.%${search}%,short_description.ilike.%${search}%,description.ilike.%${search}%,features.ilike.%${search}%,specifications.ilike.%${search}%,compatibility_notes.ilike.%${search}%`,
      );
    }
  }

  if (status !== "all") {
    productsQuery = productsQuery.eq("status", status);
  }

  if (categoryId !== "all") {
    productsQuery = productsQuery.eq("category_id", categoryId);
  }

  const pagedProductsQuery = productsQuery
    .order("updated_at", { ascending: false })
    .range(from, to)
    .returns<ProductQueryRow[]>();

  const [
    { data: products, error: productsError, count },
    { data: categories, error: categoriesError },
    { data: vehicleRows, error: vehicleRowsError },
  ] =
    await Promise.all([
      pagedProductsQuery,
      supabase
        .from("categories")
        .select("id, name, slug")
        .order("name", { ascending: true })
        .returns<CategoryOption[]>(),
      supabase
        .from("products")
        .select("vehicle_brand, vehicle_model")
        .returns<ProductVehicleOptionRow[]>(),
    ]);

  if (productsError) {
    throw new Error(productsError.message);
  }

  if (categoriesError) {
    throw new Error(categoriesError.message);
  }

  if (vehicleRowsError) {
    throw new Error(vehicleRowsError.message);
  }

  return {
    products: (products ?? []).map(normalizeProduct),
    categories: categories ?? [],
    vehicleBrands: uniqueVehicleValues([...suggestedVehicleBrands, ...(vehicleRows ?? []).map((row) => row.vehicle_brand)], "brand"),
    vehicleModels: uniqueVehicleValues((vehicleRows ?? []).map((row) => row.vehicle_model), "model"),
    total: count ?? 0,
    page,
    pageSize,
  };
}
