import { whatsappRequest } from "./whatsappApi";

export const inboxChanged = "crm-whatsapp-inbox-changed";
export type InboxFilter = "all" | "unread" | "new";
export interface InboxConversation {
  companyId: string | null; phone: string; companyName: string; name: string;
  isNew: boolean; unreadCount: number; latestInboundId: string | null;
  preview: string; direction: string; status: string; lastAt: string;
}
export interface WhatsAppInbox {
  summary: { conversations: number; unreadMessages: number; unreadConversations: number; newContacts: number };
  total: number; offset: number; limit: number; conversations: InboxConversation[];
}
export function getWhatsAppInbox(search = "", filter: InboxFilter = "all", offset = 0, limit = 30) {
  return whatsappRequest<WhatsAppInbox>(`whatsapp-inbox?${new URLSearchParams({ search, filter, offset: String(offset), limit: String(limit) })}`);
}
export function notifyInboxChanged() { window.dispatchEvent(new Event(inboxChanged)); }
export async function setWhatsAppRead(companyId: string | null, phone: string, messageIds: string[], read: boolean) {
  await whatsappRequest<{ updated: number }>("whatsapp-read", { companyId, phone, messageIds, read });
  notifyInboxChanged();
}
