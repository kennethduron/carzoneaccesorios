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
};

export type WholesaleAccount = {
  id: string;
  code: string;
  customerId: string | null;
  customerName: string;
  businessName: string;
  minimumOrder: number;
  expiresAt: string | null;
  usedCount: number;
  status: "active" | "inactive" | "expired" | "disabled";
};

export type CheckoutData = {
  customerName: string;
  email: string;
  phone: string;
  country: string;
  address: string;
  paymentMethod: "Transferencia bancaria" | "Tarjeta" | "Efectivo";
};

const imageAngles: Array<{ angle: ProductAngle; label: string }> = [
  { angle: "frontal", label: "Frontal" },
  { angle: "lateral", label: "Lateral" },
  { angle: "trasera", label: "Trasera" },
  { angle: "superior", label: "Superior" },
  { angle: "detalle", label: "Detalle" },
];

function buildProductImages(productId: string, productName: string, primaryUrl: string): ProductAngleImage[] {
  return imageAngles.map((item, index) => ({
    id: `${productId}-${item.angle}`,
    angle: item.angle,
    label: item.label,
    url: `${primaryUrl}&view=${item.angle}&sig=${index + 1}`,
    alt: `${productName} - vista ${item.label.toLowerCase()}`,
  }));
}

export const products: Product[] = [
  {
    id: "prd-001",
    sku: "CZ-LED-9005",
    name: "Luces LED 9005 ProBeam",
    slug: "luces-led-9005-probeam",
    category: "Iluminacion",
    brand: "ProBeam",
    image:
      "https://images.unsplash.com/photo-1629226462984-f06fda337aec?auto=format&fit=crop&w=900&q=80",
    images: buildProductImages(
      "prd-001",
      "Luces LED 9005 ProBeam",
      "https://images.unsplash.com/photo-1629226462984-f06fda337aec?auto=format&fit=crop&w=1200&q=80",
    ),
    stock: 42,
    retail_price: 1850,
    wholesale_price: 1390,
    description:
      "Kit LED de alta intensidad para faros principales, con disipacion avanzada y tono blanco frio.",
  },
  {
    id: "prd-002",
    sku: "CZ-CAM-HD",
    name: "Camara de reversa HD",
    slug: "camara-reversa-hd",
    category: "Seguridad",
    brand: "DriveSafe",
    image:
      "https://images.unsplash.com/photo-1619405399517-d7fce0f13302?auto=format&fit=crop&w=900&q=80",
    images: buildProductImages(
      "prd-002",
      "Camara de reversa HD",
      "https://images.unsplash.com/photo-1619405399517-d7fce0f13302?auto=format&fit=crop&w=1200&q=80",
    ),
    stock: 28,
    retail_price: 1450,
    wholesale_price: 1125,
    description:
      "Camara de reversa resistente al agua con vision nocturna y angulo amplio para estacionamiento.",
  },
  {
    id: "prd-003",
    sku: "CZ-MAT-PREM",
    name: "Alfombras premium 5 piezas",
    slug: "alfombras-premium-5-piezas",
    category: "Interior",
    brand: "AutoFit",
    image:
      "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?auto=format&fit=crop&w=900&q=80",
    images: buildProductImages(
      "prd-003",
      "Alfombras premium 5 piezas",
      "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?auto=format&fit=crop&w=1200&q=80",
    ),
    stock: 65,
    retail_price: 2200,
    wholesale_price: 1680,
    description:
      "Set de alfombras universales de uso pesado con borde elevado, faciles de limpiar.",
  },
  {
    id: "prd-004",
    sku: "CZ-COVER-SUV",
    name: "Cobertor impermeable SUV",
    slug: "cobertor-impermeable-suv",
    category: "Exterior",
    brand: "CoverMax",
    image:
      "https://images.unsplash.com/photo-1552519507-da3b142c6e3d?auto=format&fit=crop&w=900&q=80",
    images: buildProductImages(
      "prd-004",
      "Cobertor impermeable SUV",
      "https://images.unsplash.com/photo-1552519507-da3b142c6e3d?auto=format&fit=crop&w=1200&q=80",
    ),
    stock: 19,
    retail_price: 3100,
    wholesale_price: 2450,
    description:
      "Cobertor multicapa para SUV, protege contra sol, polvo y lluvia en almacenamiento exterior.",
  },
  {
    id: "prd-005",
    sku: "CZ-DASH-4K",
    name: "Dash cam 4K con WiFi",
    slug: "dash-cam-4k-wifi",
    category: "Tecnologia",
    brand: "RoadView",
    image:
      "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=900&q=80",
    images: buildProductImages(
      "prd-005",
      "Dash cam 4K con WiFi",
      "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1200&q=80",
    ),
    stock: 12,
    retail_price: 4600,
    wholesale_price: 3725,
    description:
      "Camara frontal 4K con aplicacion movil, sensor nocturno y grabacion en bucle.",
  },
  {
    id: "prd-006",
    sku: "CZ-PUMP-AIR",
    name: "Compresor portatil digital",
    slug: "compresor-portatil-digital",
    category: "Herramientas",
    brand: "TorqueGo",
    image:
      "https://images.unsplash.com/photo-1600661653561-629509216228?auto=format&fit=crop&w=900&q=80",
    images: buildProductImages(
      "prd-006",
      "Compresor portatil digital",
      "https://images.unsplash.com/photo-1600661653561-629509216228?auto=format&fit=crop&w=1200&q=80",
    ),
    stock: 34,
    retail_price: 1750,
    wholesale_price: 1325,
    description:
      "Compresor compacto con pantalla digital, apagado automatico y adaptadores multiples.",
  },
];

export const wholesaleAccounts: WholesaleAccount[] = [
  {
    id: "wsc-001",
    code: "MAYORISTA-CZ-2026",
    customerId: null,
    customerName: "Distribuidor Car Zone",
    businessName: "Distribuidor Car Zone",
    minimumOrder: 5000,
    expiresAt: "2026-12-31",
    usedCount: 0,
    status: "active",
  },
  {
    id: "wsc-002",
    code: "TALLER-PRO",
    customerId: null,
    customerName: "Taller aliado profesional",
    businessName: "Taller aliado profesional",
    minimumOrder: 3000,
    expiresAt: "2026-10-31",
    usedCount: 0,
    status: "active",
  },
];

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("es-HN", {
    style: "currency",
    currency: "HNL",
    maximumFractionDigits: 2,
  }).format(value);
}

export { getProductPrice } from "@/utils/pricing";

export function validateWholesaleCode(code: string) {
  const normalized = code.trim().toUpperCase();
  const account = wholesaleAccounts.find((item) => item.code === normalized);

  if (!account) {
    return null;
  }

  const today = new Date();
  const expiresAt = new Date(`${account.expiresAt}T23:59:59`);

  return account.status === "active" && expiresAt >= today ? account : null;
}
