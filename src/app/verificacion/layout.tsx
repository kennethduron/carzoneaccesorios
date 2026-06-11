import type { Metadata } from "next";
import { createNoIndexMetadata } from "@/lib/seo";

export const metadata: Metadata = createNoIndexMetadata("Verificación de cuenta");

export default function VerificationLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
