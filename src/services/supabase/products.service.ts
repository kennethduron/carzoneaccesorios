import { unstable_cache } from "next/cache";
import { writeErrorLog } from "@/lib/error-logging";
import { getSupabasePublicClient } from "@/lib/supabase";
import type { Product, ProductAngle, ProductAngleImage } from "@/types/commerce";
import {
  normalizeVehicleBrand,
  normalizeVehicleComparable,
  normalizeVehicleModel,
  suggestedVehicleBrands,
  uniqueVehicleValues,
} from "@/utils/vehicle-compatibility";

export type ProductCatalogFilters = {
  page?: number;
  pageSize?: number;
  query?: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  vehicleBrand?: string;
  vehicleModel?: string;
  vehicleYear?: number;
  availability?: string;
  priceMode?: "retail" | "wholesale";
};

export type ProductCatalogPage = {
  products: Product[];
  total: number;
  page: number;
  pageSize: number;
  categories: Array<{ name: string; slug: string; count?: number }>;
  filterOptions: {
    vehicleBrands: string[];
    vehicleModels: string[];
    vehicleYears: number[];
    vehicleOptions: ProductVehicleFilterOption[];
  };
};

export type ProductVehicleFilterOption = {
  vehicleBrand: string;
  vehicleModel: string;
  vehicleYearStart: number | null;
  vehicleYearEnd: number | null;
};

const defaultPageSize = 24;
const validAngles: ProductAngle[] = ["frontal", "lateral", "trasera", "superior", "detalle"];
const preferredCompatibilityBrands = suggestedVehicleBrands;
const invalidVehicleOptionValues = new Set(["", "n/a", "na", "no aplica", "todos", "todo", "all", "none", "null", "sin marca", "sin modelo", "universal"]);

type ProductImageRow = {
  id: string;
  product_id: string;
  public_url: string | null;
  angle: string;
  alt_text: string | null;
  sort_order: number;
  is_primary: boolean;
};

type CatalogProductRow = {
  id: string;
  category_id: string | null;
  sku: string;
  internal_code?: string | null;
  slug: string;
  name: string;
  brand: string;
  vehicle_brand: string | null;
  vehicle_model: string | null;
  vehicle_year_start: number | null;
  vehicle_year_end: number | null;
  short_description: string | null;
  description: string;
  features: string | null;
  specifications: string | null;
  compatibility_notes: string | null;
  stock: number;
  available_stock?: number | null;
  retail_price: unknown;
  wholesale_price: unknown;
  is_new?: boolean | null;
  categories: {
    name: string;
    slug: string;
  } | null;
  product_images?: ProductImageRow[] | null;
};

type CategoryRow = {
  id: string;
  name: string;
  slug: string;
};

type ProductFilterOptionRow = {
  vehicle_brand: string | null;
  vehicle_model: string | null;
  vehicle_year_start: number | null;
  vehicle_year_end: number | null;
};

type CatalogSettingsRow = {
  out_of_stock_catalog_mode: "show" | "hide" | null;
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function normalizePage(value: unknown) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value: unknown) {
  const pageSize = Number(value);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return defaultPageSize;
  }

  return Math.min(Math.floor(pageSize), 48);
}

function normalizeOptionalNumber(value: unknown) {
  if (typeof value === "string" && !value.trim()) {
    return null;
  }

  if (value === undefined || value === null) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAngle(value: string): ProductAngle {
  return validAngles.includes(value as ProductAngle) ? (value as ProductAngle) : "frontal";
}

function normalizeImages(
  product: CatalogProductRow,
  images = product.product_images ?? [],
): ProductAngleImage[] {
  return images
    .filter((image) => image.public_url)
    .sort((left, right) => Number(right.is_primary) - Number(left.is_primary) || left.sort_order - right.sort_order)
    .map((image) => ({
      id: image.id,
      angle: normalizeAngle(image.angle),
      label: image.angle || "Principal",
      url: image.public_url ?? "",
      alt: image.alt_text ?? product.name,
    }));
}

function normalizeProduct(row: CatalogProductRow, images?: ProductImageRow[]): Product {
  const normalizedImages = normalizeImages(row, images);

  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    slug: row.slug,
    category_id: row.category_id,
    category: row.categories?.name ?? "Sin categoría",
    brand: row.brand,
    vehicle_brand: normalizeVehicleBrand(row.vehicle_brand),
    vehicle_model: normalizeVehicleModel(row.vehicle_model),
    vehicle_year_start: row.vehicle_year_start,
    vehicle_year_end: row.vehicle_year_end,
    image: normalizedImages[0]?.url ?? "/window.svg",
    images: normalizedImages,
    stock: toNumber(row.available_stock ?? row.stock),
    retail_price: toNumber(row.retail_price),
    wholesale_price: toNumber(row.wholesale_price),
    is_new: Boolean(row.is_new),
    short_description: row.short_description,
    description: row.description,
    features: row.features,
    specifications: row.specifications,
    compatibility_notes: row.compatibility_notes,
  };
}

async function logProductServiceError(action: string, error: unknown, metadata?: Record<string, unknown>) {
  const message = error instanceof Error ? error.message : "Unknown product service error";
  const stack = error instanceof Error ? error.stack : null;

  console.error(action, message);

  try {
    await writeErrorLog({
      route: "/catalogo",
      action,
      errorMessage: message,
      errorStack: stack,
      metadata: {
        source: "products.service",
        ...metadata,
      },
    });
  } catch (logError) {
    console.error("Product service error log failed", logError instanceof Error ? logError.message : logError);
  }
}

async function getPrimaryImagesForProducts(productIds: string[]) {
  if (productIds.length === 0) {
    return new Map<string, ProductImageRow[]>();
  }

  const supabase = getSupabasePublicClient();
  const { data, error } = await supabase
    .from("product_images")
    .select("id, product_id, public_url, angle, alt_text, sort_order, is_primary")
    .in("product_id", productIds)
    .eq("is_primary", true)
    .order("sort_order", { ascending: true })
    .returns<ProductImageRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const imageByProduct = new Map<string, ProductImageRow[]>();
  (data ?? []).forEach((image) => {
    if (!imageByProduct.has(image.product_id)) {
      imageByProduct.set(image.product_id, [image]);
    }
  });

  return imageByProduct;
}

function buildVehicleYears(products: ProductFilterOptionRow[]) {
  const years = new Set<number>();

  products.forEach((product) => {
    const start = product.vehicle_year_start;
    const end = product.vehicle_year_end;
    if (!start && !end) {
      return;
    }

    const firstYear = start ?? end;
    const lastYear = end ?? start;
    if (!firstYear || !lastYear) {
      return;
    }

    for (let year = firstYear; year <= lastYear; year += 1) {
      years.add(year);
    }
  });

  return Array.from(years).sort((left, right) => right - left);
}

function normalizeComparable(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeVehicleOption(value: string | null | undefined, kind: "brand" | "model") {
  const cleaned = value?.trim().replace(/\s+/g, " ") ?? "";
  const comparable = normalizeComparable(cleaned);

  if (invalidVehicleOptionValues.has(comparable)) {
    return null;
  }

  return kind === "brand" ? normalizeVehicleBrand(value) : normalizeVehicleModel(value);
}

function sanitizePostgrestSearch(value: string) {
  return value.replace(/[(),]/g, " ").replace(/\s+/g, " ").trim();
}

function buildVehicleOptions(rows: ProductFilterOptionRow[]): ProductVehicleFilterOption[] {
  const unique = new Map<string, ProductVehicleFilterOption>();

  rows.forEach((row) => {
    const vehicleBrand = normalizeVehicleOption(row.vehicle_brand, "brand");
    const vehicleModel = normalizeVehicleOption(row.vehicle_model, "model");

    if (!vehicleBrand) {
      return;
    }

    const option: ProductVehicleFilterOption = {
      vehicleBrand,
      vehicleModel: vehicleModel ?? "",
      vehicleYearStart: row.vehicle_year_start,
      vehicleYearEnd: row.vehicle_year_end,
    };
    unique.set(
      `${normalizeVehicleComparable(option.vehicleBrand)}|${normalizeVehicleComparable(option.vehicleModel)}|${option.vehicleYearStart ?? ""}|${option.vehicleYearEnd ?? ""}`,
      option,
    );
  });

  return Array.from(unique.values()).sort((left, right) => {
    const brandSort = left.vehicleBrand.localeCompare(right.vehicleBrand, "es-HN");
    return brandSort || left.vehicleModel.localeCompare(right.vehicleModel, "es-HN");
  });
}

async function getOutOfStockCatalogMode() {
  const supabase = getSupabasePublicClient();
  const { data } = await supabase
    .from("public_company_settings")
    .select("out_of_stock_catalog_mode")
    .maybeSingle<CatalogSettingsRow>();

  return data?.out_of_stock_catalog_mode === "hide" ? "hide" : "show";
}

async function getCachedActiveCategories() {
  const supabase = getSupabasePublicClient();
  const { data, error } = await supabase
    .from("categories")
    .select("id, name, slug")
    .eq("active", true)
    .order("name", { ascending: true })
    .returns<CategoryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

async function getCachedProductFilterOptions(outOfStockCatalogMode: "show" | "hide" = "show") {
  const supabase = getSupabasePublicClient();
  let query = supabase
    .from("products")
    .select("vehicle_brand, vehicle_model, vehicle_year_start, vehicle_year_end")
    .eq("active", true);

  if (outOfStockCatalogMode === "hide") {
    query = query.gt("available_stock", 0);
  }

  const { data, error } = await query.returns<ProductFilterOptionRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

export async function getActiveProducts() {
  const page = await getCatalogProducts({ pageSize: 48 });
  return { data: page.products, error: null };
}

export async function getCatalogProducts(filters: ProductCatalogFilters = {}): Promise<ProductCatalogPage> {
  const page = normalizePage(filters.page);
  const pageSize = normalizePageSize(filters.pageSize);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const query = filters.query?.trim() ?? "";
  const category = filters.category?.trim() ?? "";
  const minPrice = normalizeOptionalNumber(filters.minPrice);
  const maxPrice = normalizeOptionalNumber(filters.maxPrice);
  const vehicleBrand = normalizeVehicleBrand(filters.vehicleBrand) ?? "";
  const vehicleModel = normalizeVehicleModel(filters.vehicleModel) ?? "";
  const vehicleYear = normalizeOptionalNumber(filters.vehicleYear);
  const availability = filters.availability?.trim() ?? "";
  const priceColumn = filters.priceMode === "wholesale" ? "wholesale_price" : "retail_price";

  try {
    const [outOfStockCatalogMode, categories] = await Promise.all([getOutOfStockCatalogMode(), getCachedActiveCategories()]);
    const normalizedCategory = normalizeComparable(category);
    const selectedCategory = category
      ? categories.find((item) => item.slug === category || normalizeComparable(item.slug) === normalizedCategory || normalizeComparable(item.name) === normalizedCategory)
      : null;
    const supabase = getSupabasePublicClient();
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
        available_stock,
        retail_price,
        wholesale_price,
        is_new,
        categories(name, slug)
      `,
        { count: "exact" },
      )
      .eq("active", true);

    if (outOfStockCatalogMode === "hide") {
      productsQuery = productsQuery.gt("available_stock", 0);
    }

    if (query) {
      const search = sanitizePostgrestSearch(query);
      const normalizedSearch = normalizeComparable(search);
      const categoryMatches = normalizedSearch
        ? categories
            .filter((item) => normalizeComparable(item.name).includes(normalizedSearch) || normalizeComparable(item.slug).includes(normalizedSearch))
            .map((item) => item.id)
        : [];

      if (search || categoryMatches.length > 0) {
        const searchConditions = search
          ? [
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
            ]
          : [];

        if (categoryMatches.length > 0) {
          searchConditions.push(`category_id.in.(${categoryMatches.join(",")})`);
        }

        productsQuery = productsQuery.or(searchConditions.join(","));
      }
    }

    if (category) {
      productsQuery = selectedCategory ? productsQuery.eq("category_id", selectedCategory.id) : productsQuery.eq("category_id", "00000000-0000-0000-0000-000000000000");
    }

    if (minPrice !== null) {
      productsQuery = productsQuery.gte(priceColumn, minPrice);
    }

    if (maxPrice !== null) {
      productsQuery = productsQuery.lte(priceColumn, maxPrice);
    }

    if (vehicleBrand) {
      productsQuery = productsQuery.ilike("vehicle_brand", vehicleBrand);
    }

    if (vehicleModel) {
      productsQuery = productsQuery.ilike("vehicle_model", vehicleModel);
    }

    if (vehicleYear !== null) {
      productsQuery = productsQuery
        .or(`vehicle_year_start.is.null,vehicle_year_start.lte.${vehicleYear}`)
        .or(`vehicle_year_end.is.null,vehicle_year_end.gte.${vehicleYear}`);
    }

    if (availability === "disponible") {
      productsQuery = productsQuery.gt("available_stock", 0);
    }

    if (availability === "agotado") {
      productsQuery = productsQuery.lte("available_stock", 0);
    }

    const pagedProductsQuery = productsQuery
      .order("name", { ascending: true })
      .range(from, to)
      .returns<CatalogProductRow[]>();

    const [{ data, error, count }, filterRows] = await Promise.all([
      pagedProductsQuery,
      getCachedProductFilterOptions(outOfStockCatalogMode),
    ]);

    if (error) {
      throw new Error(error.message);
    }

    const imageByProduct = await getPrimaryImagesForProducts((data ?? []).map((product) => product.id));
    const vehicleOptions = buildVehicleOptions(filterRows);

    return {
      products: (data ?? []).map((product) => normalizeProduct(product, imageByProduct.get(product.id))),
      total: count ?? 0,
      page,
      pageSize,
      categories,
      filterOptions: {
        vehicleBrands: uniqueVehicleValues(vehicleOptions.map((row) => row.vehicleBrand), "brand"),
        vehicleModels: uniqueVehicleValues(vehicleOptions.map((row) => row.vehicleModel), "model"),
        vehicleYears: buildVehicleYears(filterRows),
        vehicleOptions,
      },
    };
  } catch (error) {
    await logProductServiceError("catalog.products.load_failed", error, { filters });
    return {
      products: [],
      total: 0,
      page,
      pageSize,
      categories: [],
      filterOptions: {
        vehicleBrands: [],
        vehicleModels: [],
        vehicleYears: [],
        vehicleOptions: [],
      },
    };
  }
}

export const getFeaturedProducts = unstable_cache(async (limit = 3) => {
  try {
    const outOfStockCatalogMode = await getOutOfStockCatalogMode();
    const supabase = getSupabasePublicClient();
    let query = supabase
      .from("products")
      .select(
        `
        id,
        category_id,
        sku,
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
        available_stock,
        retail_price,
        wholesale_price,
        is_new,
        categories(name, slug)
      `,
      )
      .eq("active", true);

    if (outOfStockCatalogMode === "hide") {
      query = query.gt("available_stock", 0);
    }

    const { data, error } = await query.order("updated_at", { ascending: false }).limit(limit).returns<CatalogProductRow[]>();

    if (error) {
      throw new Error(error.message);
    }

    const imageByProduct = await getPrimaryImagesForProducts((data ?? []).map((product) => product.id));
    return (data ?? []).map((product) => normalizeProduct(product, imageByProduct.get(product.id)));
  } catch (error) {
    await logProductServiceError("catalog.featured_products.load_failed", error, { limit });
    return [];
  }
}, ["featured-products"], { revalidate: 900, tags: ["products", "featured-products"] });

export async function getProductBySlug(slug: string) {
  try {
    const supabase = getSupabasePublicClient();
    const { data, error } = await supabase
      .from("products")
      .select(
        `
        id,
        category_id,
        sku,
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
        available_stock,
        retail_price,
        wholesale_price,
        is_new,
        categories(name, slug),
        product_images(
          id,
          public_url,
          angle,
          alt_text,
          sort_order,
          is_primary
        )
      `,
      )
      .eq("active", true)
      .eq("slug", slug)
      .maybeSingle<CatalogProductRow>();

    if (error) {
      throw new Error(error.message);
    }

    return data ? normalizeProduct(data) : null;
  } catch (error) {
    await logProductServiceError("catalog.product_detail.load_failed", error, { slug });
    return null;
  }
}

export async function getRelatedProducts(product: Product, limit = 4) {
  try {
    const supabase = getSupabasePublicClient();
    const relatedConditions = [
      product.category_id ? `category_id.eq.${product.category_id}` : null,
      product.brand && !product.brand.includes(",") ? `brand.eq.${product.brand}` : null,
      product.vehicle_brand && !product.vehicle_brand.includes(",") ? `vehicle_brand.eq.${product.vehicle_brand}` : null,
      product.vehicle_model && !product.vehicle_model.includes(",") ? `vehicle_model.eq.${product.vehicle_model}` : null,
    ].filter(Boolean);

    let query = supabase
      .from("products")
      .select(
        `
        id,
        category_id,
        sku,
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
        available_stock,
        retail_price,
        wholesale_price,
        is_new,
        categories(name, slug)
      `,
      )
      .eq("active", true)
      .neq("id", product.id)
      .gt("available_stock", 0);

    if (relatedConditions.length > 0) {
      query = query.or(relatedConditions.join(","));
    }

    const { data, error } = await query.order("updated_at", { ascending: false }).limit(limit).returns<CatalogProductRow[]>();

    if (error) {
      throw new Error(error.message);
    }

    const imageByProduct = await getPrimaryImagesForProducts((data ?? []).map((item) => item.id));
    return (data ?? []).map((item) => normalizeProduct(item, imageByProduct.get(item.id)));
  } catch (error) {
    await logProductServiceError("catalog.related_products.load_failed", error, { productId: product.id });
    return [];
  }
}

export async function getCategorySummaries() {
  try {
    return await getCachedActiveCategories();
  } catch {
    return [];
  }
}

export async function getCompatibilityBrandSummaries(limit = 12) {
  try {
    const outOfStockCatalogMode = await getOutOfStockCatalogMode();
    const filterRows = await getCachedProductFilterOptions(outOfStockCatalogMode);
    const brands = uniqueVehicleValues(buildVehicleOptions(filterRows).map((row) => row.vehicleBrand), "brand");
    const brandByNormalized = new Map(brands.map((brand) => [normalizeVehicleComparable(brand), brand]));
    const preferredBrands = preferredCompatibilityBrands
      .map((brand) => brandByNormalized.get(normalizeVehicleComparable(brand)))
      .filter(Boolean) as string[];
    const remainingBrands = brands.filter((brand) => !preferredBrands.some((preferred) => normalizeVehicleComparable(preferred) === normalizeVehicleComparable(brand)));

    return [...preferredBrands, ...remainingBrands].slice(0, limit);
  } catch (error) {
    await logProductServiceError("catalog.compatibility_brands.load_failed", error, { limit });
    return [];
  }
}

