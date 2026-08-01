-- Read-only presentation details for an already calculated canonical customer merge preview.
-- This migration is additive and never creates a merge operation or changes customer data.

create or replace function public.get_customer_merge_history_details_v1(
  p_primary_customer_id uuid,
  p_secondary_customer_id uuid,
  p_preview_hash text,
  p_expected_primary_commercial_version integer,
  p_expected_secondary_commercial_version integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role text := public.current_actor_role();
  can_view_financial boolean;
  preview jsonb;
  primary_root uuid;
  secondary_root uuid;
  items jsonb;
  summary jsonb;
begin
  if auth.uid() is null
     or actor_role not in ('technical_owner', 'business_owner', 'admin')
     or not (public.has_permission('customers:merge') or public.has_permission('customers:manage')) then
    raise exception using errcode = '42501', message = 'CUSTOMER_MERGE_DETAILS_FORBIDDEN';
  end if;

  if p_primary_customer_id is null
     or p_secondary_customer_id is null
     or p_primary_customer_id = p_secondary_customer_id then
    raise exception using errcode = '22023', message = 'CUSTOMER_MERGE_DISTINCT_CUSTOMERS_REQUIRED';
  end if;

  if coalesce(p_preview_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'CUSTOMER_MERGE_INVALID_PREVIEW_HASH';
  end if;

  preview := public.preview_customer_merge_v1(p_primary_customer_id, p_secondary_customer_id);
  primary_root := (preview ->> 'primaryCustomerId')::uuid;
  secondary_root := (preview ->> 'secondaryCustomerId')::uuid;

  if preview ->> 'previewHash' <> p_preview_hash then
    raise exception using errcode = '40001', message = 'CUSTOMER_MERGE_PREVIEW_STALE';
  end if;

  if (preview ->> 'primaryCommercialVersion')::integer <> p_expected_primary_commercial_version
     or (preview ->> 'secondaryCommercialVersion')::integer <> p_expected_secondary_commercial_version then
    raise exception using errcode = '40001', message = 'CUSTOMER_MERGE_COMMERCIAL_VERSION_CONFLICT';
  end if;

  can_view_financial := actor_role in ('technical_owner', 'business_owner')
    or public.has_permission('payments:read')
    or public.has_permission('accounting:read');

  with
  primary_family as (
    select customer_id from public.get_customer_family_ids_v1(primary_root)
  ),
  secondary_family as (
    select customer_id from public.get_customer_family_ids_v1(secondary_root)
  ),
  family as (
    select customer_id, 'primary'::text source_key, 'Cliente principal'::text source_label from primary_family
    union all
    select customer_id, 'secondary'::text, 'Registro secundario'::text from secondary_family
  ),
  family_orders as (
    select o.*, f.source_key, f.source_label
    from public.orders o
    join family f on f.customer_id = o.customer_id
  ),
  family_invoices as (
    select i.*, f.source_key, f.source_label
    from public.invoices i
    join family f on f.customer_id = i.customer_id
  ),
  family_payments as (
    select p.*, f.source_key, f.source_label, o.order_number
    from public.payments p
    join family f on f.customer_id = p.customer_id
    left join public.orders o on o.id = p.order_id
  ),
  family_receivables as (
    select ar.*, f.source_key, f.source_label, o.order_number, i.invoice_number
    from public.accounts_receivable ar
    join family f on f.customer_id = ar.customer_id
    left join public.orders o on o.id = ar.order_id
    left join public.invoices i on i.id = ar.invoice_id
  ),
  family_receivable_payments as (
    select arp.*, f.source_key, f.source_label, o.order_number,
      coalesce(ar.historical_invoice_number, i.invoice_number) invoice_number
    from public.accounts_receivable_payments arp
    join family f on f.customer_id = arp.customer_id
    left join public.orders o on o.id = arp.order_id
    left join public.accounts_receivable ar on ar.id = arp.receivable_id
    left join public.invoices i on i.id = ar.invoice_id
  ),
  accounting_entry_ids as (
    select distinct je.id
    from public.journal_entries je
    join public.journal_entry_lines jel on jel.journal_entry_id = je.id
    where jel.customer_id in (select customer_id from family)
    union
    select distinct je.id
    from public.journal_entries je
    join family_orders o on je.source_id = o.id::text
  ),
  family_entries as (
    select je.*,
      coalesce(
        (select jel.customer_id from public.journal_entry_lines jel where jel.journal_entry_id = je.id and jel.customer_id in (select customer_id from family) limit 1),
        (select o.customer_id from family_orders o where o.id::text = je.source_id limit 1)
      ) source_customer_id,
      coalesce((select sum(jel.debit) from public.journal_entry_lines jel where jel.journal_entry_id = je.id), 0) total_debit,
      coalesce((select sum(jel.credit) from public.journal_entry_lines jel where jel.journal_entry_id = je.id), 0) total_credit
    from public.journal_entries je
    join accounting_entry_ids ids on ids.id = je.id
  ),
  family_reservations as (
    select r.*, o.customer_id, o.order_number, o.source_key, o.source_label
    from public.inventory_reservations r
    join family_orders o on o.id = r.order_id
  ),
  family_movements as (
    select im.*, o.customer_id, o.order_number, o.source_key, o.source_label
    from public.inventory_movements im
    join family_orders o on o.id = im.reference_id
  ),
  family_notes as (
    select n.*, f.source_key, f.source_label
    from public.crm_notes n
    join family f on f.customer_id = n.customer_id
  ),
  family_followups as (
    select cf.*, f.source_key, f.source_label
    from public.crm_followups cf
    join family f on f.customer_id = cf.customer_id
  ),
  family_checkout as (
    select cr.*, f.source_key, f.source_label
    from public.checkout_requests_v4 cr
    join family f on f.customer_id = cr.customer_id
  ),
  item_rows as (
    select o.created_at sort_date, 'order'::text sort_category, o.order_number sort_reference,
      jsonb_build_object(
        'category', 'order', 'id', o.id, 'reference', o.order_number, 'title', 'Pedido',
        'date', o.created_at, 'status', o.status::text,
        'statusLabel', case
          when o.status::text in ('delivered', 'entregado')
            and exists (select 1 from public.payments p where p.order_id = o.id and coalesce(p.payment_status, p.status)::text = 'approved')
            then 'Entregado y pagado'
          else initcap(replace(o.status::text, '_', ' '))
        end,
        'amount', o.total, 'currency', 'HNL', 'sourceCustomerId', o.customer_id,
        'sourceCustomerLabel', o.source_label, 'action', 'remain_historical',
        'actionLabel', 'Conservará su referencia histórica y será visible desde el cliente principal.',
        'visibilityAfterMerge', 'visible_from_primary', 'protected', true,
        'details', jsonb_strip_nulls(jsonb_build_object(
          'priceMode', o.price_mode, 'modalityLabel', case when o.price_mode::text = 'wholesale' then 'Mayoreo' else 'Detalle' end,
          'trackingCode', o.tracking_code
        ))
      ) item
    from family_orders o

    union all
    select coalesce(i.issued_at, i.created_at), 'invoice', i.invoice_number,
      jsonb_build_object(
        'category', 'invoice', 'id', i.id, 'reference', i.invoice_number, 'title', 'Factura',
        'date', coalesce(i.issued_at, i.created_at), 'status', i.status::text,
        'statusLabel', initcap(replace(i.status::text, '_', ' ')), 'amount', i.total, 'currency', 'HNL',
        'sourceCustomerId', i.customer_id, 'sourceCustomerLabel', i.source_label,
        'action', 'preserve_immutable', 'actionLabel', 'No será modificada.',
        'visibilityAfterMerge', 'visible_from_primary', 'protected', true,
        'details', jsonb_build_object('subtotal', i.subtotal, 'tax', i.tax)
      )
    from family_invoices i

    union all
    select coalesce(p.paid_at, p.created_at), 'payment', coalesce(nullif(p.reference, ''), nullif(p.bank_reference_number, ''), p.order_number, 'Pago'),
      jsonb_build_object(
        'category', 'payment', 'id', p.id,
        'reference', coalesce(nullif(p.reference, ''), nullif(p.bank_reference_number, ''), 'Pago del pedido ' || coalesce(p.order_number, 'sin referencia')),
        'title', 'Pago', 'date', coalesce(p.paid_at, p.created_at),
        'status', coalesce(p.payment_status, p.status)::text,
        'statusLabel', case when coalesce(p.payment_status, p.status)::text = 'approved' then 'Pagado' else initcap(replace(coalesce(p.payment_status, p.status)::text, '_', ' ')) end,
        'amount', p.amount, 'currency', 'HNL', 'sourceCustomerId', p.customer_id,
        'sourceCustomerLabel', p.source_label, 'action', 'preserve_immutable',
        'actionLabel', 'No será modificado.', 'visibilityAfterMerge', 'visible_from_primary', 'protected', true,
        'details', jsonb_strip_nulls(jsonb_build_object(
          'orderNumber', p.order_number,
          'method', case when can_view_financial then coalesce(p.payment_method, p.method)::text else null end
        ))
      )
    from family_payments p

    union all
    select ar.created_at, 'receivable', coalesce(ar.invoice_number, ar.historical_invoice_number, ar.order_number, 'Cuenta por cobrar'),
      jsonb_build_object(
        'category', 'receivable', 'id', ar.id,
        'reference', coalesce(ar.invoice_number, ar.historical_invoice_number, ar.order_number, 'Cuenta por cobrar'),
        'title', 'Cuenta por cobrar', 'date', ar.created_at, 'status', ar.status,
        'statusLabel', initcap(replace(ar.status, '_', ' ')), 'amount', ar.balance_due, 'currency', 'HNL',
        'sourceCustomerId', ar.customer_id, 'sourceCustomerLabel', ar.source_label,
        'action', 'move_to_primary', 'actionLabel', 'Será trasladada al cliente principal sin recrearse.',
        'visibilityAfterMerge', 'owned_by_primary', 'protected', false,
        'details', jsonb_build_object('originalAmount', ar.original_amount, 'balanceDue', ar.balance_due, 'dueDate', ar.due_date)
      )
    from family_receivables ar

    union all
    select arp.received_at, 'receivable_payment', coalesce(nullif(arp.reference, ''), arp.invoice_number, arp.order_number, 'Abono'),
      jsonb_build_object(
        'category', 'receivable_payment', 'id', arp.id,
        'reference', coalesce(nullif(arp.reference, ''), 'Abono de ' || coalesce(arp.invoice_number, arp.order_number, 'cuenta por cobrar')),
        'title', 'Abono a CxC', 'date', arp.received_at,
        'status', case when arp.voided_at is null then 'applied' else 'voided' end,
        'statusLabel', case when arp.voided_at is null then 'Aplicado' else 'Anulado' end,
        'amount', arp.amount, 'currency', 'HNL', 'sourceCustomerId', arp.customer_id,
        'sourceCustomerLabel', arp.source_label, 'action', 'move_to_primary',
        'actionLabel', 'Será trasladado al cliente principal sin cambiar el importe.',
        'visibilityAfterMerge', 'owned_by_primary', 'protected', false,
        'details', jsonb_strip_nulls(jsonb_build_object('method', case when can_view_financial then arp.payment_method else null end))
      )
    from family_receivable_payments arp

    union all
    select coalesce(fe.posted_at, fe.created_at), 'accounting_entry', fe.entry_number,
      jsonb_build_object(
        'category', 'accounting_entry', 'id', fe.id, 'reference', fe.entry_number,
        'title', 'Partida contable', 'date', fe.entry_date, 'status', fe.status,
        'statusLabel', initcap(replace(fe.status, '_', ' ')), 'amount', null, 'currency', 'HNL',
        'sourceCustomerId', fe.source_customer_id,
        'sourceCustomerLabel', coalesce((select f.source_label from family f where f.customer_id = fe.source_customer_id limit 1), 'Historial relacionado'),
        'action', 'preserve_immutable', 'actionLabel', 'No será modificada.',
        'visibilityAfterMerge', 'visible_from_primary', 'protected', true,
        'details', jsonb_build_object('debit', fe.total_debit, 'credit', fe.total_credit, 'sourceType', fe.source_type)
      )
    from family_entries fe

    union all
    select r.created_at, 'inventory_reservation', r.order_number || ':' || r.id::text,
      jsonb_build_object(
        'category', 'inventory_reservation', 'id', r.id, 'reference', 'Reserva del pedido ' || r.order_number,
        'title', 'Reserva de inventario', 'date', r.created_at, 'status', r.status,
        'statusLabel', initcap(replace(r.status, '_', ' ')), 'amount', null, 'currency', null,
        'sourceCustomerId', r.customer_id, 'sourceCustomerLabel', r.source_label,
        'action', 'preserve_immutable', 'actionLabel', 'No se crearán ni modificarán reservas.',
        'visibilityAfterMerge', 'visible_from_primary', 'protected', true,
        'details', jsonb_build_object('quantity', r.quantity, 'orderNumber', r.order_number)
      )
    from family_reservations r

    union all
    select im.created_at, 'inventory_movement', im.order_number || ':' || im.id::text,
      jsonb_build_object(
        'category', 'inventory_movement', 'id', im.id, 'reference', 'Movimiento del pedido ' || im.order_number,
        'title', 'Movimiento de inventario', 'date', im.created_at, 'status', im.movement_type::text,
        'statusLabel', initcap(replace(im.movement_type::text, '_', ' ')), 'amount', null, 'currency', null,
        'sourceCustomerId', im.customer_id, 'sourceCustomerLabel', im.source_label,
        'action', 'preserve_immutable', 'actionLabel', 'No se crearán ni modificarán movimientos.',
        'visibilityAfterMerge', 'visible_from_primary', 'protected', true,
        'details', jsonb_build_object('quantity', im.quantity, 'orderNumber', im.order_number)
      )
    from family_movements im

    union all
    select n.created_at, 'crm_note', n.id::text,
      jsonb_build_object(
        'category', 'crm_note', 'id', n.id,
        'reference', 'Nota CRM del ' || to_char(n.created_at at time zone 'America/Tegucigalpa', 'DD/MM/YYYY'),
        'title', 'Nota CRM', 'date', n.created_at, 'status', case when n.archived_at is null then 'active' else 'archived' end,
        'statusLabel', case when n.archived_at is null then 'Activa' else 'Archivada' end,
        'amount', null, 'currency', null, 'sourceCustomerId', n.customer_id,
        'sourceCustomerLabel', n.source_label, 'action', 'move_to_primary',
        'actionLabel', 'Será trasladada al cliente principal.', 'visibilityAfterMerge', 'owned_by_primary',
        'protected', false,
        'details', jsonb_build_object('contentPolicy', 'El contenido completo permanece protegido en CRM.')
      )
    from family_notes n

    union all
    select cf.created_at, 'crm_followup', cf.title,
      jsonb_build_object(
        'category', 'crm_followup', 'id', cf.id, 'reference', cf.title,
        'title', 'Seguimiento CRM', 'date', coalesce(cf.due_at, cf.created_at), 'status', cf.status::text,
        'statusLabel', initcap(replace(cf.status::text, '_', ' ')), 'amount', null, 'currency', null,
        'sourceCustomerId', cf.customer_id, 'sourceCustomerLabel', cf.source_label,
        'action', 'move_to_primary', 'actionLabel', 'Será trasladado al cliente principal.',
        'visibilityAfterMerge', 'owned_by_primary', 'protected', false,
        'details', jsonb_build_object('dueAt', cf.due_at)
      )
    from family_followups cf

    union all
    select cr.created_at, 'checkout_request', coalesce(cr.order_number, cr.request_key::text),
      jsonb_build_object(
        'category', 'checkout_request', 'id', cr.id,
        'reference', coalesce(cr.order_number, 'Solicitud Checkout confirmada'),
        'title', 'Solicitud Checkout V4', 'date', cr.created_at, 'status', cr.status,
        'statusLabel', initcap(replace(cr.status, '_', ' ')), 'amount', cr.total, 'currency', 'HNL',
        'sourceCustomerId', cr.customer_id, 'sourceCustomerLabel', cr.source_label,
        'action', 'preserve_immutable', 'actionLabel', 'No será modificada.',
        'visibilityAfterMerge', 'visible_from_primary', 'protected', true,
        'details', jsonb_build_object('orderNumber', cr.order_number)
      )
    from family_checkout cr
  )
  select
    coalesce((select jsonb_agg(item order by sort_date desc, sort_category, sort_reference) from item_rows), '[]'::jsonb),
    jsonb_build_object(
      'orders', jsonb_build_object('state', case when (select count(*) from family_orders) = 0 then 'empty' else 'available' end, 'count', (select count(*) from family_orders), 'total', coalesce((select sum(total) from family_orders), 0)),
      'invoices', jsonb_build_object('state', case when (select count(*) from family_invoices) = 0 then 'empty' else 'available' end, 'count', (select count(*) from family_invoices), 'total', coalesce((select sum(total) from family_invoices), 0)),
      'payments', jsonb_build_object('state', case when (select count(*) from family_payments) = 0 then 'empty' else 'available' end, 'count', (select count(*) from family_payments), 'total', coalesce((select sum(amount) from family_payments), 0)),
      'receivables', jsonb_build_object('state', case when (select count(*) from family_receivables) = 0 then 'empty' else 'available' end, 'count', (select count(*) from family_receivables), 'originalTotal', coalesce((select sum(original_amount) from family_receivables), 0), 'openBalance', coalesce((select sum(balance_due) from family_receivables), 0)),
      'receivablePayments', jsonb_build_object('state', case when (select count(*) from family_receivable_payments) = 0 then 'empty' else 'available' end, 'count', (select count(*) from family_receivable_payments), 'total', coalesce((select sum(amount) from family_receivable_payments where voided_at is null), 0)),
      'accountingEntries', jsonb_build_object('state', case when (select count(*) from family_entries) = 0 then 'empty' else 'available' end, 'count', (select count(*) from family_entries), 'debit', coalesce((select sum(total_debit) from family_entries), 0), 'credit', coalesce((select sum(total_credit) from family_entries), 0)),
      'reservations', jsonb_build_object('state', case when (select count(*) from family_reservations) = 0 then 'empty' else 'available' end, 'count', (select count(*) from family_reservations), 'quantity', coalesce((select sum(quantity) from family_reservations), 0)),
      'inventoryMovements', jsonb_build_object('state', case when (select count(*) from family_movements) = 0 then 'empty' else 'available' end, 'count', (select count(*) from family_movements), 'quantity', coalesce((select sum(quantity) from family_movements), 0)),
      'crmNotes', jsonb_build_object('state', case when (select count(*) from family_notes) = 0 then 'empty' else 'available' end, 'count', (select count(*) from family_notes)),
      'crmFollowups', jsonb_build_object('state', case when (select count(*) from family_followups) = 0 then 'empty' else 'available' end, 'count', (select count(*) from family_followups)),
      'checkoutRequests', jsonb_build_object('state', case when (select count(*) from family_checkout) = 0 then 'empty' else 'available' end, 'count', (select count(*) from family_checkout))
    )
  into items, summary;

  return jsonb_build_object(
    'presentationVersion', 1,
    'primaryCustomerId', primary_root,
    'secondaryCustomerId', secondary_root,
    'primaryCommercialVersion', (preview ->> 'primaryCommercialVersion')::integer,
    'secondaryCommercialVersion', (preview ->> 'secondaryCommercialVersion')::integer,
    'previewHash', preview ->> 'previewHash',
    'items', items,
    'summary', summary,
    'archiveConsequence', jsonb_build_object(
      'action', 'archive_with_secondary',
      'label', 'El registro secundario no se eliminará físicamente; quedará archivado como registro unificado.'
    ),
    'assurances', jsonb_build_array(
      jsonb_build_object('code', 'prices', 'label', 'No se modificarán los precios.'),
      jsonb_build_object('code', 'invoice', 'label', 'No se modificará la factura.'),
      jsonb_build_object('code', 'payment', 'label', 'No se modificará el pago.'),
      jsonb_build_object('code', 'inventory', 'label', 'No se modificará el inventario.'),
      jsonb_build_object('code', 'accounting', 'label', 'No se modificará la contabilidad.'),
      jsonb_build_object(
        'code', 'credit',
        'label', case when preview -> 'requiredDecisions' ? 'credit'
          then 'Los límites de crédito no se sumarán; se conservará únicamente la configuración elegida.'
          else 'No se modificará el crédito aprobado.' end
      ),
      jsonb_build_object(
        'code', 'wholesale',
        'label', case when preview -> 'requiredDecisions' ? 'commercial'
          then 'Se conservará únicamente la configuración mayorista elegida.'
          else 'No se modificará el acceso mayorista aprobado.' end
      )
    )
  );
end;
$$;

revoke all on function public.get_customer_merge_history_details_v1(uuid, uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.get_customer_merge_history_details_v1(uuid, uuid, text, integer, integer)
  to authenticated, service_role;

comment on function public.get_customer_merge_history_details_v1(uuid, uuid, text, integer, integer) is
  'Read-only material presentation contract tied to a canonical customer merge preview hash and commercial versions.';
