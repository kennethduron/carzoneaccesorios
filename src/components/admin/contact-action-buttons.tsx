"use client";

import { ContactActions } from "@/components/contact-actions";

type ContactActionButtonsProps = {
  phone: string | null | undefined;
  className?: string;
};

export function ContactActionButtons({ phone, className = "" }: ContactActionButtonsProps) {
  return <ContactActions phone={phone} customerName="cliente" className={className} />;
}
