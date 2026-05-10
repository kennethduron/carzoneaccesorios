import Link from "next/link";

export default function SinPermisoPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f7f7f2] px-5 text-[#1c1d1b]">
      <section className="w-full max-w-lg rounded-lg border border-black/10 bg-white p-6 text-center">
        <p className="text-sm font-medium text-[#d55d3b]">Acceso restringido</p>
        <h1 className="mt-2 text-3xl font-semibold">No tienes permiso para esta ruta.</h1>
        <p className="mt-3 text-black/60">
          Tu sesión existe, pero tu rol no tiene los permisos requeridos para entrar aqui.
        </p>
        <Link
          className="mt-5 inline-flex rounded-md bg-[#1c1d1b] px-4 py-2 text-sm font-medium text-white"
          href="/"
        >
          Volver a la tienda
        </Link>
      </section>
    </main>
  );
}
