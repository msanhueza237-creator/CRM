-- Additive migration; retains conversations, messages and audit history.
begin;
alter table public.copilot_messages add column if not exists metadata jsonb not null default '{}'::jsonb;
create index if not exists copilot_messages_owner_history_idx
  on public.copilot_messages(user_id, conversation_id, created_at desc, id desc);
create index if not exists copilot_conversations_engine_idx
  on public.copilot_conversations(user_id, (metadata->>'engine'), updated_at desc);
comment on column public.copilot_messages.metadata is 'Structured read results and provenance; never model chain of thought or credentials.';
-- A role downgrade must not reveal financial answers from an earlier session.
drop policy if exists "users can read own copilot conversations" on public.copilot_conversations;
create policy "users can read own copilot conversations" on public.copilot_conversations for select to authenticated
using (public.current_role() = 'administrador' or (
  user_id = auth.uid() and metadata->>'engine' = 'central' and metadata->>'role' = public.current_role()::text
));
drop policy if exists "users can read own copilot messages" on public.copilot_messages;
create policy "users can read own copilot messages" on public.copilot_messages for select to authenticated
using (public.current_role() = 'administrador' or (user_id = auth.uid() and exists (
  select 1 from public.copilot_conversations c where c.id = conversation_id
    and c.user_id = auth.uid() and c.metadata->>'engine' = 'central' and c.metadata->>'role' = public.current_role()::text
)));
drop policy if exists "admins can read copilot tool runs" on public.copilot_tool_runs;
create policy "admins can read copilot tool runs" on public.copilot_tool_runs for select to authenticated
using (public.current_role() = 'administrador' or (user_id = auth.uid() and exists (
  select 1 from public.copilot_conversations c where c.id = conversation_id
    and c.user_id = auth.uid() and c.metadata->>'engine' = 'central' and c.metadata->>'role' = public.current_role()::text
)));
commit;
notify pgrst, 'reload schema';
