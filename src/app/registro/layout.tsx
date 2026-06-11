import type { Metadata } from "next";
import { createNoIndexMetadata } from "@/lib/seo";

export const metadata: Metadata = createNoIndexMetadata("Crear cuenta");

export default function RegisterLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
