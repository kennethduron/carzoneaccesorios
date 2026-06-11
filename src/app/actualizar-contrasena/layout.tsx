import type { Metadata } from "next";
import { createNoIndexMetadata } from "@/lib/seo";

export const metadata: Metadata = createNoIndexMetadata("Actualizar contraseña");

export default function PasswordUpdateLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
