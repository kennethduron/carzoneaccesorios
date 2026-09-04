export type CommercialNavSection =
  | "sellers"
  | "commissions"
  | "policies"
  | "analytics"
  | "report-center";

const sectionRoutes: ReadonlyArray<{
  section: CommercialNavSection;
  href: string;
}> = [
  { section: "sellers", href: "/admin/vendedores" },
  { section: "commissions", href: "/admin/comisiones" },
  { section: "policies", href: "/admin/politicas-comision" },
  { section: "analytics", href: "/admin/reportes-comerciales" },
  { section: "report-center", href: "/admin/centro-reportes" },
];

export function getActiveCommercialSection(
  pathname: string,
): CommercialNavSection | null {
  return (
    sectionRoutes.find(
      ({ href }) => pathname === href || pathname.startsWith(`${href}/`),
    )?.section ?? null
  );
}
