-- Agent Hub inventory analysis v1
-- Execute this once AFTER supabase/agent_hub.sql.
-- It persists evidence-backed replenishment recommendations and opens a
-- review alert. It never creates or sends a purchase order.

create or replace function public.complete_business_agent_task(
 p_task_id uuid,p_worker_id text,p_lease_token uuid,p_result jsonb
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_proposal jsonb;
  v_evidence jsonb;
  v_inventory jsonb;
  v_recommendation_id uuid;
begin
 update public.business_agent_tasks set status='completed',result=p_result,
   completed_at=now(),updated_at=now(),lease_expires_at=null
 where id=p_task_id and status='in_progress' and worker_id=p_worker_id and lease_token=p_lease_token;
 if not found then raise exception 'lease_lost'; end if;

 for v_proposal in select value from jsonb_array_elements(coalesce(p_result->'proposals','[]'::jsonb))
 loop
   insert into public.action_proposals(task_id,kind,title,summary,payload,risk_level)
   values(p_task_id,v_proposal->>'kind',v_proposal->>'title',v_proposal->>'summary',
     coalesce(v_proposal->'payload','{}'::jsonb),coalesce(v_proposal->>'risk_level','medium'));
 end loop;

 for v_evidence in select value from jsonb_array_elements(coalesce(p_result->'evidence','[]'::jsonb))
 loop
   v_inventory := v_evidence->'inventory_recommendation';
   if v_inventory is null or jsonb_typeof(v_inventory) <> 'object' then continue; end if;
   if coalesce(v_inventory->>'sku','') = '' then continue; end if;

   insert into public.replenishment_recommendations(
     task_id,sku,available_units,committed_units,confirmed_inbound_units,
     reorder_point_units,target_units,recommended_units,recommended_value_usd,
     required_order_date,projected_stockout_date,severity,purchase_policy,warnings
   ) values (
     p_task_id,
     v_inventory->>'sku',
     coalesce((v_inventory->>'available_units')::numeric,0),
     coalesce((v_inventory->>'committed_units')::numeric,0),
     coalesce((v_inventory->>'confirmed_inbound_units')::numeric,0),
     coalesce((v_inventory->>'reorder_point_units')::numeric,0),
     coalesce((v_inventory->>'target_units')::numeric,0),
     coalesce((v_inventory->>'recommended_units')::numeric,0),
     coalesce((v_inventory->>'recommended_value_usd')::numeric,0),
     nullif(v_inventory->>'required_order_date','')::date,
     nullif(v_inventory->>'projected_stockout_date','')::date,
     coalesce(v_inventory->>'severity','medium'),
     coalesce(v_inventory->>'purchase_policy','no_purchase'),
     coalesce(v_inventory->'warnings','[]'::jsonb)
   ) returning id into v_recommendation_id;

   if coalesce(v_inventory->>'severity','low') in ('high','critical') then
     insert into public.inventory_risk_alerts(
       sku,severity,title,detail,recommendation_id
     )
     select
       v_inventory->>'sku',
       v_inventory->>'severity',
       'Riesgo de quiebre: ' || v_inventory->>'sku',
       'Cobertura estimada bajo el punto de reposicion. Sugerencia: ' ||
         coalesce(v_inventory->>'recommended_units','0') || ' unidades; politica ' ||
         coalesce(v_inventory->>'purchase_policy','no_purchase') || '.',
       v_recommendation_id
     where not exists (
       select 1 from public.inventory_risk_alerts
       where sku=v_inventory->>'sku' and status in ('open','acknowledged')
     );
   end if;
 end loop;
end $$;

revoke all on function public.complete_business_agent_task(uuid,text,uuid,jsonb) from public;
grant execute on function public.complete_business_agent_task(uuid,text,uuid,jsonb) to service_role;
