export default function AdminUsageLoading() {
  return (
    <section className="min-h-screen bg-[#f7f7f2] px-5 py-6 text-[#1c1d1b]">
      <div className="mx-auto max-w-7xl">
        <div className="h-8 w-56 animate-pulse rounded bg-black/10" />
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-36 animate-pulse rounded-lg border border-black/10 bg-white" />
          ))}
        </div>
        <div className="mt-5 grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="h-96 animate-pulse rounded-lg border border-black/10 bg-white" />
          <div className="h-96 animate-pulse rounded-lg border border-black/10 bg-white" />
        </div>
      </div>
    </section>
  );
}
