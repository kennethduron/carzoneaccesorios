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
  description: string;
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
  paymentMethod: "Transferencia bancaria" | "Tarjeta" | "Efectivo";
  bankTransferReference: string;
};
