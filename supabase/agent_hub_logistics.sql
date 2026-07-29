-- Agent Hub logistics v1
-- Execute this once AFTER agent_hub.sql and agent_hub_inventory.sql.
-- Adds a read-only logistics agent; no ERP or storefront write permission is granted.

alter table public.business_agent_tasks
  drop constraint if exists business_agent_tasks_agent_type_check;

alter table public.business_agent_tasks
  add constraint business_agent_tasks_agent_type_check check (agent_type in
    ('commercial','marketing','finance','collections','logistics','foreign_trade','executive'));

comment on table public.integration_records is
  'Read-only source snapshots. Facto is authoritative for ERP stock and sales; Tiendanube complements web data.';
