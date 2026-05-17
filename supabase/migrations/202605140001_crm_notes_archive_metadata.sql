alter table public.crm_notes
  add column if not exists note_type text not null default 'nota',
  add column if not exists archived_at timestamp with time zone;

create index if not exists crm_notes_archived_at_idx on public.crm_notes(archived_at);

comment on column public.crm_notes.note_type is 'Tipo visible de nota CRM: nota, llamada, acuerdo, duda u otro valor operativo.';
comment on column public.crm_notes.archived_at is 'Fecha en que la nota fue archivada desde el panel CRM.';
