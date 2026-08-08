export default function AccountingTaxReportLoading() {
  return <main className="min-h-screen bg-[#f7f7f8] p-4 sm:p-6"><div className="mx-auto max-w-[1400px] animate-pulse space-y-4"><div className="h-36 rounded-xl bg-black/10" /><div className="h-24 rounded-xl bg-black/10" /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-28 rounded-xl bg-black/10" />)}</div><div className="h-80 rounded-xl bg-black/10" /></div></main>;
}
