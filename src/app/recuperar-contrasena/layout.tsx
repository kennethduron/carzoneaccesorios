import type { Metadata } from "next";
import { createNoIndexMetadata } from "@/lib/seo";

export const metadata: Metadata = createNoIndexMetadata("Recuperar contraseña");

export default function PasswordRecoveryLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
