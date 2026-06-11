import type { Metadata } from "next";
import { createNoIndexMetadata } from "@/lib/seo";

export const metadata: Metadata = createNoIndexMetadata("Iniciar sesión");

export default function LoginLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
