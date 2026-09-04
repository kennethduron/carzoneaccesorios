"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  CircleDollarSign,
  FileSpreadsheet,
  Settings2,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  getActiveCommercialSection,
  type CommercialNavSection,
} from "@/components/admin/commercial-nav-state";

const navItems: ReadonlyArray<{
  section: CommercialNavSection;
  href: string;
  label: string;
  icon: LucideIcon;
}> = [
  {
    section: "sellers",
    href: "/admin/vendedores",
    label: "Vendedores",
    icon: Users,
  },
  {
    section: "commissions",
    href: "/admin/comisiones",
    label: "Comisiones",
    icon: CircleDollarSign,
  },
  {
    section: "policies",
    href: "/admin/politicas-comision",
    label: "Políticas",
    icon: Settings2,
  },
  {
    section: "analytics",
    href: "/admin/reportes-comerciales",
    label: "Reportes comerciales",
    icon: BarChart3,
  },
  {
    section: "report-center",
    href: "/admin/centro-reportes",
    label: "Centro de reportes",
    icon: FileSpreadsheet,
  },
];

const baseItem =
  "inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-lg border border-transparent px-3 py-2 text-center text-sm font-medium text-black/65 transition-colors hover:bg-red-50/70 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 last:col-span-2 sm:last:col-span-1";
const activeItem =
  "border-red-100 bg-red-50 font-semibold text-red-700 shadow-[inset_3px_0_0_#e4252c] hover:bg-red-100 hover:text-red-800";

export function Phase4CommercialNav() {
  const pathname = usePathname();
  const activeSection = getActiveCommercialSection(pathname);

  return (
    <nav
      aria-label="Administración comercial"
      className="mb-3 grid min-w-0 grid-cols-2 gap-1 rounded-xl border bg-white p-2 shadow-sm sm:flex sm:flex-wrap"
    >
      {navItems.map(({ section, href, label, icon: Icon }) => {
        const active = section === activeSection;
        return (
          <Link
            key={section}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`${baseItem} ${active ? activeItem : ""}`}
          >
            <Icon aria-hidden="true" className="shrink-0" size={17} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
