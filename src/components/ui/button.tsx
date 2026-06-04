import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "dark" | "ghost";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: ButtonVariant;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-[#e4252c] text-white shadow-sm shadow-[#e4252c]/20 hover:-translate-y-0.5 hover:bg-[#b91c25]",
  secondary: "bg-[#080808] text-white hover:-translate-y-0.5 hover:bg-[#1f1f1f]",
  dark: "bg-[#080808] text-white hover:-translate-y-0.5 hover:bg-[#1f1f1f]",
  ghost: "border border-black/10 bg-white text-[#080808] hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:bg-[#fff1f2]",
};

export function Button({
  children,
  className = "",
  type = "button",
  variant = "primary",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex max-w-full items-center justify-center gap-2 rounded-md px-4 py-2 text-center text-sm font-semibold leading-snug whitespace-normal transition-all duration-200 [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0 [&>svg]:shrink-0 ${variantClasses[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

