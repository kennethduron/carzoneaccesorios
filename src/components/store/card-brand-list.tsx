const cardBrands = ["Visa", "MasterCard", "American Express", "Diners Club", "Discover", "JCB"];

export function CardBrandList({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex flex-wrap gap-2 ${compact ? "text-[11px]" : "text-xs"}`} aria-label="Tarjetas aceptadas">
      {cardBrands.map((brand) => (
        <span
          key={brand}
          className="inline-flex min-h-8 items-center rounded-md border border-black/10 bg-white px-2.5 font-semibold text-[#080808] shadow-sm"
        >
          {brand}
        </span>
      ))}
    </div>
  );
}

export const acceptedCardBrands = cardBrands;
