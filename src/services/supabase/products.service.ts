import { getSupabaseServerClient } from "@/lib/supabase-server";
import { products as fallbackProducts } from "@/lib/commerce";
import type { Product, ProductAngle, ProductAngleImage } from "@/types/commerce";

export type ProductCatalogFilters = {
  page?: number;
  pageSize?: number;
  query?: string;
  category?: string;
};

export type ProductCatalogPage = {
  products: Product[];
  total: number;
  page: number;
  pageSize: number;
  categories: Array<{ name: string; slug: string; count?: number }>;
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
    image: images[0]?.url ?? "/window.svg",
    images,
    stock: toNumber(row.stock),
    retail_price: toNumber(row.retail_price),
    wholesale_price: toNumber(row.wholesale_price),
    description: row.description,
  };
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

    const pagedProductsQuery = productsQuery
      .order("name", { ascending: true })
      .range(from, to)
      .returns<CatalogProductRow[]>();

    const [{ data, error, count }, { data: categories, error: categoriesError }] = await Promise.all([
      pagedProductsQuery,
      supabase
        .from("categories")
        .select("name, slug")
        .eq("active", true)
        .order("name", { ascending: true })
        .returns<CategoryRow[]>(),
    ]);

    if (error) {
      throw new Error(error.message);
    }

    if (categoriesError) {
      throw new Error(categoriesError.message);
    }

    return {
      products: (data ?? []).map(normalizeProduct),
      total: count ?? 0,
      page,
      pageSize,
      categories: categories ?? [],
    };
  } catch {
    const filtered = fallbackProducts.filter((product) => {
      const matchesQuery = query
        ? `${product.name} ${product.sku} ${product.brand}`.toLowerCase().includes(query.toLowerCase())
        : true;
      const matchesCategory = category ? product.category.toLowerCase().replaceAll(" ", "-") === category : true;
      return matchesQuery && matchesCategory;
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
