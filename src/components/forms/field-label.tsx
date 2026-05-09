import type { ReactNode } from "react";

type FieldLabelProps = {
  label: string;
  children: ReactNode;
};

export function FieldLabel({ label, children }: FieldLabelProps) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-black/65">{label}</span>
      {children}
    </label>
  );
}
