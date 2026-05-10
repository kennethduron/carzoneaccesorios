import { CarFront } from "lucide-react";

type AdminRouteLoadingProps = {
  title: string;
  variant?: "dashboard" | "table" | "reports" | "crm";
};

function BrandMark() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-11 place-items-center rounded-md bg-[#1c1d1b] text-white">
        <CarFront size={23} strokeWidth={1.8} />
      </div>
      <div>
        <p className="font-semibold">Car Zone Accesorios</p>
        <p className="text-xs text-black/50">Cargando sistema...</p>
      </div>
    </div>
  );
}

function PulseBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-md bg-black/10 ${className}`} />;
}

function AdminTableSkeleton() {
  return (
    <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
      <div className="border-b border-black/10 p-5">
        <PulseBlock className="h-5 w-48" />
        <PulseBlock className="mt-2 h-4 w-64" />
      </div>
      <div className="grid gap-3 p-4 md:grid-cols-[1fr_180px_180px_auto]">
        <PulseBlock className="h-10 w-full" />
        <PulseBlock className="h-10 w-full" />
        <PulseBlock className="h-10 w-full" />
        <PulseBlock className="h-10 w-24" />
      </div>
      <div className="divide-y divide-black/10">
        {Array.from({ length: 7 }).map((_, index) => (
          <div key={index} className="grid gap-4 px-4 py-4 md:grid-cols-[140px_1fr_130px_120px_100px]">
            <PulseBlock className="h-4 w-full" />
            <PulseBlock className="h-4 w-full" />
            <PulseBlock className="h-4 w-full" />
            <PulseBlock className="h-4 w-full" />
            <PulseBlock className="h-8 w-full" />
          </div>
        ))}
      </div>
    </section>
  );
}

function AdminMetricsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className={`grid gap-3 ${count === 4 ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="rounded-lg border border-black/10 bg-white p-4">
          <PulseBlock className="h-4 w-24" />
          <PulseBlock className="mt-3 h-8 w-36" />
        </div>
      ))}
    </div>
  );
}

function AdminCrmSkeleton() {
  return (
    <>
      <AdminMetricsSkeleton count={4} />
      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
          <PulseBlock className="h-10 w-full" />
          <PulseBlock className="h-5 w-64" />
        </div>
      </section>
      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-lg border border-black/10 bg-white p-5">
          <div className="flex items-center justify-between gap-4">
            <PulseBlock className="h-6 w-40" />
            <PulseBlock className="h-9 w-24" />
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {Array.from({ length: 8 }).map((_, index) => (
              <PulseBlock key={index} className="h-11 w-full" />
            ))}
          </div>
          <PulseBlock className="mt-4 h-24 w-full" />
        </section>
        <section className="rounded-lg border border-black/10 bg-white p-5">
          <PulseBlock className="h-6 w-44" />
          <div className="mt-5 space-y-3">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="rounded-md border border-black/10 p-3">
                <PulseBlock className="h-4 w-3/4" />
                <PulseBlock className="mt-2 h-4 w-1/2" />
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
        <div className="border-b border-black/10 p-5">
          <PulseBlock className="h-6 w-52" />
          <PulseBlock className="mt-2 h-4 w-72" />
        </div>
        <div className="grid gap-4 p-5 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <article key={index} className="rounded-lg border border-black/10 p-4">
              <PulseBlock className="h-5 w-2/3" />
              <PulseBlock className="mt-3 h-4 w-full" />
              <PulseBlock className="mt-2 h-4 w-4/5" />
              <PulseBlock className="mt-4 h-9 w-28" />
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

export function AdminRouteLoading({ title, variant = "table" }: AdminRouteLoadingProps) {
  return (
    <section className="min-h-screen bg-[#f7f7f2] px-5 py-6 text-[#1c1d1b]">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <PulseBlock className="h-7 w-56" />
            <p className="mt-2 text-sm text-black/50">{title}</p>
          </div>
          <BrandMark />
        </div>

        <div className="mt-6 space-y-5">
          {variant === "dashboard" ? (
            <>
              <section className="rounded-lg border border-black/10 bg-white p-4">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div>
                    <PulseBlock className="h-4 w-28" />
                    <PulseBlock className="mt-3 h-5 w-64" />
                    <PulseBlock className="mt-2 h-4 w-36" />
                  </div>
                  <PulseBlock className="h-10 w-28" />
                </div>
              </section>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="rounded-lg border border-black/10 bg-white p-5">
                    <PulseBlock className="h-5 w-36" />
                    <PulseBlock className="mt-3 h-4 w-full" />
                    <PulseBlock className="mt-2 h-4 w-4/5" />
                  </div>
                ))}
              </div>
            </>
          ) : variant === "crm" ? (
            <AdminCrmSkeleton />
          ) : (
            <>
              <AdminMetricsSkeleton />
              {variant === "reports" ? <AdminMetricsSkeleton /> : null}
              <AdminTableSkeleton />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export function CatalogRouteLoading() {
  return (
    <section className="min-h-screen bg-[#f7f7f2] px-5 py-8 text-[#1c1d1b]">
      <div className="mx-auto max-w-7xl">
        <BrandMark />
        <div className="mt-8 grid gap-5 lg:grid-cols-[260px_1fr]">
          <aside className="rounded-lg border border-black/10 bg-white p-4">
            {Array.from({ length: 7 }).map((_, index) => (
              <PulseBlock key={index} className="mb-3 h-9 w-full last:mb-0" />
            ))}
          </aside>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }).map((_, index) => (
              <article key={index} className="overflow-hidden rounded-lg border border-black/10 bg-white">
                <PulseBlock className="aspect-[4/3] w-full rounded-none" />
                <div className="p-4">
                  <PulseBlock className="h-5 w-4/5" />
                  <PulseBlock className="mt-3 h-4 w-1/2" />
                  <PulseBlock className="mt-4 h-9 w-full" />
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function CheckoutRouteLoading({ mode }: { mode: "cart" | "checkout" }) {
  return (
    <section className="min-h-screen bg-[#f7f7f2] px-5 py-8 text-[#1c1d1b]">
      <div className="mx-auto max-w-7xl">
        <BrandMark />
        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_420px]">
          <section className="rounded-lg border border-black/10 bg-white p-5">
            <PulseBlock className="h-7 w-48" />
            <PulseBlock className="mt-3 h-4 w-72" />
            <div className="mt-6 space-y-3">
              {Array.from({ length: mode === "checkout" ? 7 : 4 }).map((_, index) => (
                <PulseBlock key={index} className="h-12 w-full" />
              ))}
            </div>
          </section>
          <aside className="h-fit rounded-lg border border-black/10 bg-white p-5">
            <PulseBlock className="h-6 w-32" />
            <div className="mt-5 space-y-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="flex justify-between gap-4">
                  <PulseBlock className="h-4 w-44" />
                  <PulseBlock className="h-4 w-20" />
                </div>
              ))}
            </div>
            <PulseBlock className="mt-6 h-11 w-full" />
          </aside>
        </div>
      </div>
    </section>
  );
}
