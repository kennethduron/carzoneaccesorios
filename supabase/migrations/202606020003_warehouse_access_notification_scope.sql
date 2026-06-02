-- Keep bodega scoped to logistics/inventory notifications and away from payment events.

update public.notification_preferences
set
  destination_roles = array_remove(destination_roles, 'bodega'),
  updated_at = now()
where notification_type in (
  'payment.pending',
  'payment.transfer_review',
  'payment.rejected',
  'payment.confirmed',
  'payment.overdue',
  'invoice.created',
  'invoice.cancelled',
  'fiscal.cai_expiring',
  'fiscal.cai_expired',
  'fiscal.range_low',
  'fiscal.invoice_error',
  'fiscal.correlative_invalid',
  'fiscal.report_ready',
  'crm.followup_overdue',
  'crm.general_contact',
  'crm.wholesale_request',
  'crm.task_pending',
  'crm.task_overdue',
  'wholesale.request_new',
  'wholesale.request_pending_24h',
  'wholesale.approved',
  'wholesale.rejected',
  'wholesale.suspended',
  'system.cron_failed',
  'system.backup_failed',
  'system.email_failed',
  'system.cloudinary_high_usage',
  'system.critical_error'
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
  ('order.ready_to_prepare', 'pedidos', 'Pedido listo para preparar', true, false, false, array['bodega'], false, 'immediate', 0, false),
  ('order.logistics_review', 'pedidos', 'Revision logistica requerida', true, false, false, array['bodega','admin'], false, 'immediate', 12, false)
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
  where roles.name = 'bodega'
)
and notification_type in (
  'payment.pending',
  'payment.transfer_review',
  'payment.rejected',
  'payment.confirmed',
  'payment.overdue',
  'invoice.created',
  'invoice.cancelled',
  'fiscal.cai_expiring',
  'fiscal.cai_expired',
  'fiscal.range_low',
  'fiscal.invoice_error',
  'fiscal.correlative_invalid',
  'fiscal.report_ready',
  'crm.followup_overdue',
  'crm.general_contact',
  'crm.wholesale_request',
  'crm.task_pending',
  'crm.task_overdue',
  'wholesale.request_new',
  'wholesale.request_pending_24h'
);

insert into public.audit_logs (actor_role, table_name, action, new_data)
values (
  'system_migration',
  'notification_preferences',
  'warehouse_notification_scope_applied',
  jsonb_build_object(
    'role', 'bodega',
    'removed_payment_notifications', true,
    'logistics_notifications_added', true,
    'warehouse_email_default', 'user_opt_in_only'
  )
);
