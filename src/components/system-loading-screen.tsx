import Image from "next/image";

type SystemLoadingScreenProps = {
  fullScreen?: boolean;
};

export function SystemLoadingScreen({ fullScreen = false }: SystemLoadingScreenProps) {
  return (
    <div
      className={`grid place-items-center bg-white px-5 text-[#080808] ${fullScreen ? "fixed inset-0 z-[80]" : "min-h-screen"}`}
      role="status"
      aria-live="polite"
      aria-label="Cargando sistema"
    >
      <section className="w-full max-w-md text-center">
        <div className="cz-loader-logo relative mx-auto h-20 w-[276px] sm:h-24 sm:w-[330px]">
          <Image
            src="/brand/car-zone-logo-nav.png"
            alt="Car Zone Accesorios"
            fill
            preload
            sizes="(max-width: 640px) 276px, 330px"
            className="object-contain"
          />
        </div>
        <div className="mx-auto mt-6 h-1.5 w-44 overflow-hidden rounded-full bg-black/10">
          <div className="cz-loader-bar h-full w-16 rounded-full bg-[#e4252c]" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold">Cargando...</h1>
        <p className="mt-2 text-sm leading-6 text-black/55">Preparando la información, por favor espera.</p>
      </section>
    </div>
  );
}
