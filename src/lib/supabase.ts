import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const demoModeRequested = import.meta.env.VITE_DEMO_MODE === "true";

export const isSupabaseConfigured =
  !demoModeRequested &&
  Boolean(supabaseUrl) &&
  Boolean(supabaseAnonKey) &&
  !supabaseUrl?.includes("your-project") &&
  !supabaseAnonKey?.includes("your-anon-key");

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!)
  : null;

export function getSupabaseFunctionUrl(functionName: string, route = "") {
  if (!supabaseUrl) return "";
  const cleanRoute = route.replace(/^\/+/, "");
  return `${supabaseUrl}/functions/v1/${functionName}${cleanRoute ? `/${cleanRoute}` : ""}`;
}
