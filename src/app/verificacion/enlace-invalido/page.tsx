import Image from "next/image";
import Link from "next/link";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { ResendVerificationForm } from "@/components/forms/resend-verification-form";

const messages: Record<string, { title: string; body: string }> = {
  missing: {
    title: "No encontramos un enlace de verificación válido.",
    body: "Abre el enlace completo desde tu correo o solicita uno nuevo.",
  },
  expired: {
    title: "El enlace de verificación no es válido o ha expirado.",
    body: "Por seguridad, los enlaces de verificación tienen vigencia limitada. Puedes solicitar uno nuevo.",
  },
  failed: {
    title: "No pudimos completar la verificación.",
    body: "Inténtalo nuevamente desde tu correo o solicita un nuevo enlace de verificación.",
  },
};

export default async function InvalidVerificationPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const reason = typeof params.reason === "string" ? params.reason : "expired";
  const content = messages[reason] ?? messages.expired;
  const email = typeof params.email === "string" ? params.email : "";

  return (
    <section className="min-h-screen bg-[#f4f4f5] px-5 py-10 text-[#080808]">
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
          <h1 className="max-w-xl text-4xl font-semibold leading-tight">{content.title}</h1>
          <p className="max-w-lg text-black/60">{content.body}</p>
        </div>

        <div className="rounded-lg border border-black/10 bg-white p-6 shadow-sm">
          <div className="grid size-12 place-items-center rounded-md bg-[#fff7ed] text-[#9a3412]">
            <AlertTriangle size={24} />
          </div>
          <h2 className="mt-4 text-2xl font-semibold">Enviar nuevo correo de verificación</h2>
          <p className="mt-2 text-sm leading-6 text-black/60">
            Escribe el correo usado en el registro. Si está registrado, enviaremos un nuevo enlace de verificación.
          </p>
          <ResendVerificationForm initialEmail={email} />
          <Link href="/login" className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-[#080808] hover:text-[#e4252c]">
            <ArrowLeft size={16} />
            Volver a iniciar sesión
          </Link>
        </div>
      </div>
    </section>
  );
}
