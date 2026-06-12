"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { Loader2, MailCheck } from "lucide-react";
import { resendConfirmationEmailAction } from "@/app/auth/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";

export function VerificationEmailForm({ initialEmail = "" }: { initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const submitLockRef = useRef(false);
  const toast = useToast();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLockRef.current) {
      return;
    }

    submitLockRef.current = true;
    setMessage("");

    startTransition(async () => {
      try {
        const result = await resendConfirmationEmailAction(email);
        setMessage(result.message);

        if (result.ok) {
          toast.success(result.message);
        } else {
          toast.error(result.message);
        }
      } catch {
        const errorMessage = "No pudimos completar la acción por un problema de conexión. Inténtalo nuevamente.";
        setMessage(errorMessage);
        toast.error(errorMessage);
      } finally {
        submitLockRef.current = false;
      }
    });
  }

  return (
    <form onSubmit={submit} className="mt-5 rounded-lg border border-black/10 bg-[#f8f8f8] p-4">
      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase text-black/50">Correo electrónico</span>
        <Input
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          type="email"
          placeholder="tu-correo@ejemplo.com"
          autoComplete="email"
          disabled={isPending}
          required
        />
      </label>
      <Button type="submit" disabled={isPending} variant="dark" className="mt-3 w-full">
        {isPending ? <Loader2 className="animate-spin" size={17} /> : <MailCheck size={17} />}
        {isPending ? "Enviando..." : "Solicitar nuevo enlace"}
      </Button>
      {message ? <p className="mt-3 rounded-md bg-white px-3 py-2 text-sm text-black/60">{message}</p> : null}
    </form>
  );
}
