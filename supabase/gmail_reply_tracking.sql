-- Seguimiento de respuestas Gmail para campañas.
-- Permite marcar destinatarios que respondieron y evitar duplicar interacciones.

alter table public.email_campaign_recipients
  add column if not exists replied_at timestamptz,
  add column if not exists reply_from_email text,
  add column if not exists reply_subject text,
  add column if not exists reply_snippet text,
  add column if not exists reply_body text,
  add column if not exists reply_gmail_message_id text;

create index if not exists email_campaign_recipients_replied_at_idx
  on public.email_campaign_recipients(replied_at desc)
  where replied_at is not null;

create index if not exists email_campaign_recipients_pending_reply_idx
  on public.email_campaign_recipients(status, sent_at desc)
  where status = 'sent' and replied_at is null and gmail_message_id is not null;

comment on column public.email_campaign_recipients.replied_at is
  'Fecha en que Gmail detecto una respuesta del destinatario dentro del hilo de la campana.';

comment on column public.email_campaign_recipients.reply_body is
  'Texto limpio y acotado de la respuesta detectada por Gmail; el hilo completo queda en Gmail.';
