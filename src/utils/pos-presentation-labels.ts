const customerMatchFieldLabels: Record<string, string> = {
  name: "nombre",
  contact_name: "nombre",
  company: "empresa",
  business_name: "empresa",
  email: "correo electrónico",
  phone: "teléfono",
  rtn: "RTN",
  tax_id: "RTN",
};

const sourceLabels: Record<string, string> = {
  portal_registration: "Registro desde el portal",
  customer_portal: "Portal del cliente",
  website: "Sitio web",
  web: "Sitio web",
  pos: "Punto de venta",
  internal: "Creado internamente",
  admin: "Creado internamente",
  manual: "Creado internamente",
};

function spanishList(values: string[]) {
  if (values.length <= 1) return values[0] ?? "información coincidente";
  return `${values.slice(0, -1).join(", ")} y ${values.at(-1)}`;
}

export function posCustomerMatchLabel(level: "strong" | "probable", fields: string[]) {
  const labels = [...new Set(fields.map((field) => customerMatchFieldLabels[field] ?? "información coincidente"))];
  return `Coincidencia ${level === "strong" ? "exacta" : "probable"} por ${spanishList(labels)}`;
}

export function posSourceLabel(source: string | null | undefined) {
  if (!source) return "Creado internamente";
  return sourceLabels[source.trim().toLowerCase()] ?? "Creado internamente";
}
