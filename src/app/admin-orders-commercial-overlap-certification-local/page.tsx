import { notFound } from "next/navigation";
import { OrderCommercialTermsCertification } from "@/components/admin/order-commercial-terms-certification";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default function AdminOrdersCommercialOverlapCertificationPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return <OrderCommercialTermsCertification />;
}
