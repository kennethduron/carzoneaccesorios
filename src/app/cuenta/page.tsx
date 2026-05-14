import Link from "next/link";
import { LogoutButton } from "@/components/auth";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { requireSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function CuentaPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const profile = await requireSession();
  const params = (await searchParams) ?? {};
  const confirmed = params.confirmed === "1";

  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-4xl px-5 py-8">
        {confirmed ? (
          <div className="mb-4 rounded-lg border border-[#e4252c]/20 bg-[#fff1f2] p-4 text-sm text-[#b91c25]">
            Correo confirmado correctamente. Tu cuenta ya está activa.
          </div>
        ) : null}
        <div className="rounded-lg border border-black/10 bg-white p-5">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <p className="text-sm text-black/50">Mi cuenta</p>
            <h1 className="mt-1 text-2xl font-semibold">{profile.full_name || profile.email}</h1>
            <p className="mt-2 text-sm capitalize text-black/60">Rol: {profile.role}</p>
          </div>
          <LogoutButton />
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-md bg-[#f4f4f5] p-4">
            <p className="text-sm text-black/50">Correo</p>
            <p className="font-medium">{profile.email}</p>
          </div>
          <div className="rounded-md bg-[#f4f4f5] p-4">
            <p className="text-sm text-black/50">Permisos</p>
            <p className="font-medium">{profile.permissions.length}</p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link className="inline-flex rounded-md bg-[#080808] px-4 py-2 text-sm font-medium text-white" href="/mis-pedidos">
            Mis pedidos
          </Link>
          <Link className="inline-flex rounded-md border border-black/10 px-4 py-2 text-sm font-medium text-[#e4252c]" href="/">
            Volver a la tienda
          </Link>
        </div>
        </div>
      </section>
    </PublicStoreShell>
  );
}



