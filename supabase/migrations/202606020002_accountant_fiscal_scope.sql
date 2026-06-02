-- Restrict contadora to fiscal/accounting scope and notification preferences.

update public.roles
set
  permissions = '[
    "admin:access",
    "notifications:read",
    "invoices:read",
    "invoices:export",
    "fiscal:read",
    "fiscal:reports",
    "tax:read",
    "tax:export",
    "reports:fiscal_read",
    "reports:fiscal_export"
  ]'::jsonb,
  updated_at = now()
where name = 'contadora';

update public.roles
set
  permissions = (
    select jsonb_agg(distinct permission)
    from jsonb_array_elements_text(
      coalesce(permissions, '[]'::jsonb) ||
      '[
        "invoices:export",
        "fiscal:reports",
        "tax:read",
        "tax:export",
        "reports:fiscal_read",
        "reports:fiscal_export"
      ]'::jsonb
    ) as expanded(permission)
  ),
  updated_at = now()
where name in ('technical_owner', 'business_owner', 'admin');

update public.notification_preferences
set
  destination_roles = array_remove(destination_roles, 'contadora'),
  updated_at = now()
where notification_type in (
  'order.created',
  'order.cancelled',
  'order.no_progress',
  'order.delivered_unpaid',
  'payment.pending',
  'payment.transfer_review',
  'payment.rejected',
  'payment.confirmed',
  'payment.overdue',
  'reservation.expired_review_required',
  'reservation.expiring_soon',
  'reservation.extended',
  'reservation.released',
  'crm.followup_overdue',
  'crm.general_contact',
  'crm.wholesale_request',
  'crm.task_pending',
  'crm.task_overdue',
  'inventory.low_stock',
  'inventory.out_of_stock',
  'inventory.critical_low_stock',
  'inventory.missing_image',
  'inventory.product_disabled',
  'wholesale.request_new',
  'wholesale.request_pending_24h',
  'wholesale.approved',
  'wholesale.rejected',
  'wholesale.suspended',
  'contact.general.created',
  'wholesale.request.created',
  'crm.followup.overdue',
  'crm.task.overdue',
  'reservation.expired',
  'payment.under_review'
);

insert into public.notification_preferences (
  notification_type,
  module,
  label,
  internal_enabled,
  email_enabled,
  push_enabled,
  destination_roles,
  technical_only,
  frequency,
  reminder_window_hours,
  email_required
)
values
  ('invoice.created', 'sistema', 'Nueva factura fiscal generada', true, true, false, array['technical_owner','business_owner','contadora'], false, 'immediate', 0, false),
  ('invoice.cancelled', 'sistema', 'Factura fiscal anulada', true, true, false, array['technical_owner','business_owner','contadora'], false, 'immediate', 0, false),
  ('fiscal.cai_expiring', 'sistema', 'CAI proximo a vencer', true, true, false, array['technical_owner','business_owner','contadora'], false, 'daily', 24, false),
  ('fiscal.cai_expired', 'sistema', 'CAI vencido', true, true, false, array['technical_owner','business_owner','contadora'], false, 'immediate', 24, false),
  ('fiscal.range_low', 'sistema', 'Rango fiscal proximo a agotarse', true, true, false, array['technical_owner','business_owner','contadora'], false, 'daily', 24, false),
  ('fiscal.invoice_error', 'sistema', 'Error al generar factura fiscal', true, true, false, array['technical_owner','business_owner','contadora'], false, 'immediate', 0, false),
  ('fiscal.correlative_invalid', 'sistema', 'Correlativo fiscal bloqueado o invalido', true, true, false, array['technical_owner','business_owner','contadora'], false, 'immediate', 0, false),
  ('fiscal.report_ready', 'sistema', 'Reporte fiscal listo', true, false, false, array['business_owner','contadora'], false, 'manual', 0, false)
on conflict (notification_type) do update
set module = excluded.module,
    label = excluded.label,
    internal_enabled = excluded.internal_enabled,
    email_enabled = excluded.email_enabled,
    push_enabled = excluded.push_enabled,
    destination_roles = excluded.destination_roles,
    technical_only = excluded.technical_only,
    frequency = excluded.frequency,
    reminder_window_hours = excluded.reminder_window_hours,
    email_required = excluded.email_required,
    updated_at = now();

delete from public.notification_user_preferences
where user_id in (
  select users.id
  from public.users
  join public.roles on roles.id = users.role_id
  where roles.name = 'contadora'
)
and notification_type not in (
  'invoice.created',
  'invoice.cancelled',
  'fiscal.cai_expiring',
  'fiscal.cai_expired',
  'fiscal.range_low',
  'fiscal.invoice_error',
  'fiscal.correlative_invalid',
  'fiscal.report_ready'
);

insert into public.audit_logs (actor_role, table_name, action, new_data)
values (
  'system_migration',
  'roles',
  'accountant_fiscal_scope_applied',
  jsonb_build_object(
    'role', 'contadora',
    'scope', 'fiscal_only',
    'removed_operational_notifications', true,
    'fiscal_notifications_enabled', true
  )
);
