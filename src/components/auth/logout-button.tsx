"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

const LogoutMenuItemContext = createContext(false);

export function LogoutMenuItemProvider({ children }: { children: ReactNode }) {
  return <LogoutMenuItemContext.Provider value>{children}</LogoutMenuItemContext.Provider>;
}

function LogoutSubmitButton() {
  const { pending } = useFormStatus();
  const isMenuItem = useContext(LogoutMenuItemContext);

  return (
    <Button
      type="submit"
      variant="ghost"
      role={isMenuItem ? "menuitem" : undefined}
      disabled={pending}
      aria-disabled={pending}
      className={isMenuItem
        ? "w-full justify-start border-0 bg-transparent px-3 py-2 shadow-none hover:translate-y-0 hover:bg-[#f4f4f5]"
        : "w-full sm:w-auto"}
    >
      <LogOut size={17} />
      <span aria-live="polite">{pending ? "Cerrando sesión..." : "Cerrar sesión"}</span>
    </Button>
  );
}

export function LogoutButton() {
  return (
    <form action="/auth/logout" method="post">
      <LogoutSubmitButton />
    </form>
  );
}

