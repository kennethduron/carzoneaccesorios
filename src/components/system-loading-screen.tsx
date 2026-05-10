import { CarFront } from "lucide-react";

type SystemLoadingScreenProps = {
  fullScreen?: boolean;
};

export function SystemLoadingScreen({ fullScreen = false }: SystemLoadingScreenProps) {
  return (
    <div
      className={`grid place-items-center bg-[#f7f7f2] px-5 text-[#1c1d1b] ${
        fullScreen ? "fixed inset-0 z-[80]" : "min-h-screen"
      }`}
      role="status"
      aria-live="polite"
      aria-label="Cargando sistema"
    >
      <section className="w-full max-w-sm text-center">
        <div className="mx-auto grid size-16 place-items-center rounded-md bg-[#1c1d1b] text-white shadow-sm">
          <CarFront size={32} strokeWidth={1.8} />
        </div>
        <p className="mt-4 text-xl font-semibold">Car Zone Accesorios</p>
        <div className="mx-auto mt-5 size-10 rounded-full border-2 border-black/10 border-t-[#246a73] motion-safe:animate-spin" />
        <h1 className="mt-5 text-2xl font-semibold">Cargando sistema...</h1>
        <p className="mt-2 text-sm leading-6 text-black/55">Preparando la informacion, por favor espera.</p>
      </section>
    </div>
  );
}
