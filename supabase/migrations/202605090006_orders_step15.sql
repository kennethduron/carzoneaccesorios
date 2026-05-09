alter type public.order_status add value if not exists 'recibido';
alter type public.order_status add value if not exists 'confirmado';
alter type public.order_status add value if not exists 'preparacion';
alter type public.order_status add value if not exists 'empacado';
alter type public.order_status add value if not exists 'enviado';
alter type public.order_status add value if not exists 'en_ruta';
alter type public.order_status add value if not exists 'entregado';
alter type public.order_status add value if not exists 'cancelado';

create index if not exists orders_order_number_status_idx on public.orders(order_number, status);
create index if not exists orders_phone_idx on public.orders(phone);
