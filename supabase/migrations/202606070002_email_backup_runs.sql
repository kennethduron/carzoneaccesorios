alter table public.backup_runs
  drop constraint if exists backup_runs_type_check;

alter table public.backup_runs
  add constraint backup_runs_type_check
  check (type in ('manual', 'daily', 'weekly', 'monthly', 'scheduled', 'pre_deploy', 'manual_email', 'scheduled_email'));

alter table public.backup_runs
  add column if not exists recipient_email text,
  add column if not exists delivery_provider text,
  add column if not exists delivery_message_id text;

create index if not exists backup_runs_recipient_email_idx
  on public.backup_runs(recipient_email);

create index if not exists backup_runs_delivery_provider_idx
  on public.backup_runs(delivery_provider);

