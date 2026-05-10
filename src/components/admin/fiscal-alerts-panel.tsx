import { AlertTriangle } from "lucide-react";
import type { FiscalAlert } from "@/types/fiscal";

type FiscalAlertsPanelProps = {
  alerts: FiscalAlert[];
};

export function FiscalAlertsPanel({ alerts }: FiscalAlertsPanelProps) {
  if (alerts.length === 0) {
    return null;
  }

  return (
    <section className="grid gap-2">
      {alerts.map((alert) => (
        <div
          key={alert.message}
          className={`flex items-start gap-3 rounded-md border p-3 text-sm font-medium ${
            alert.type === "danger"
              ? "border-[#f0b9a7] bg-[#fff0ea] text-[#9b341b]"
              : "border-[#edd389] bg-[#fff8df] text-[#7a5417]"
          }`}
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>{alert.message}</p>
        </div>
      ))}
    </section>
  );
}
