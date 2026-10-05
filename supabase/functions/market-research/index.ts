import { createResearchHandler } from './handler.ts';
const get = (key: string) => Deno.env.get(key)?.trim() || '';
Deno.serve(createResearchHandler({ url: get('SUPABASE_URL').replace(/\/+$/, ''), serviceRoleKey: get('SUPABASE_SERVICE_ROLE_KEY'), readEnv: name => Deno.env.get(name) }));
