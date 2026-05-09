import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
  return (
    <form action="/auth/logout" method="post">
      <Button type="submit" variant="ghost" className="w-full sm:w-auto">
        <LogOut size={17} />
        Cerrar sesion
      </Button>
    </form>
  );
}
