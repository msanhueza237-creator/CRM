import { createMarketHandler } from "./handler.ts";
const get=(key:string)=>Deno.env.get(key)?.trim()||"";
Deno.serve(createMarketHandler({rest:{url:get('SUPABASE_URL').replace(/\/+$/,''),anonKey:get('SUPABASE_ANON_KEY'),serviceRoleKey:get('SUPABASE_SERVICE_ROLE_KEY')},origin:new URL(get('CRM_APP_URL')||'http://localhost:5173').origin,currencyMap:get('FACTO_CURRENCY_MAP_JSON')}));
