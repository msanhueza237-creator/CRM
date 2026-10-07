import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { getWhatsAppConversation, type WhatsAppConversation } from "../../lib/whatsappApi";
import { WhatsAppConversationDialog } from "../campaigns/WhatsAppConversationDialog";
import { whatsAppConsentLabel } from "../../lib/whatsappConsent";
import "./whatsapp-management.css";
export function CompanyWhatsAppSummary({companyId,phone}:{companyId:string;phone:string}) {
  const [data,setData]=useState<WhatsAppConversation|null>(null);const [error,setError]=useState("");const [opened,setOpened]=useState(false);const [now,setNow]=useState(Date.now());
  useEffect(()=>{let active=true;async function refresh(){if(document.hidden)return;try{const result=await getWhatsAppConversation(companyId,phone);if(active){setData(result);setError("");setNow(Date.now());}}catch(e){if(active)setError((e as Error).message);}}void refresh();const timer=window.setInterval(()=>void refresh(),15000);return()=>{active=false;window.clearInterval(timer);};},[companyId,phone,opened]);
  const date=(v?:string|null)=>v?new Date(v).toLocaleString("es-CL"):"Sin registro";
  const isOpen=Boolean(data?.expiresAt&&Date.parse(data.expiresAt)>now);
  return <section className="wa-company-summary"><h2>WhatsApp</h2>{error&&<p role="status">{error}</p>}<dl><div><dt>Número</dt><dd>{phone || "Sin registrar"}</dd></div><div><dt>Ventana 24 h</dt><dd className={isOpen?"wa-window-open":"wa-window-closed"}>{isOpen?"Abierta":"Cerrada"}</dd></div><div><dt>Consentimiento</dt><dd aria-live="polite">{data?whatsAppConsentLabel(data.consent):"Consultando"}</dd></div><div><dt>Último recibido</dt><dd>{date(data?.lastInboundAt)}</dd></div><div><dt>Último enviado</dt><dd>{date(data?.lastOutboundAt)}</dd></div><div><dt>Cierre de ventana</dt><dd>{date(data?.expiresAt)}</dd></div></dl><button className="ghost-button" disabled={!phone} onClick={()=>setOpened(true)}><MessageCircle size={18}/>Abrir conversación</button>{opened&&<WhatsAppConversationDialog companyId={companyId} phone={phone} onClose={()=>setOpened(false)}/>}</section>;
}
