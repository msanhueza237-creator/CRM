import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { demoTemplates } from "../../data/demoData";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthContext";
import type { MessageTemplate } from "../../types/crm";

const STORAGE_KEY = "climactiva_message_templates";

interface TemplateStoreValue {
  templates: MessageTemplate[];
  activeTemplates: MessageTemplate[];
  createTemplate: (template: Omit<MessageTemplate, "id">) => MessageTemplate;
  duplicateTemplate: (templateId: string) => MessageTemplate | undefined;
  updateTemplate: (id: string, template: Omit<MessageTemplate, "id">) => MessageTemplate;
  toggleTemplate: (id: string) => void;
}

const TemplateStoreContext = createContext<TemplateStoreValue | undefined>(undefined);

function normalizeTemplates(templates: MessageTemplate[]) {
  return templates.map((template) => ({ ...template, active: template.active ?? true }));
}

function loadTemplates() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return normalizeTemplates(demoTemplates);

  try {
    return normalizeTemplates(JSON.parse(stored) as MessageTemplate[]);
  } catch {
    return normalizeTemplates(demoTemplates);
  }
}

function saveTemplates(templates: MessageTemplate[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

export function TemplateStoreProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [templates, setTemplates] = useState<MessageTemplate[]>(loadTemplates);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !user) return;

    async function loadSupabaseTemplates() {
      const { data, error } = await supabase!
        .from("message_templates")
        .select("*")
        .order("created_at", { ascending: false });

      if (!error && data) {
        const mappedTemplates = normalizeTemplates(
          data.map((row) => ({
            id: String(row.id),
            name: String(row.name ?? ""),
            category: String(row.category ?? ""),
            body: String(row.body ?? ""),
            active: Boolean(row.active),
          })),
        );
        setTemplates(mappedTemplates);
        saveTemplates(mappedTemplates);
      }
    }

    void loadSupabaseTemplates();
  }, [user]);

  const value = useMemo<TemplateStoreValue>(
    () => ({
      templates,
      activeTemplates: templates.filter((template) => template.active !== false),
      createTemplate: (template) => {
        const created = { ...template, id: crypto.randomUUID(), active: template.active ?? true };
        const nextTemplates = [created, ...templates];
        setTemplates(nextTemplates);
        saveTemplates(nextTemplates);
        if (isSupabaseConfigured && supabase && user) {
          void supabase.from("message_templates").insert(mapTemplateToSupabase(created));
        }
        return created;
      },
      duplicateTemplate: (templateId) => {
        const original = templates.find((template) => template.id === templateId);
        if (!original) return undefined;
        const duplicated = {
          ...original,
          id: crypto.randomUUID(),
          name: `${original.name} copia`,
          active: true,
        };
        const nextTemplates = [duplicated, ...templates];
        setTemplates(nextTemplates);
        saveTemplates(nextTemplates);
        if (isSupabaseConfigured && supabase && user) {
          void supabase.from("message_templates").insert(mapTemplateToSupabase(duplicated));
        }
        return duplicated;
      },
      updateTemplate: (id, template) => {
        const updated = { ...template, id, active: template.active ?? true };
        const nextTemplates = templates.map((item) => (item.id === id ? updated : item));
        setTemplates(nextTemplates);
        saveTemplates(nextTemplates);
        if (isSupabaseConfigured && supabase && user) {
          void supabase.from("message_templates").update(mapTemplateToSupabase(updated)).eq("id", id);
        }
        return updated;
      },
      toggleTemplate: (id) => {
        const nextTemplates = templates.map((template) =>
          template.id === id ? { ...template, active: template.active === false } : template,
        );
        setTemplates(nextTemplates);
        saveTemplates(nextTemplates);
        const updatedTemplate = nextTemplates.find((template) => template.id === id);
        if (updatedTemplate && isSupabaseConfigured && supabase && user) {
          void supabase.from("message_templates").update({ active: updatedTemplate.active !== false }).eq("id", id);
        }
      },
    }),
    [templates],
  );

  return <TemplateStoreContext.Provider value={value}>{children}</TemplateStoreContext.Provider>;
}

function mapTemplateToSupabase(template: MessageTemplate) {
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    body: template.body,
    active: template.active !== false,
  };
}

export function useTemplateStore() {
  const context = useContext(TemplateStoreContext);
  if (!context) throw new Error("useTemplateStore debe usarse dentro de TemplateStoreProvider.");
  return context;
}
