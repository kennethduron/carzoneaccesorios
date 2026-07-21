-- All journal mutations must use the audited transactional RPCs.

drop policy if exists "Accounting create journal entries" on public.journal_entries;
drop policy if exists "Accounting update journal entries" on public.journal_entries;
drop policy if exists "Accounting delete draft journal entries" on public.journal_entries;
drop policy if exists "Accounting create journal lines" on public.journal_entry_lines;
drop policy if exists "Accounting update journal lines" on public.journal_entry_lines;
drop policy if exists "Accounting delete journal lines" on public.journal_entry_lines;

revoke insert, update, delete on public.journal_entries from authenticated;
revoke insert, update, delete on public.journal_entry_lines from authenticated;

grant select on public.journal_entries to authenticated;
grant select on public.journal_entry_lines to authenticated;

comment on table public.journal_entries is
  'Journal headers. Authenticated mutations are restricted to audited transactional RPCs.';
comment on table public.journal_entry_lines is
  'Journal lines. Authenticated mutations are restricted to audited transactional RPCs.';
