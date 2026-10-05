import type { RestConfig } from '../crm-copilot/contracts.ts';

// Called only AFTER live human authentication and active administrator checks.
// Never propagate PostgREST bodies: they can contain credentials or SQL context.
export async function researchAdmin(rest: RestConfig, actor: string, action: string, config: unknown, fetcher: typeof fetch) {
 const response=await fetcher(`${rest.url}/rest/v1/rpc/market_research_admin`,{method:'POST',headers:{apikey:rest.serviceRoleKey,Authorization:`Bearer ${rest.serviceRoleKey}`,'Content-Type':'application/json'},body:JSON.stringify({p_actor:actor,p_action:action,p_config:config}),signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('No se completó la operación. Actualiza el listado antes de reintentar; si existe una credencial sin entregar, revócala.');
 return response.json();
}
