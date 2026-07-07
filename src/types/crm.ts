export type CompanyType = "distribuidor" | "tienda comercial" | "tecnico" | "instalador grande" | "competencia" | "otro";
export type CompanyStatus = "prospecto" | "contactado" | "interesado" | "cotizado" | "cliente" | "descartado";
export type Priority = "alta" | "media" | "baja";
export type CampaignType = "email" | "WhatsApp" | "mixta";
export type CampaignStatus = "borrador" | "programada" | "enviada" | "pausada" | "finalizada";
export type WhatsAppStatus = "sin_consentimiento" | "opt_in" | "bloqueado" | "invalido";

export interface Company {
  id: string;
  name: string;
  legalName: string;
  description: string;
  rut: string;
  businessLine: string;
  type: CompanyType;
  city: string;
  region: string;
  address: string;
  website: string;
  instagram: string;
  facebook: string;
  whatsapp: string;
  whatsappNumber?: string;
  whatsappOptIn?: boolean;
  lastWhatsAppMessageAt?: string;
  whatsappStatus?: WhatsAppStatus;
  phone: string;
  email: string;
  contactName: string;
  contactRole: string;
  priority: Priority;
  source: string;
  notes: string;
  status: CompanyStatus;
  nextFollowUp: string;
  tags: string[];
}

export interface Interaction {
  id: string;
  companyId: string;
  date: string;
  type: "Llamada" | "Correo" | "WhatsApp" | "Reunion" | "Cotizacion" | "Nota";
  owner: string;
  description: string;
  result: string;
  nextAction: string;
}

export interface Campaign {
  id: string;
  name: string;
  type: CampaignType;
  segment: string;
  status: CampaignStatus;
  createdAt: string;
  sendAt: string;
  recipients: number;
  sent: number;
  replied: number;
  interested: number;
  discarded: number;
}

export interface MessageTemplate {
  id: string;
  name: string;
  category: string;
  body: string;
  active?: boolean;
}

export interface Task {
  id: string;
  companyId: string;
  title: string;
  dueDate: string;
  done: boolean;
}

export interface Activity {
  id: string;
  date: string;
  text: string;
}
