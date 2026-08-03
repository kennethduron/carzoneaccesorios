export type ProductStatus = "active" | "inactive" | "draft" | "archived";
export type ProductTaxCategory = "standard" | "exempt";

export type ProductImageInput = {
  id?: string;
  public_url: string;
  storage_path?: string;
  public_id?: string;
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
  short_description: string | null;
  description: string;
  features: string | null;
  specifications: string | null;
  compatibility_notes: string | null;
  stock: number;
  min_stock: number;
  cost_price: number;
  retail_price: number;
  wholesale_price: number;
  wholesale_min_quantity: number;
  tax_category: ProductTaxCategory;
  tracks_inventory: boolean;
  product_sales_version: number;
  is_new: boolean;
  status: ProductStatus;
  active: boolean;
  reserved_stock: number;
  available_stock: number;
  auto_disabled_by_stock: boolean;
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
  short_description: string | null;
  description: string;
  features: string | null;
  specifications: string | null;
  compatibility_notes: string | null;
  stock: number;
  min_stock: number;
  cost_price: number;
  retail_price: number;
  wholesale_price: number;
  wholesale_min_quantity: number;
  tax_category: ProductTaxCategory;
  tracks_inventory: boolean;
  is_new: boolean;
  status: ProductStatus;
  active: boolean;
  images: ProductImageInput[];
};

export type CategoryOption = {
  id: string;
  name: string;
  slug: string;
};
