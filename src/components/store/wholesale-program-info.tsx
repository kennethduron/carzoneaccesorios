"use client";

import type React from "react";
import Link from "next/link";
import { BadgePercent, CheckCircle2, Handshake, Repeat, ShoppingBag, Sparkles } from "lucide-react";
import { formatCurrency } from "@/utils/pricing";
import type { WholesaleFirstPurchaseRequirement } from "@/types/wholesale";

const conditionItems = [
  ["Acceso a precios especiales", BadgePercent],
  ["Atencion personalizada", Handshake],
  ["Beneficios exclusivos", Sparkles],
  ["Primera compra minima de L 10,000", ShoppingBag],
  ["Compras posteriores sin monto mínimo", Repeat],
] as const;

export function WholesaleProgramConditionsCard({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`rounded-lg border border-[#e4252c]/15 bg-[#fff8f6] ${compact ? "p-3" : "p-4"}`}>
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-white text-[#b91c25] ring-1 ring-[#e4252c]/15">
          <BadgePercent size={18} />
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold">Condiciones del programa mayorista</h3>
          <p className="mt-1 text-sm leading-6 text-black/60">
            Tu primera compra mayorista debe alcanzar un total final de L 10,000 o más. Después de completar esa compra, puedes
            realizar pedidos sin monto mínimo.
          </p>
        </div>
      </div>
      <div className={`mt-3 grid gap-2 ${compact ? "" : "sm:grid-cols-2"}`}>
        {conditionItems.map(([label, Icon]) => (
          <div key={label} className="flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm text-black/70 ring-1 ring-black/5">
            <Icon size={15} className="shrink-0 text-[#b91c25]" />
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WholesaleSignupInfo() {
  return (
    <div className="rounded-lg border border-[#e4252c]/15 bg-[#fff8f6] p-4">
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-white text-[#b91c25] ring-1 ring-[#e4252c]/15">
          <ShoppingBag size={18} />
        </div>
        <div>
          <h3 className="font-semibold">Deseas comprar al por mayor?</h3>
          <p className="mt-1 text-sm leading-6 text-black/60">
            Obten acceso a precios mayoristas exclusivos para distribuidores y negocios.
          </p>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <InfoItem icon={<BadgePercent size={15} />} text="Primera compra mayorista con total final mínimo: L 10,000." />
        <InfoItem icon={<Repeat size={15} />} text="Compras posteriores sin monto mínimo." />
      </div>
      <Link href="/contacto#mayoreo" className="mt-3 inline-flex text-sm font-semibold text-[#b91c25]">
        Conocer programa mayorista
      </Link>
    </div>
  );
}

export function WholesaleRequirementSummary({
  requirement,
  currentFinalTotal,
  className = "",
}: {
  requirement: WholesaleFirstPurchaseRequirement;
  currentFinalTotal?: number;
  className?: string;
}) {
  const baseAmount = typeof currentFinalTotal === "number" ? currentFinalTotal : requirement.accumulated;
  const missing = requirement.completed ? 0 : Math.max(0, requirement.minimum - baseAmount);
  const reached = requirement.completed || missing <= 0;

  return (
    <div className={`rounded-md border p-3 text-sm ${reached ? "border-[#16a34a]/20 bg-[#f0fdf4] text-[#166534]" : "border-[#e4252c]/20 bg-[#fff1f2] text-[#7f1d1d]"} ${className}`}>
      <div className="flex items-start gap-2">
        <CheckCircle2 size={17} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">Primera compra mayorista requerida: {formatCurrency(requirement.minimum)}</p>
          <p className="mt-1">
            {reached
              ? "Has alcanzado el mínimo requerido para tu primera compra mayorista."
              : `Te faltan ${formatCurrency(missing)} para completar el mínimo de primera compra mayorista.`}
          </p>
        </div>
      </div>
    </div>
  );
}

function InfoItem({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm text-black/70 ring-1 ring-black/5">
      <span className="text-[#b91c25]">{icon}</span>
      <span>{text}</span>
    </div>
  );
}
