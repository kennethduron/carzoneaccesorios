"use client";

import { Cloud, CloudAlert, CloudOff, LoaderCircle, RefreshCw } from "lucide-react";

export type PosSaveState = "idle" | "dirty" | "saving" | "saved" | "offline" | "conflict" | "error";

export function PosDraftStatus({ state, message }: { state: PosSaveState; message?: string }) {
  const Icon = state === "saving" ? LoaderCircle : state === "offline" ? CloudOff : state === "conflict" ? RefreshCw : state === "error" ? CloudAlert : Cloud;
  const label = state === "saving" ? "Guardando..." : state === "dirty" ? "Cambios pendientes" : state === "saved" ? "Guardado" : state === "offline" ? "Sin conexion" : state === "conflict" ? "Conflicto: recarga el borrador" : state === "error" ? "Error al guardar" : "Sin cambios";
  const tone = state === "error" || state === "conflict" ? "bg-red-50 text-red-800" : state === "offline" || state === "dirty" ? "bg-amber-50 text-amber-900" : "bg-slate-100 text-slate-700";
  return <div role="status" aria-live="polite" className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-semibold ${tone}`}><Icon size={17} className={state === "saving" ? "animate-spin motion-reduce:animate-none" : ""} /><span>{message || label}</span></div>;
}
