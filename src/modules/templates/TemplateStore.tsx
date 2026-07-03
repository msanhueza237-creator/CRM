import { createContext, useContext, useMemo, useState } from "react";
import { demoTemplates } from "../../data/demoData";
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
  const [templates, setTemplates] = useState<MessageTemplate[]>(loadTemplates);

  const value = useMemo<TemplateStoreValue>(
    () => ({
      templates,
      activeTemplates: templates.filter((template) => template.active !== false),
      createTemplate: (template) => {
        const created = { ...template, id: `tpl-${crypto.randomUUID()}`, active: template.active ?? true };
        const nextTemplates = [created, ...templates];
        setTemplates(nextTemplates);
        saveTemplates(nextTemplates);
        return created;
      },
      duplicateTemplate: (templateId) => {
        const original = templates.find((template) => template.id === templateId);
        if (!original) return undefined;
        const duplicated = {
          ...original,
          id: `tpl-${crypto.randomUUID()}`,
          name: `${original.name} copia`,
          active: true,
        };
        const nextTemplates = [duplicated, ...templates];
        setTemplates(nextTemplates);
        saveTemplates(nextTemplates);
        return duplicated;
      },
      updateTemplate: (id, template) => {
        const updated = { ...template, id, active: template.active ?? true };
        const nextTemplates = templates.map((item) => (item.id === id ? updated : item));
        setTemplates(nextTemplates);
        saveTemplates(nextTemplates);
        return updated;
      },
      toggleTemplate: (id) => {
        const nextTemplates = templates.map((template) =>
          template.id === id ? { ...template, active: template.active === false } : template,
        );
        setTemplates(nextTemplates);
        saveTemplates(nextTemplates);
      },
    }),
    [templates],
  );

  return <TemplateStoreContext.Provider value={value}>{children}</TemplateStoreContext.Provider>;
}

export function useTemplateStore() {
  const context = useContext(TemplateStoreContext);
  if (!context) throw new Error("useTemplateStore debe usarse dentro de TemplateStoreProvider.");
  return context;
}
