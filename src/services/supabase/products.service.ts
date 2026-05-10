import { getSupabaseServerClient } from "@/lib/supabase-server";
import { products as fallbackProducts } from "@/lib/commerce";
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
  product_images: ProductImageRow[] | null;
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

function normalizeImages(product: CatalogProductRow): ProductAngleImage[] {
  return (product.product_images ?? [])
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

function normalizeProduct(row: CatalogProductRow): Product {
  const images = normalizeImages(row);

  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    slug: row.slug,
    category: row.categories?.name ?? "Sin categoria",
    brand: row.brand,
    vehicle_brand: row.vehicle_brand,
    vehicle_model: row.vehicle_model,
    vehicle_year_start: row.vehicle_year_start,
    vehicle_year_end: row.vehicle_year_end,
    image: images[0]?.url ?? "/window.svg",
    images,
    stock: toNumber(row.stock),
    retail_price: toNumber(row.retail_price),
    wholesale_price: toNumber(row.wholesale_price),
    description: row.description,
  };
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
    const supabase = await getSupabaseServerClient();
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
        categories!inner(name, slug),
        product_images(
          id,
          public_url,
          angle,
          alt_text,
          sort_order,
          is_primary
        )
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

    const [{ data, error, count }, { data: categories, error: categoriesError }, { data: filterRows, error: filterError }] = await Promise.all([
      pagedProductsQuery,
      supabase
        .from("categories")
        .select("name, slug")
        .eq("active", true)
        .order("name", { ascending: true })
        .returns<CategoryRow[]>(),
      supabase
        .from("products")
        .select("vehicle_brand, vehicle_model, vehicle_year_start, vehicle_year_end")
        .eq("active", true)
        .returns<ProductFilterOptionRow[]>(),
    ]);

    if (error) {
      throw new Error(error.message);
    }

    if (categoriesError) {
      throw new Error(categoriesError.message);
    }

    if (filterError) {
      throw new Error(filterError.message);
    }

    return {
      products: (data ?? []).map(normalizeProduct),
      total: count ?? 0,
      page,
      pageSize,
      categories: categories ?? [],
      filterOptions: {
        vehicleBrands: uniqueSorted((filterRows ?? []).map((row) => row.vehicle_brand)),
        vehicleModels: uniqueSorted((filterRows ?? []).map((row) => row.vehicle_model)),
        vehicleYears: buildVehicleYears(filterRows ?? []),
      },
    };
  } catch {
    const filtered = fallbackProducts.filter((product) => {
      const matchesQuery = query
        ? `${product.name} ${product.sku} ${product.brand} ${product.vehicle_brand ?? ""} ${product.vehicle_model ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase())
        : true;
      const matchesCategory = category ? product.category.toLowerCase().replaceAll(" ", "-") === category : true;
      const matchesMinPrice = minPrice === null || product.retail_price >= minPrice;
      const matchesMaxPrice = maxPrice === null || product.retail_price <= maxPrice;
      const matchesVehicleBrand = vehicleBrand ? product.vehicle_brand?.toLowerCase() === vehicleBrand.toLowerCase() : true;
      const matchesVehicleModel = vehicleModel ? product.vehicle_model?.toLowerCase() === vehicleModel.toLowerCase() : true;
      const matchesVehicleYear =
        vehicleYear === null ||
        ((!product.vehicle_year_start || product.vehicle_year_start <= vehicleYear) &&
          (!product.vehicle_year_end || product.vehicle_year_end >= vehicleYear));
      return (
        matchesQuery &&
        matchesCategory &&
        matchesMinPrice &&
        matchesMaxPrice &&
        matchesVehicleBrand &&
        matchesVehicleModel &&
        matchesVehicleYear
      );
    });

    return {
      products: filtered.slice(from, to + 1),
      total: filtered.length,
      page,
      pageSize,
      categories: Array.from(new Set(fallbackProducts.map((product) => product.category))).map((name) => ({
        name,
        slug: name.toLowerCase().replaceAll(" ", "-"),
      })),
      filterOptions: {
        vehicleBrands: uniqueSorted(fallbackProducts.map((product) => product.vehicle_brand)),
        vehicleModels: uniqueSorted(fallbackProducts.map((product) => product.vehicle_model)),
        vehicleYears: buildVehicleYears(fallbackProducts),
      },
    };
  }
}

export async function getFeaturedProducts(limit = 3) {
  const page = await getCatalogProducts({ page: 1, pageSize: limit });
  return page.products;
}

export async function getProductBySlug(slug: string) {
  try {
    const supabase = await getSupabaseServerClient();
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
  } catch {
    return fallbackProducts.find((product) => product.slug === slug) ?? null;
  }
}

export async function getCategorySummaries() {
  const catalog = await getCatalogProducts({ pageSize: 1 });
  return catalog.categories.map((category) => ({
    ...category,
    count: category.count,
  }));
}
