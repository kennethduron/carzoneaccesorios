import type { Metadata } from "next";
import { createNoIndexMetadata } from "@/lib/seo";

export const metadata: Metadata = createNoIndexMetadata("Acceso restringido");

export default function AccessDeniedLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
