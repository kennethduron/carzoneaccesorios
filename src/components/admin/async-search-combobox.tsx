"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Search, X } from "lucide-react";
import type { AdminSearchResponse } from "@/types/admin-search";

type SearchOption = {
  id: string;
};

type AsyncSearchComboboxProps<T extends SearchOption> = {
  endpoint: string;
  value: string;
  selectedOption?: T | null;
  onChange: (option: T | null) => void;
  label: string;
  placeholder: string;
  emptyMessage: string;
  getLabel: (option: T) => string;
  getDescription: (option: T) => string;
  getMeta?: (option: T) => string | null;
  disabled?: boolean;
  required?: boolean;
};

export function AsyncSearchCombobox<T extends SearchOption>({
  endpoint,
  value,
  selectedOption = null,
  onChange,
  label,
  placeholder,
  emptyMessage,
  getLabel,
  getDescription,
  getMeta,
  disabled = false,
  required = false,
}: AsyncSearchComboboxProps<T>) {
  const inputId = useId();
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!isOpen || disabled) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      abortRef.current?.abort();
      abortRef.current = controller;
      setIsLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({ q: query.trim(), limit: "25", offset: "0" });
        const response = await fetch(`${endpoint}?${params.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(response.status === 403 ? "No tienes permiso para realizar esta búsqueda." : "No se pudo completar la búsqueda.");
        const payload = (await response.json()) as AdminSearchResponse<T>;
        setResults(payload.results);
        setTotal(payload.total);
        setActiveIndex(0);
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setResults([]);
        setTotal(0);
        setError(requestError instanceof Error ? requestError.message : "No se pudo completar la búsqueda.");
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }, 300);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [disabled, endpoint, isOpen, query]);

  async function loadMore() {
    if (isLoading || results.length >= total) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setIsLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        q: query.trim(),
        limit: "25",
        offset: String(results.length),
      });
      const response = await fetch(`${endpoint}?${params.toString()}`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("No se pudieron cargar más resultados.");
      const payload = (await response.json()) as AdminSearchResponse<T>;
      setResults((current) => {
        const byId = new Map(current.map((option) => [option.id, option]));
        payload.results.forEach((option) => byId.set(option.id, option));
        return [...byId.values()];
      });
      setTotal(payload.total);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") return;
      setError(requestError instanceof Error ? requestError.message : "No se pudieron cargar más resultados.");
    } finally {
      if (!controller.signal.aborted) setIsLoading(false);
    }
  }

  function choose(option: T) {
    setQuery("");
    setIsOpen(false);
    setActiveIndex(0);
    onChange(option);
  }

  function clear() {
    setQuery("");
    setResults([]);
    setTotal(0);
    onChange(null);
  }

  const selected = selectedOption?.id === value ? selectedOption : null;
  const displayedValue = isOpen ? query : selected ? getLabel(selected) : "";
  const activeOption = results[activeIndex] ?? null;

  return (
    <div
      ref={containerRef}
      className="relative min-w-0"
      onBlur={(event) => {
        if (containerRef.current?.contains(event.relatedTarget as Node | null)) return;
        setIsOpen(false);
        setQuery("");
      }}
    >
      <label htmlFor={inputId} className="mb-1 block text-xs font-medium uppercase text-black/50">
        {label}
      </label>
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-black/40" />
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-activedescendant={isOpen && activeOption ? `${listboxId}-${activeOption.id}` : undefined}
          aria-required={required}
          value={displayedValue}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          onFocus={() => {
            setQuery("");
            setIsOpen(true);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIsOpen(true);
              setActiveIndex((current) => Math.min(current + 1, Math.max(results.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter" && isOpen && activeOption) {
              event.preventDefault();
              choose(activeOption);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setIsOpen(false);
              setQuery("");
            }
          }}
          className="h-11 w-full rounded-lg border border-black/15 bg-white py-2 pl-9 pr-24 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15 disabled:cursor-not-allowed disabled:bg-[#f4f4f5] disabled:opacity-60"
        />
        {value && !disabled ? (
          <button
            type="button"
            aria-label={`Limpiar ${label.toLowerCase()}`}
            onClick={clear}
            className="absolute right-11 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-md text-black/45 hover:bg-black/5"
          >
            <X size={15} />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={isOpen ? "Cerrar resultados" : "Abrir resultados"}
          disabled={disabled}
          onClick={() => {
            setQuery("");
            setIsOpen((current) => !current);
          }}
          className="absolute right-0 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-md text-black/45 hover:bg-black/5 disabled:opacity-40"
        >
          <ChevronDown size={16} />
        </button>
      </div>

      {selected && !isOpen ? (
        <p className="mt-1 text-xs text-black/55">
          Seleccionado: {getLabel(selected)}
        </p>
      ) : null}

      {isOpen ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-40 mt-2 max-h-80 w-full min-w-[280px] overflow-y-auto rounded-lg border border-black/10 bg-white p-1.5 text-sm shadow-xl shadow-black/10"
        >
          {isLoading && results.length === 0 ? (
            <p className="flex items-center gap-2 px-3 py-4 text-black/55" role="status">
              <LoaderCircle size={16} className="animate-spin" />
              Buscando…
            </p>
          ) : null}
          {error ? <p className="px-3 py-4 text-red-700" role="alert">{error}</p> : null}
          {!isLoading && !error && results.length === 0 ? (
            <p className="px-3 py-4 text-black/55">{emptyMessage}</p>
          ) : null}
          {results.map((option, index) => (
            <button
              id={`${listboxId}-${option.id}`}
              key={option.id}
              type="button"
              role="option"
              aria-selected={option.id === value}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(option)}
              className={`flex min-h-14 w-full min-w-0 items-start justify-between gap-3 rounded-md px-3 py-2.5 text-left ${
                index === activeIndex ? "bg-[#fff1f2]" : "hover:bg-[#f4f4f5]"
              }`}
            >
              <span className="min-w-0">
                <span className="block break-words font-semibold">{getLabel(option)}</span>
                <span className="mt-0.5 block break-words text-xs text-black/50">{getDescription(option)}</span>
                {getMeta?.(option) ? <span className="mt-0.5 block break-words text-xs font-medium text-black/60">{getMeta(option)}</span> : null}
              </span>
              {option.id === value ? <Check size={16} className="mt-1 shrink-0 text-[#166534]" /> : null}
            </button>
          ))}
          {results.length < total ? (
            <button
              type="button"
              disabled={isLoading}
              onMouseDown={(event) => event.preventDefault()}
              onClick={loadMore}
              className="mt-1 min-h-11 w-full rounded-md border border-black/10 px-3 py-2 text-sm font-semibold hover:bg-[#f4f4f5] disabled:opacity-50"
            >
              {isLoading ? "Cargando…" : `Cargar más (${results.length} de ${total})`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
