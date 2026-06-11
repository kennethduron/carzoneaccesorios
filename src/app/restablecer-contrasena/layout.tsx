import type { Metadata } from "next";
import { createNoIndexMetadata } from "@/lib/seo";

export const metadata: Metadata = createNoIndexMetadata("Restablecer contraseña");

export default function PasswordResetLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
