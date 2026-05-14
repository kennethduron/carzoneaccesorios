import Link from "next/link";
import nextDynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";
import { writeErrorLog } from "@/lib/error-logging";
import { getAdminWholesaleCodes } from "@/services/supabase/admin-wholesale-codes.service";

export const dynamic = "force-dynamic";

const WholesaleCodeManager = nextDynamic(
  () => import("@/components/admin/wholesale-code-manager").then((module) => module.WholesaleCodeManager),
  {
    loading: () => (
      <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">
        Cargando códigos mayoristas...
      </div>
    ),
  },
);

type SupabaseLikeError = Error & {
  code?: string | null;
  details?: string | null;
  hint?: string | null;
};

function getWholesaleLoadMessage(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const code = (error as SupabaseLikeError | null)?.code;

  if (code === "42501" || message.includes("permission denied") || message.includes("row-level security")) {
    return "No tienes permisos para administrar códigos mayoristas.";
  }

  if (message.includes("fetch failed") || message.includes("failed to fetch")) {
    return "No pudimos conectar con la base de datos.";
  }

  return "No pudimos cargar los códigos mayoristas. Intenta nuevamente.";
}

function BackToAdminLink() {
  return (
    <div className="mb-5">
      <Link
        href="/admin"
        className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
      >
        <ArrowLeft size={16} />
        Panel administrativo
      </Link>
    </div>
  );
}

export default async function AdminWholesaleCodesPage() {
  await requirePermission("customers:manage");
  let payload: Awaited<ReturnType<typeof getAdminWholesaleCodes>>;

  try {
    payload = await getAdminWholesaleCodes();
  } catch (error) {
    const supabaseError = error as SupabaseLikeError;
    const errorMessage = error instanceof Error ? error.message : "Unknown wholesale code admin error";

    try {
      await writeErrorLog({
        route: "/admin/codigos-mayoristas",
        action: "admin.wholesale_codes.load_failed",
        errorMessage,
        errorStack: error instanceof Error ? error.stack : null,
        metadata: {
          code: supabaseError.code ?? null,
          details: supabaseError.details ?? null,
          hint: supabaseError.hint ?? null,
        },
      });
    } catch (logError) {
      console.error("No se pudo registrar el error de códigos mayoristas", logError);
    }

    return (
      <AdminShell title="Códigos mayoristas">
        <BackToAdminLink />
        <section className="rounded-lg border border-[#f2b8a0] bg-[#fff7ed] p-5 text-[#7c2d12]">
          <h2 className="font-semibold">No se pudo abrir el módulo mayorista</h2>
          <p className="mt-2 text-sm">{getWholesaleLoadMessage(error)}</p>
          <p className="mt-2 text-xs text-[#7c2d12]/75">
            El detalle técnico fue registrado para revisión.
          </p>
        </section>
      </AdminShell>
    );
  }

  const { codes, customers } = payload;

  return (
    <AdminShell title="Códigos mayoristas">
      <BackToAdminLink />
      <WholesaleCodeManager codes={codes} customers={customers} />
    </AdminShell>
  );
}
