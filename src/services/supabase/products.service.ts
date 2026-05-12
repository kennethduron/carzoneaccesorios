import { unstable_cache } from "next/cache";
import { writeErrorLog } from "@/lib/error-logging";
import { getSupabasePublicClient } from "@/lib/supabase";
import type { Product, ProductAngle, ProductAngleImage } from "@/types/commerce";

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
  };
};

const defaultPageSize = 24;
const validAngles: ProductAngle[] = ["frontal", "lateral", "trasera", "superior", "detalle"];

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
  sku: string;
  slug: string;
  name: string;
  brand: string;
  vehicle_brand: string | null;
  vehicle_model: string | null;
  vehicle_year_start: number | null;
  vehicle_year_end: number | null;
  description: string;
  stock: number;
  retail_price: unknown;
  wholesale_price: unknown;
  categories: {
    name: string;
    slug: string;
  } | null;
  product_images?: ProductImageRow[] | null;
};

type CategoryRow = {
  name: string;
  slug: string;
};

type ProductFilterOptionRow = {
  vehicle_brand: string | null;
  vehicle_model: string | null;
  vehicle_year_start: number | null;
  vehicle_year_end: number | null;
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
    category: row.categories?.name ?? "Sin categoría",
    brand: row.brand,
    vehicle_brand: row.vehicle_brand,
    vehicle_model: row.vehicle_model,
    vehicle_year_start: row.vehicle_year_start,
    vehicle_year_end: row.vehicle_year_end,
    image: normalizedImages[0]?.url ?? "/window.svg",
    images: normalizedImages,
    stock: toNumber(row.stock),
    retail_price: toNumber(row.retail_price),
    wholesale_price: toNumber(row.wholesale_price),
    description: row.description,
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

function uniqueSorted(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])).sort((left, right) =>
    left.localeCompare(right, "es-HN"),
  );
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

const getCachedActiveCategories = unstable_cache(
  async () => {
    const supabase = getSupabasePublicClient();
    const { data, error } = await supabase
      .from("categories")
      .select("name, slug")
      .eq("active", true)
      .order("name", { ascending: true })
      .returns<CategoryRow[]>();

    if (error) {
      throw new Error(error.message);
    }

    return data ?? [];
  },
  ["active-categories"],
  { revalidate: 3600, tags: ["categories"] },
);

const getCachedProductFilterOptions = unstable_cache(
  async () => {
    const supabase = getSupabasePublicClient();
    const { data, error } = await supabase
      .from("products")
      .select("vehicle_brand, vehicle_model, vehicle_year_start, vehicle_year_end")
      .eq("active", true)
      .returns<ProductFilterOptionRow[]>();

    if (error) {
      throw new Error(error.message);
    }

    return data ?? [];
  },
  ["product-filter-options"],
  { revalidate: 3600, tags: ["products", "vehicle-filters"] },
);

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
  const vehicleBrand = filters.vehicleBrand?.trim() ?? "";
  const vehicleModel = filters.vehicleModel?.trim() ?? "";
  const vehicleYear = normalizeOptionalNumber(filters.vehicleYear);

  try {
    const supabase = getSupabasePublicClient();
    let productsQuery = supabase
      .from("products")
      .select(
        `
        id,
        sku,
        slug,
        name,
        brand,
        vehicle_brand,
        vehicle_model,
        vehicle_year_start,
        vehicle_year_end,
        description,
        stock,
        retail_price,
        wholesale_price,
        categories(name, slug)
      `,
        { count: "exact" },
      )
      .eq("active", true);

    if (query) {
      productsQuery = productsQuery.or(`sku.ilike.%${query}%,name.ilike.%${query}%,brand.ilike.%${query}%`);
    }

    if (category) {
      productsQuery = productsQuery.eq("categories.slug", category);
    }

    if (minPrice !== null) {
      productsQuery = productsQuery.gte("retail_price", minPrice);
    }

    if (maxPrice !== null) {
      productsQuery = productsQuery.lte("retail_price", maxPrice);
    }

    if (vehicleBrand) {
      productsQuery = productsQuery.ilike("vehicle_brand", vehicleBrand);
    }

    if (vehicleModel) {
      productsQuery = productsQuery.ilike("vehicle_model", vehicleModel);
    }

    if (vehicleYear !== null) {
      productsQuery = productsQuery.lte("vehicle_year_start", vehicleYear).gte("vehicle_year_end", vehicleYear);
    }

    const pagedProductsQuery = productsQuery
      .order("name", { ascending: true })
      .range(from, to)
      .returns<CatalogProductRow[]>();

    const [{ data, error, count }, categories, filterRows] = await Promise.all([
      pagedProductsQuery,
      getCachedActiveCategories(),
      getCachedProductFilterOptions(),
    ]);

    if (error) {
      throw new Error(error.message);
    }

    const imageByProduct = await getPrimaryImagesForProducts((data ?? []).map((product) => product.id));

    return {
      products: (data ?? []).map((product) => normalizeProduct(product, imageByProduct.get(product.id))),
      total: count ?? 0,
      page,
      pageSize,
      categories,
      filterOptions: {
        vehicleBrands: uniqueSorted(filterRows.map((row) => row.vehicle_brand)),
        vehicleModels: uniqueSorted(filterRows.map((row) => row.vehicle_model)),
        vehicleYears: buildVehicleYears(filterRows),
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
      },
    };
  }
}

export const getFeaturedProducts = unstable_cache(async (limit = 3) => {
  try {
    const supabase = getSupabasePublicClient();
    const { data, error } = await supabase
      .from("products")
      .select(
        `
        id,
        sku,
        slug,
        name,
        brand,
        vehicle_brand,
        vehicle_model,
        vehicle_year_start,
        vehicle_year_end,
        description,
        stock,
        retail_price,
        wholesale_price,
        categories(name, slug)
      `,
      )
      .eq("active", true)
      .order("updated_at", { ascending: false })
      .limit(limit)
      .returns<CatalogProductRow[]>();

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
        sku,
        slug,
        name,
        brand,
        vehicle_brand,
        vehicle_model,
        vehicle_year_start,
        vehicle_year_end,
        description,
        stock,
        retail_price,
        wholesale_price,
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

export async function getCategorySummaries() {
  try {
    return await getCachedActiveCategories();
  } catch {
    return [];
  }
}
