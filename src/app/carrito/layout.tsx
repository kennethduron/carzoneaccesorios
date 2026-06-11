import type { Metadata } from "next";
import { createNoIndexMetadata } from "@/lib/seo";

export const metadata: Metadata = createNoIndexMetadata("Carrito de compra");

export default function CartLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
