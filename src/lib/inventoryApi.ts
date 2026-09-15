import { getSupabaseFunctionUrl, supabase } from "./supabase";
import type { CopilotReadResult } from "./copilotCentralApi";

export interface InventoryCurrency {
  currency: string;
  cost_verified?: number | null;
  cost_conditional?: number | null;
  cost_reference?: number | null;
  cost_products?: number;
  conditional_cost_products?: number;
  net_sale_value: number | null;
  sale_products: number;
}
export interface InventoryRecord {
  sku: string;
  name: string;
  brand: string;
  stock: number | null;
  net_price: number | null;
  price_currency: string | null;
  net_sale_value: number | null;
  unit_cost?: number | null;
  cost_currency?: string | null;
  assumed_cost_currency?: string | null;
  cost_reference_value?: number | null;
  stock_updated_at: string | null;
  cost_updated_at?: string | null;
  price_updated_at: string | null;
}
export interface InventoryResult extends CopilotReadResult {
  data: {
    records: InventoryRecord[];
    totals: {
      matched_products: number;
      available_products: number;
      available_units: number | null;
      unknown_stock_products: number;
      missing_confirmed_cost_products?: number;
      conditional_cost_products?: number;
      missing_cost_products?: number;
      missing_price_products: number;
      by_currency: InventoryCurrency[];
    };
    available_lists: string[];
    available_brands: string[];
    source_dates: { oldest: string | null; newest: string | null };
  };
}
export async function getInventoryValuation(args: Record<string, string | number>, signal?: AbortSignal): Promise<InventoryResult> {
  const token = (await supabase?.auth.getSession())?.data.session?.access_token;
  if (!token) throw new Error("Inicia sesión para consultar el inventario.");
  const params = new URLSearchParams(Object.entries(args).filter(([, v]) => v !== "").map(([key, value]) => [key, String(value)]));
  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", `inventory?${params}`), {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal,
  });
  const payload = await response.json();
  if (!response.ok || !["ok", "partial", "empty"].includes(payload.status) || !payload.data?.totals || !Array.isArray(payload.data?.records)) {
    throw new Error(payload.error || payload.summary || "Inventario no disponible. No se sustituyen sus valores por cero.");
  }
  return payload as InventoryResult;
}
