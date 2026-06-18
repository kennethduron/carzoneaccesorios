import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export function AdminBackButton() {
  return (
    <div className="mb-5">
      <Link href="/admin" className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm">
        <ArrowLeft size={16} />
        Panel administrativo
      </Link>
    </div>
  );
}
