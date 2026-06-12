export type PriceMode = "retail" | "wholesale";

export type ProductAngle = "frontal" | "lateral" | "trasera" | "superior" | "detalle";

export type ProductAngleImage = {
  id: string;
  angle: ProductAngle;
  label: string;
  url: string;
  alt: string;
};

export type Product = {
  id: string;
  sku: string;
  name: string;
  slug: string;
  category_id: string | null;
  category: string;
  brand: string;
  vehicle_brand: string | null;
  vehicle_model: string | null;
  vehicle_year_start: number | null;
  vehicle_year_end: number | null;
  image: string;
  images: ProductAngleImage[];
  stock: number;
  retail_price: number;
  wholesale_price: number;
  wholesale_min_quantity: number;
  is_new: boolean;
  short_description: string | null;
  description: string;
  features: string | null;
  specifications: string | null;
  compatibility_notes: string | null;
};

export type CartItem = {
  productId: string;
  quantity: number;
  productSnapshot?: Product;
};

export type CheckoutData = {
  customerName: string;
  email: string;
  phone: string;
  rtn: string;
  country: string;
  department: string;
  city: string;
  address: string;
  paymentMethod: "Transferencia bancaria" | "Tarjeta" | "Tarjeta por link de pago" | "Tarjeta mediante enlace de pago" | "Efectivo";
  paymentTiming: "before_delivery" | "on_delivery";
  bankTransferReference: string;
  receiveOrderEmailUpdates: boolean;
};
