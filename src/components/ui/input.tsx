import type { InputHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className = "", ...props }: InputProps) {
  return (
    <input
      className={`w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm text-[#1c1d1b] outline-none transition-colors placeholder:text-black/40 focus:border-[#246a73] ${className}`}
      {...props}
    />
  );
}
