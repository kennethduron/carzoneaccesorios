"use client";

import { useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  showLabel?: string;
  hideLabel?: string;
};

export function PasswordInput({
  className = "",
  showLabel = "Mostrar contraseña",
  hideLabel = "Ocultar contraseña",
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const label = visible ? hideLabel : showLabel;

  return (
    <div className="relative">
      <input
        className={`w-full rounded-md border border-black/10 bg-white py-2 pl-3 pr-11 text-sm text-[#080808] outline-none transition-colors placeholder:text-black/40 focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15 disabled:cursor-not-allowed disabled:bg-[#f4f4f5] disabled:text-black/45 ${className}`}
        type={visible ? "text" : "password"}
        {...props}
      />
      <button
        type="button"
        className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-black/55 transition-colors hover:bg-black/5 hover:text-[#080808] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-45"
        onClick={() => setVisible((current) => !current)}
        aria-label={label}
        title={label}
        disabled={props.disabled}
      >
        {visible ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </div>
  );
}
