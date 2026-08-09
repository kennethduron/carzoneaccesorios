"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Building2, CheckCircle2, Loader2, LogIn, MailCheck, RotateCcw, UserPlus } from "lucide-react";
import {
  checkRegisteredEmailVerificationAction,
  loginWithEmailAction,
  registerWithEmailAction,
  resendConfirmationEmailAction,
} from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { SystemLoadingScreen } from "@/components/system-loading-screen";
import { WholesaleSignupInfo } from "@/components/store/wholesale-program-info";
import { useToast } from "@/contexts/toast-context";

type AuthCardProps = {
  mode: "login" | "registro";
};

type MessageTone = "info" | "success" | "error";

const VERIFICATION_POLL_INTERVAL_MS = 8_000;
const VERIFICATION_POLL_MAX_MS = 3 * 60_000;

function safeNextPath(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/cuenta";
}

function looksLikeValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function getConfirmationErrorMessage(reason: string | null) {
  if (reason === "expired") {
    return "El enlace de verificación venció. Solicita uno nuevo.";
  }

  if (reason === "already_confirmed") {
    return "Tu correo ya fue confirmado. Puedes iniciar sesión.";
  }

  if (reason === "missing") {
    return "El enlace de verificación está incompleto. Solicita uno nuevo.";
  }

  return "No pudimos verificar tu cuenta. Intenta nuevamente o solicita un nuevo correo de verificación.";
}

export function AuthCard({ mode }: AuthCardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = safeNextPath(searchParams.get("next"));
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [phone, setPhone] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [city, setCity] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [checkingVerification, setCheckingVerification] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<MessageTone>("info");
  const [showConfirmationHelp, setShowConfirmationHelp] = useState(false);
  const [registrationEmailSent, setRegistrationEmailSent] = useState(false);
  const [autoPollingVerification, setAutoPollingVerification] = useState(false);
  const [verificationDetected, setVerificationDetected] = useState(false);
  const [verifiedLoginEmail, setVerifiedLoginEmail] = useState<string | null>(null);
  const submitLockRef = useRef(false);
  const resendLockRef = useRef(false);
  const verificationCheckLockRef = useRef(false);
  const toast = useToast();

  const isLogin = mode === "login" || Boolean(verifiedLoginEmail);
  const queryMessage = (() => {
    if (!isLogin) {
      return null;
    }

    if (searchParams.get("reason") === "session_expired") {
      return {
        text: "Su sesión expiró. Inicie sesión nuevamente.",
        tone: "info" as const,
        canResend: false,
      };
    }

    if (searchParams.get("confirmed")) {
      return {
        text: "Correo electrónico confirmado correctamente. Ya puedes iniciar sesión.",
        tone: "success" as const,
        canResend: false,
      };
    }

    if (searchParams.get("verified")) {
      return {
        text: "Cuenta verificada correctamente. Ahora puedes iniciar sesión.",
        tone: "success" as const,
        canResend: false,
      };
    }

    if (searchParams.get("check_email")) {
      return {
        text: "Revisa tu correo para verificar tu cuenta.",
        tone: "info" as const,
        canResend: true,
      };
    }

    if (searchParams.get("confirmation_error")) {
      return {
        text: getConfirmationErrorMessage(searchParams.get("confirmation_error")),
        tone: "error" as const,
        canResend: true,
      };
    }

    if (searchParams.get("password_updated")) {
      return {
        text: "Tu contraseña fue actualizada correctamente.",
        tone: "success" as const,
        canResend: false,
      };
    }

    return null;
  })();
  const visibleMessage = message || queryMessage?.text || "";
  const visibleTone = message ? messageTone : queryMessage?.tone ?? "info";
  const shouldShowConfirmationHelp = showConfirmationHelp || Boolean(queryMessage?.canResend);
  const isCheckEmailMode =
    isLogin &&
    Boolean(searchParams.get("check_email")) &&
    !searchParams.get("verified") &&
    !searchParams.get("confirmed");
  const messageClassName =
    visibleTone === "success"
      ? "bg-[#ecfdf5] text-[#166534]"
      : visibleTone === "error"
        ? "bg-[#fff2ed] text-[#9b341b]"
        : "bg-[#f4f4f5] text-black/65";

  useEffect(() => {
    if (!isLogin) {
      return;
    }

    if (queryMessage?.tone === "success") {
      toast.success(queryMessage.text);
    } else if (queryMessage?.tone === "error") {
      toast.error(queryMessage.text);
    } else if (queryMessage?.text) {
      toast.info(queryMessage.text);
    }
  }, [isLogin, queryMessage?.text, queryMessage?.tone, searchParams, toast]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLockRef.current) {
      return;
    }

    submitLockRef.current = true;
    setLoading(true);
    setMessage("");
    setShowConfirmationHelp(false);

    try {
      const result = isLogin
        ? await loginWithEmailAction(email, password, nextPath)
        : await registerWithEmailAction({
            fullName,
            username,
            email,
            phone,
            password,
            businessName,
            taxId,
            city,
            nextPath,
          });

      setMessage(result.message);

      if (!result.ok) {
        setMessageTone("error");
        setShowConfirmationHelp(result.message.toLowerCase().includes("confirm") || result.message.toLowerCase().includes("verific"));
        toast.error(result.message);
        return;
      }

      if (result.needsEmailConfirmation) {
        setMessageTone("info");
        setShowConfirmationHelp(true);
        setRegistrationEmailSent(true);
        toast.success(result.message);
        return;
      }

      setMessageTone("success");
      toast.success(result.message);
      router.push(result.redirectTo ?? nextPath);
      router.refresh();
    } catch {
      const errorMessage = "No pudimos completar la acción por un problema de conexión. Inténtalo nuevamente.";
      setMessage(errorMessage);
      setMessageTone("error");
      toast.error(errorMessage);
    } finally {
      setLoading(false);
      submitLockRef.current = false;
    }
  }

  async function handleResendConfirmation() {
    if (resendLockRef.current) {
      return;
    }

    resendLockRef.current = true;
    setResending(true);
    setMessage("");

    try {
      const result = await resendConfirmationEmailAction(email);

      setMessage(result.message);
      setMessageTone(result.ok ? "success" : "error");
      setShowConfirmationHelp(true);

      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch {
      const errorMessage = "No pudimos completar la acción por un problema de conexión. Inténtalo nuevamente.";
      setMessage(errorMessage);
      setMessageTone("error");
      setShowConfirmationHelp(true);
      toast.error(errorMessage);
    } finally {
      setResending(false);
      resendLockRef.current = false;
    }
  }

  const runVerificationCheck = useCallback(async (mode: "manual" | "auto") => {
    if (verificationCheckLockRef.current) {
      return false;
    }

    const emailToCheck = email.trim().toLowerCase();
    if (!looksLikeValidEmail(emailToCheck)) {
      if (mode === "manual") {
        const errorMessage = "Ingresa el correo que usaste para crear tu cuenta.";
        setMessage(errorMessage);
        setMessageTone("error");
        toast.error(errorMessage);
      }
      return false;
    }

    verificationCheckLockRef.current = true;
    if (mode === "manual") {
      setCheckingVerification(true);
      setMessage("");
    }

    try {
      const result = await checkRegisteredEmailVerificationAction(emailToCheck);

      if (!result.ok) {
        if (mode === "manual") {
          setMessage(result.message);
          setMessageTone("error");
          setShowConfirmationHelp(true);
          toast.error(result.message);
        }
        return false;
      }

      setVerificationDetected(true);
      setVerifiedLoginEmail(emailToCheck);
      setEmail(emailToCheck);
      setPassword("");
      setRegistrationEmailSent(false);
      setAutoPollingVerification(false);
      setMessage(result.message);
      setMessageTone("success");
      setShowConfirmationHelp(false);
      toast.success(result.message);
      router.replace(result.redirectTo ?? `/login?email=${encodeURIComponent(emailToCheck)}`);
      router.refresh();
      return true;
    } catch {
      const errorMessage = "No pudimos revisar la verificación en este momento. Inténtalo nuevamente.";
      if (mode === "manual") {
        setMessage(errorMessage);
        setMessageTone("error");
        toast.error(errorMessage);
      }
      return false;
    } finally {
      if (mode === "manual") {
        setCheckingVerification(false);
      }
      verificationCheckLockRef.current = false;
    }
  }, [email, router, toast]);

  async function handleVerificationCheck() {
    await runVerificationCheck("manual");
  }

  useEffect(() => {
    const shouldPoll =
      !verificationDetected &&
      looksLikeValidEmail(email) &&
      (registrationEmailSent || isCheckEmailMode);

    if (!shouldPoll) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const poll = async () => {
      if (cancelled) {
        return;
      }

      if (Date.now() - startedAt > VERIFICATION_POLL_MAX_MS) {
        setAutoPollingVerification(false);
        return;
      }

      setAutoPollingVerification(true);
      const confirmed = await runVerificationCheck("auto");

      if (cancelled || confirmed) {
        setAutoPollingVerification(false);
        return;
      }

      if (Date.now() - startedAt + VERIFICATION_POLL_INTERVAL_MS <= VERIFICATION_POLL_MAX_MS) {
        timer = setTimeout(poll, VERIFICATION_POLL_INTERVAL_MS);
        return;
      }

      setAutoPollingVerification(false);
    };

    timer = setTimeout(poll, 1_000);

    return () => {
      cancelled = true;
      setAutoPollingVerification(false);
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [email, isCheckEmailMode, registrationEmailSent, runVerificationCheck, verificationDetected]);

  return (
    <section className="min-h-screen bg-[#f4f4f5] px-4 py-6 text-[#080808] sm:px-6 sm:py-8 min-[1100px]:px-8">
      {loading ? <SystemLoadingScreen fullScreen /> : null}
      <div
        className={`mx-auto grid min-h-[calc(100vh-3rem)] items-start gap-6 sm:min-h-[calc(100vh-4rem)] ${
          isLogin
            ? "max-w-6xl lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-8"
            : "max-w-[1240px] min-[1100px]:grid-cols-[minmax(300px,350px)_minmax(0,1fr)] min-[1100px]:grid-rows-[auto_1fr] min-[1100px]:gap-x-14 min-[1100px]:gap-y-6 min-[1280px]:gap-x-16"
        }`}
      >
        <div
          className={`space-y-5 ${
            isLogin ? "lg:self-center" : "min-[1100px]:col-start-1 min-[1100px]:row-start-1 min-[1100px]:pt-2"
          }`}
        >
          <div className="flex items-center gap-3">
            <div className="grid size-14 shrink-0 place-items-center rounded-md bg-white p-1 shadow-sm ring-1 ring-black/10">
              <Image src="/brand/car-zone-logo.jpeg" alt="Car Zone Accesorios" width={96} height={56} className="h-auto w-full object-contain" preload />
            </div>
            <div>
              <p className="text-lg font-semibold sm:text-xl">Car Zone Accesorios</p>
              <p className="text-sm text-black/55">Acceso seguro para clientes</p>
            </div>
          </div>
          <h1 className="max-w-xl text-3xl font-semibold leading-tight sm:text-4xl min-[1100px]:max-w-[330px]">
            {isLogin ? "Ingresa a tu cuenta." : "Crea tu cuenta de cliente."}
          </h1>
          <p className="max-w-lg leading-6 text-black/60 min-[1100px]:max-w-[320px]">
            {isLogin
              ? "Accede para revisar tus pedidos, facturas y beneficios."
              : "Compra de manera más rápida y administra todo desde un solo lugar."}
          </p>
          {!isLogin ? <RegistrationBenefits /> : null}
        </div>

        <form
          onSubmit={handleSubmit}
          className={`w-full rounded-lg border border-black/10 bg-white p-4 shadow-sm sm:p-6 min-[1100px]:p-8 ${
            isLogin ? "" : "min-[1100px]:col-start-2 min-[1100px]:row-span-2 min-[1100px]:row-start-1"
          }`}
        >
          <div className="mb-5">
            <h2 className="text-xl font-semibold">{isLogin ? "Iniciar sesión" : "Registro"}</h2>
            <p className="mt-1 text-sm text-black/55">
              {isLogin
                ? "Usa tu correo o nombre de usuario y contraseña."
                : "Te enviaremos un correo para confirmar tu cuenta antes de iniciar sesión."}
            </p>
          </div>

          {!isLogin && registrationEmailSent ? (
            <div className="rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] p-4 text-[#14532d]">
              <div className="flex items-start gap-3">
                <CheckCircle2 size={22} className="mt-0.5 shrink-0" />
                <div>
                  <h3 className="font-semibold">Cuenta creada correctamente.</h3>
                  <p className="mt-2 text-sm leading-6">
                    Te enviamos un correo para verificar tu dirección.
                  </p>
                  <p className="mt-2 text-sm leading-6">
                    Cuando confirmes tu correo, esta pantalla se actualizará automáticamente para iniciar sesión.
                  </p>
                  {autoPollingVerification ? (
                    <p className="mt-3 inline-flex items-center gap-2 text-sm font-medium">
                      <Loader2 className="animate-spin" size={16} />
                      Esperando confirmación del correo...
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="mt-4 grid gap-2 lg:grid-cols-3">
                <Link
                  href={`/login?check_email=1&email=${encodeURIComponent(email)}`}
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-[#080808] px-4 py-2 text-sm font-semibold text-white"
                >
                  <LogIn size={17} />
                  Ir a iniciar sesión
                </Link>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={resending || checkingVerification || !email.trim()}
                  onClick={handleResendConfirmation}
                >
                  {resending ? <Loader2 className="animate-spin" size={17} /> : <MailCheck size={17} />}
                  {resending ? "Enviando..." : "Reenviar correo"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={checkingVerification || resending || !email.trim()}
                  onClick={handleVerificationCheck}
                >
                  {checkingVerification ? <Loader2 className="animate-spin" size={17} /> : <CheckCircle2 size={17} />}
                  {checkingVerification ? "Revisando..." : "Ya verifiqué mi cuenta"}
                </Button>
              </div>
              {message ? <p className={`mt-3 rounded-md px-3 py-2 text-sm ${messageClassName}`}>{message}</p> : null}
            </div>
          ) : null}

          {!registrationEmailSent ? <div className={isLogin ? "space-y-3" : "grid gap-x-5 gap-y-4 sm:grid-cols-2"}>
            {!isLogin ? (
              <AuthField label="Nombre completo" htmlFor="auth-full-name">
                <Input
                  id="auth-full-name"
                  className="min-h-11"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  autoComplete="name"
                  disabled={loading}
                  required
                />
              </AuthField>
            ) : null}
            {!isLogin ? (
              <AuthField label="Nombre de usuario" htmlFor="auth-username">
                <Input
                  id="auth-username"
                  className="min-h-11"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  minLength={3}
                  maxLength={30}
                  disabled={loading}
                  required
                />
              </AuthField>
            ) : null}
            <AuthField label={isLogin ? "Correo electrónico o usuario" : "Correo electrónico"} htmlFor="auth-email">
              <Input
                id="auth-email"
                className="min-h-11"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setVerificationDetected(false);
                }}
                type={isLogin ? "text" : "email"}
                autoComplete={isLogin ? "username" : "email"}
                disabled={loading}
                required
              />
            </AuthField>
            {!isLogin ? (
              <AuthField label="Teléfono" htmlFor="auth-phone">
                <Input
                  id="auth-phone"
                  className="min-h-11"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  disabled={loading}
                  required
                />
              </AuthField>
            ) : null}
            <AuthField label="Contraseña" htmlFor="auth-password" className={isLogin ? "" : "sm:col-span-2"}>
              <PasswordInput
                id="auth-password"
                className="min-h-11"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={isLogin ? undefined : 8}
                autoComplete={isLogin ? "current-password" : "new-password"}
                disabled={loading}
                required
              />
            </AuthField>
            {!isLogin ? (
              <fieldset className="min-w-0 border-0 border-t border-black/10 pt-5 sm:col-span-2">
                <legend className="sr-only">Datos del negocio (opcional)</legend>
                <div className="flex items-start gap-3">
                  <div className="grid size-9 shrink-0 place-items-center rounded-md bg-[#f4f4f5] text-black/70">
                    <Building2 aria-hidden="true" size={18} />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold">Datos del negocio (opcional)</h3>
                    <p className="mt-1 text-xs leading-5 text-black/55">
                      Puedes dejarlos vacíos y completarlos una sola vez desde tu cuenta después de verificar el correo.
                    </p>
                  </div>
                </div>
                <div className="mt-4 grid gap-x-5 gap-y-4 sm:grid-cols-2">
                  <AuthField label="Nombre del negocio (opcional)" htmlFor="auth-business-name">
                    <Input
                      id="auth-business-name"
                      className="min-h-11"
                      value={businessName}
                      onChange={(event) => setBusinessName(event.target.value)}
                      maxLength={160}
                      autoComplete="organization"
                      disabled={loading}
                    />
                  </AuthField>
                  <AuthField label="RTN (opcional)" htmlFor="auth-tax-id">
                    <Input
                      id="auth-tax-id"
                      className="min-h-11"
                      value={taxId}
                      onChange={(event) => setTaxId(event.target.value)}
                      maxLength={40}
                      inputMode="numeric"
                      disabled={loading}
                      aria-describedby="auth-tax-id-help"
                    />
                    <span id="auth-tax-id-help" className="mt-1 block text-xs leading-5 text-black/50">
                      14 dígitos; puedes usar espacios o guiones.
                    </span>
                  </AuthField>
                  <AuthField
                    label="Ubicación (ciudad/municipio) (opcional)"
                    htmlFor="auth-city"
                    className="sm:col-span-2"
                  >
                    <Input
                      id="auth-city"
                      className="min-h-11"
                      value={city}
                      onChange={(event) => setCity(event.target.value)}
                      maxLength={120}
                      autoComplete="address-level2"
                      disabled={loading}
                    />
                  </AuthField>
                </div>
              </fieldset>
            ) : null}
          </div> : null}

          {isLogin ? (
            <div className="mt-3 text-right">
              <Link className="text-sm font-medium text-[#e4252c]" href="/recuperar-contrasena">
                ¿Olvidaste tu contraseña?
              </Link>
            </div>
          ) : null}

          {visibleMessage && !registrationEmailSent ? <p className={`mt-4 rounded-md px-3 py-2 text-sm ${messageClassName}`}>{visibleMessage}</p> : null}

          {isLogin && shouldShowConfirmationHelp ? (
            <div className="mt-4 rounded-md border border-black/10 bg-[#f4f4f5] p-3">
              <p className="text-sm text-black/65">
                Revisa tu bandeja de entrada o spam. Si el enlace venció o no llegó, puedes solicitar uno nuevo.
              </p>
              {isCheckEmailMode ? (
                <p className="mt-2 text-sm text-black/65">
                  Cuando confirmes tu correo, esta pantalla se actualizará automáticamente para iniciar sesión.
                </p>
              ) : null}
              {autoPollingVerification ? (
                <p className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-[#166534]">
                  <Loader2 className="animate-spin" size={16} />
                  Esperando confirmación del correo...
                </p>
              ) : null}
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1"
                  disabled={resending || loading || !email.trim()}
                  onClick={handleResendConfirmation}
                >
                  {resending ? <Loader2 className="animate-spin" size={17} /> : <MailCheck size={17} />}
                  {resending ? "Enviando..." : "Reenviar verificación"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1"
                  disabled={resending || loading}
                  onClick={() => {
                    setEmail("");
                    setMessage("");
                  }}
                >
                  <RotateCcw size={17} />
                  Cambiar correo
                </Button>
              </div>
            </div>
          ) : null}

          {!registrationEmailSent ? <Button type="submit" variant="dark" className="mt-5 min-h-11 w-full py-3" disabled={loading}>
            {loading ? <Loader2 className="animate-spin" size={18} /> : isLogin ? <LogIn size={18} /> : <UserPlus size={18} />}
            {loading ? "Procesando..." : isLogin ? "Ingresar" : "Crear cuenta"}
          </Button> : null}

          {!registrationEmailSent ? <p className="mt-4 text-center text-sm text-black/55">
            {isLogin ? "¿No tienes cuenta?" : "¿Ya tienes cuenta?"}{" "}
            <Link className="font-medium text-[#e4252c]" href={isLogin ? "/registro" : "/login"}>
              {isLogin ? "Regístrate" : "Inicia sesión"}
            </Link>
          </p> : null}
        </form>
        {!isLogin ? (
          <WholesaleSignupInfo className="min-[1100px]:col-start-1 min-[1100px]:row-start-2 min-[1100px]:self-start" />
        ) : null}
      </div>
    </section>
  );
}

const registrationBenefits = [
  "Consulta tus pedidos",
  "Guarda tus datos para futuras compras",
  "Solicita acceso a precios mayoristas",
  "Administra tus datos comerciales desde tu cuenta",
] as const;

function RegistrationBenefits() {
  return (
    <ul className="grid max-w-lg gap-2.5 text-sm text-black/75 min-[1100px]:max-w-[340px]" aria-label="Beneficios de crear una cuenta">
      {registrationBenefits.map((benefit) => (
        <li key={benefit} className="flex items-start gap-2.5 leading-5">
          <CheckCircle2 aria-hidden="true" size={17} className="mt-0.5 shrink-0 fill-[#080808] text-white" />
          <span>{benefit}</span>
        </li>
      ))}
    </ul>
  );
}

function AuthField({
  label,
  htmlFor,
  className = "",
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block min-w-0 ${className}`} htmlFor={htmlFor}>
      <span className="mb-1 block text-sm font-medium leading-5 text-black/70">{label}</span>
      {children}
    </label>
  );
}

