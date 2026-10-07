import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export type DeliveryRow = {
  id: string; meta_message_id: string | null; phone_number: string; status: string;
  template_name: string | null; template_language: string | null; template_meta_id: string | null;
  sent_at: string | null; delivered_at: string | null; read_at: string | null; failed_at: string | null;
};
export function summarizeWhatsAppDelivery(rows: DeliveryRow[]) {
  const unique = [...new Map(rows.map(row => [row.meta_message_id || row.id, row])).values()];
  const count = (predicate: (row: DeliveryRow) => boolean) => unique.filter(predicate).length;
  const read = (row: DeliveryRow) => Boolean(row.read_at);
  const delivered = (row: DeliveryRow) => Boolean(row.delivered_at || read(row));
  const sent = (row: DeliveryRow) => Boolean(row.sent_at || delivered(row));
  const totals = {
    attempts: unique.length, accepted: count(row => Boolean(row.meta_message_id)),
    sent: count(sent), delivered: count(delivered), read: count(read),
    failed: count(row => row.status === "failed" && !delivered(row)),
    pending: count(row => !sent(row) && row.status !== "failed"),
    readRecipients: new Set(unique.filter(read).map(row => row.phone_number.replace(/\D/g, ""))).size,
    readRate: count(delivered) ? count(read) / count(delivered) : null,
  };
  const groups = new Map<string, DeliveryRow[]>();
  for (const row of unique) {
    const key = JSON.stringify([row.template_meta_id, row.template_name, row.template_language]);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return { ...totals, templates: [...groups.values()].map(group => ({
    id: group[0].template_meta_id || group[0].template_name || "unknown",
    name: group[0].template_name || "Sin plantilla", language: group[0].template_language || "Sin idioma",
    accepted: group.filter(row => row.meta_message_id).length,
    sent: group.filter(sent).length, delivered: group.filter(delivered).length, read: group.filter(read).length,
    failed: group.filter(row => row.status === "failed" && !delivered(row)).length,
  })).sort((a,b) => b.accepted-a.accepted || a.name.localeCompare(b.name)) };
}
export async function getWhatsAppDelivery(db: SupabaseClient, campaignId: string) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(campaignId)) throw new Error("Campaña inválida.");
  const {data: campaign, error} = await db.from("campaigns").select("id").eq("id",campaignId).maybeSingle();
  if (error || !campaign) throw new Error("No se pudo consultar la campaña.");
  const rows: DeliveryRow[] = [];
  for (let offset=0; ; offset+=500) {
    const {data,error: readError} = await db.from("whatsapp_messages")
      .select("id,meta_message_id,phone_number,status,template_name,template_language,template_meta_id,sent_at,delivered_at,read_at,failed_at")
      .eq("direction","outbound").eq("message_type","template").contains("raw_payload",{campaign_id:campaignId})
      .order("id").range(offset,offset+499);
    if(readError) throw new Error("No se pudieron consultar las confirmaciones de Meta.");
    rows.push(...(data || []));
    if(!data || data.length<500) break;
  }
  return {...summarizeWhatsAppDelivery(rows), checkedAt:new Date().toISOString()};
}
