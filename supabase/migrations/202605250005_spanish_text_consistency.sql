-- Normaliza comentarios visibles de metadatos para mantener ortografía consistente.
comment on column public.products.vehicle_year_start is 'Primer año de vehículo compatible, si aplica.';
comment on column public.products.vehicle_year_end is 'Último año de vehículo compatible, si aplica.';

comment on column public.orders.customer_phone is 'Teléfono del cliente al momento de la compra.';
comment on column public.crm_followups.phone is 'Teléfono de contacto para seguimiento.';
comment on column public.payments.payment_method is 'Método de pago usado por el cliente.';
comment on column public.payments.bank_reference_number is 'Número de referencia bancaria reportado por el cliente.';
