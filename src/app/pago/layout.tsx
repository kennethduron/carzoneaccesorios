import type { Metadata } from "next";
import { createNoIndexMetadata } from "@/lib/seo";

export const metadata: Metadata = createNoIndexMetadata("Estado del pago");

export default function PaymentLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
