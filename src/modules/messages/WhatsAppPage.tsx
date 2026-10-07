import { useSearchParams } from "react-router-dom";
import { MessageCircle, FileText, Settings } from "lucide-react";
import { MessagesPage } from "./MessagesPage";
import { WhatsAppTemplatesPage } from "./WhatsAppTemplatesPage";
import { useAuth } from "../auth/AuthContext";
import "./whatsapp-management.css";

export function WhatsAppPage() {
  const [params,setParams]=useSearchParams(); const {user}=useAuth();
  const tab=params.get("tab") || "conversations";
  const tabs=[{id:"conversations",label:"Conversaciones",icon:MessageCircle},{id:"templates",label:"Plantillas",icon:FileText},...(user?.role==="administrador"?[{id:"settings",label:"Configuración",icon:Settings}]:[])];
  return <section className="whatsapp-workspace"><h1>WhatsApp</h1><nav className="wa-tabs" aria-label="WhatsApp">{tabs.map(t=><button key={t.id} aria-current={tab===t.id?"page":undefined} onClick={()=>setParams({tab:t.id})}><t.icon size={18}/>{t.label}</button>)}</nav>
    {tab==="templates" || (tab==="settings" && user?.role==="administrador")?<WhatsAppTemplatesPage configuration={tab==="settings"}/>:<MessagesPage/>}
  </section>;
}
