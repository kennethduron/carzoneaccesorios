export type ProductStatus = "active" | "inactive" | "draft" | "archived";

export type ProductImageInput = {
  id?: string;
  public_url: string;
  storage_path?: string;
  angle: string;
  alt_text?: string;
  sort_order: number;
  is_primary: boolean;
};

export type ProductAdminRow = {
  id: string;
  category_id: string | null;
  category_name: string | null;
  sku: string;
  internal_code: string | null;
  slug: string;
  name: string;
  brand: string;
  vehicle_brand: string | null;
  vehicle_model: string | null;
  vehicle_year_start: number | null;
  vehicle_year_end: number | null;
  description: string;
  stock: number;
  min_stock: number;
  cost_price: number;
  retail_price: number;
  wholesale_price: number;
  wholesale_min_quantity: number;
  status: ProductStatus;
  active: boolean;
  created_at: string;
  updated_at: string;
  images: ProductImageInput[];
};

export type ProductFormInput = {
  id?: string;
  category_id: string | null;
  sku: string;
  internal_code: string | null;
  slug: string;
  name: string;
  brand: string;
  vehicle_brand: string | null;
  vehicle_model: string | null;
  vehicle_year_start: number | null;
  vehicle_year_end: number | null;
  description: string;
  stock: number;
  min_stock: number;
  cost_price: number;
  retail_price: number;
  wholesale_price: number;
  wholesale_min_quantity: number;
  status: ProductStatus;
  active: boolean;
  images: ProductImageInput[];
};

export type CategoryOption = {
  id: string;
  name: string;
  slug: string;
};
