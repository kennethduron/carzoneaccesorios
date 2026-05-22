import Image from "next/image";
import Link from "next/link";
import { CheckCircle2, LogIn } from "lucide-react";
import { Button } from "@/components/ui";
import { VerifiedLoginRedirect } from "@/components/forms/verified-login-redirect";

export default async function AccountVerifiedPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const alreadyVerified = params.status === "already";

  return (
    <section className="min-h-screen bg-[#f4f4f5] px-5 py-10 text-[#080808]">
      <VerifiedLoginRedirect />
      <div className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-5xl items-center gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <div className="grid size-14 place-items-center rounded-md bg-white p-1 shadow-sm ring-1 ring-black/10">
              <Image src="/brand/car-zone-logo.jpeg" alt="Car Zone Accesorios" width={96} height={56} className="h-auto w-full object-contain" />
            </div>
            <div>
              <p className="text-2xl font-semibold">Car Zone Accesorios</p>
              <p className="text-sm text-black/55">Verificación de cuenta</p>
            </div>
          </div>
          <h1 className="max-w-xl text-4xl font-semibold leading-tight">
            {alreadyVerified ? "Esta cuenta ya fue verificada." : "Cuenta verificada correctamente."}
          </h1>
          <p className="max-w-lg text-black/60">
            {alreadyVerified
              ? "Puedes iniciar sesión con tu usuario o correo y contraseña."
              : "Tu correo ha sido confirmado. Ahora puedes iniciar sesión con tu usuario o correo y contraseña."}
          </p>
        </div>

        <div className="rounded-lg border border-black/10 bg-white p-6 shadow-sm">
          <div className="grid size-12 place-items-center rounded-md bg-[#ecfdf5] text-[#166534]">
            <CheckCircle2 size={24} />
          </div>
          <h2 className="mt-4 text-2xl font-semibold">
            {alreadyVerified ? "Cuenta lista para entrar" : "Correo confirmado"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-black/60">
            Te enviaremos a la pantalla de inicio de sesión en unos segundos. También puedes ir ahora.
          </p>
          <Link href="/login?verified=1" className="mt-5 block">
            <Button variant="dark" className="w-full py-3">
              <LogIn size={18} />
              Ir a iniciar sesión
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}
