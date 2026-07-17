import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { demoCompanies, demoInteractions } from "../../data/demoData";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthContext";
import type { Company, Interaction } from "../../types/crm";

const COMPANIES_STORAGE_KEY = "climactiva_companies";
const INTERACTIONS_STORAGE_KEY = "climactiva_interactions";

interface CompanyStoreValue {
  companies: Company[];
  interactions: Interaction[];
  createCompany: (company: Omit<Company, "id">, options?: { localOnly?: boolean }) => Company;
  createInteraction: (interaction: Omit<Interaction, "id">) => Interaction;
  updateCompany: (id: string, company: Omit<Company, "id">) => Promise<Company>;
  deleteCompany: (id: string) => Promise<void>;
  getCompany: (id: string) => Company | undefined;
  getCompanyInteractions: (companyId: string) => Interaction[];
}

const CompanyStoreContext = createContext<CompanyStoreValue | undefined>(undefined);

function loadCompanies() {
  const stored = localStorage.getItem(COMPANIES_STORAGE_KEY);
  if (!stored) return demoCompanies;

  try {
    return JSON.parse(stored) as Company[];
  } catch {
    return demoCompanies;
  }
}

function saveCompanies(companies: Company[]) {
  localStorage.setItem(COMPANIES_STORAGE_KEY, JSON.stringify(companies));
}

function loadInteractions() {
  const stored = localStorage.getItem(INTERACTIONS_STORAGE_KEY);
  if (!stored) return demoInteractions;

  try {
    return JSON.parse(stored) as Interaction[];
  } catch {
    return demoInteractions;
  }
}

function saveInteractions(interactions: Interaction[]) {
  localStorage.setItem(INTERACTIONS_STORAGE_KEY, JSON.stringify(interactions));
}

export function CompanyStoreProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [companies, setCompanies] = useState<Company[]>(loadCompanies);
  const [interactions, setInteractions] = useState<Interaction[]>(loadInteractions);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !user) return;

    async function loadSupabaseData() {
      const [
        { data: companiesData, error: companiesError },
        { data: interactionsData, error: interactionsError },
        { data: tagsData },
        { data: companyTagsData },
      ] =
        await Promise.all([
          supabase!
            .from("companies")
            .select("*")
            .order("next_follow_up", { ascending: true, nullsFirst: false }),
          supabase!
            .from("interactions")
            .select("*")
            .order("occurred_at", { ascending: false }),
          supabase!.from("tags").select("id,name"),
          supabase!.from("company_tags").select("company_id,tag_id"),
        ]);

      if (!companiesError && companiesData) {
        const tagNames = new Map((tagsData ?? []).map((tag) => [String(tag.id), String(tag.name)]));
        const tagsByCompany = new Map<string, string[]>();
        for (const relation of companyTagsData ?? []) {
          const companyId = String(relation.company_id);
          const tagName = tagNames.get(String(relation.tag_id));
          if (tagName) tagsByCompany.set(companyId, [...(tagsByCompany.get(companyId) ?? []), tagName]);
        }
        const mappedCompanies = companiesData.map((row) => ({
          ...mapCompanyFromSupabase(row),
          tags: tagsByCompany.get(String(row.id)) ?? [],
        }));
        setCompanies(mappedCompanies);
        saveCompanies(mappedCompanies);
      }

      if (!interactionsError && interactionsData) {
        const mappedInteractions = interactionsData.map(mapInteractionFromSupabase);
        setInteractions(mappedInteractions);
        saveInteractions(mappedInteractions);
      }
    }

    void loadSupabaseData();
  }, [user]);

  const value = useMemo<CompanyStoreValue>(
    () => ({
      companies,
      interactions,
      createCompany: (company, options) => {
        const created = { ...company, id: crypto.randomUUID() };
        const nextCompanies = [created, ...companies];
        setCompanies(nextCompanies);
        saveCompanies(nextCompanies);
        if (!options?.localOnly && isSupabaseConfigured && supabase && user) {
          void supabase.from("companies").insert(mapCompanyToSupabase(created));
        }
        return created;
      },
      createInteraction: (interaction) => {
        const created = { ...interaction, id: crypto.randomUUID() };
        const nextInteractions = [created, ...interactions];
        setInteractions(nextInteractions);
        saveInteractions(nextInteractions);
        if (isSupabaseConfigured && supabase && user) {
          void supabase.from("interactions").insert(mapInteractionToSupabase(created));
        }
        return created;
      },
      updateCompany: async (id, company) => {
        const updated = { ...company, id };
        let saved = updated;
        if (isSupabaseConfigured && supabase && user) {
          const { id: _id, ...databasePayload } = mapCompanyToSupabase(updated);
          void _id;
          const { data, error } = await supabase
            .from("companies")
            .update(databasePayload)
            .eq("id", id)
            .select("*")
            .single();
          if (error) throw new Error(`No se pudo guardar la empresa: ${error.message}`);
          saved = mapCompanyFromSupabase(data as Record<string, unknown>);
          saved.tags = updated.tags;
          await saveCompanyTags(id, updated.tags);
        }
        const nextCompanies = companies.map((item) => (item.id === id ? saved : item));
        setCompanies(nextCompanies);
        saveCompanies(nextCompanies);
        return saved;
      },
      deleteCompany: async (id) => {
        if (isSupabaseConfigured && supabase && user) {
          const { error } = await supabase.from("companies").delete().eq("id", id);
          if (error) throw new Error(`No se pudo borrar la empresa: ${error.message}`);
        }
        const nextCompanies = companies.filter((item) => item.id !== id);
        const nextInteractions = interactions.filter((item) => item.companyId !== id);
        setCompanies(nextCompanies);
        setInteractions(nextInteractions);
        saveCompanies(nextCompanies);
        saveInteractions(nextInteractions);
      },
      getCompany: (id) => companies.find((company) => company.id === id),
      getCompanyInteractions: (companyId) =>
        interactions
          .filter((interaction) => interaction.companyId === companyId)
          .sort((a, b) => b.date.localeCompare(a.date)),
    }),
    [companies, interactions, user],
  );

  return <CompanyStoreContext.Provider value={value}>{children}</CompanyStoreContext.Provider>;
}

function mapCompanyFromSupabase(row: Record<string, unknown>): Company {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    legalName: String(row.legal_name ?? ""),
    description: String(row.description ?? ""),
    rut: String(row.rut ?? ""),
    businessLine: String(row.business_line ?? ""),
    type: row.type as Company["type"],
    city: String(row.city ?? ""),
    region: String(row.region ?? ""),
    address: String(row.address ?? ""),
    website: String(row.website ?? ""),
    instagram: String(row.instagram ?? ""),
    facebook: String(row.facebook ?? ""),
    whatsapp: String(row.whatsapp ?? ""),
    whatsappNumber: String(row.whatsapp_number ?? row.whatsapp ?? ""),
    whatsappOptIn: Boolean(row.whatsapp_opt_in),
    lastWhatsAppMessageAt: String(row.last_whatsapp_message_at ?? ""),
    whatsappStatus: (row.whatsapp_status as Company["whatsappStatus"]) ?? "sin_consentimiento",
    phone: String(row.phone ?? ""),
    email: String(row.email ?? ""),
    contactName: String(row.contact_name ?? ""),
    contactRole: String(row.contact_role ?? ""),
    priority: row.priority as Company["priority"],
    source: String(row.source ?? ""),
    notes: String(row.notes ?? ""),
    status: row.status as Company["status"],
    nextFollowUp: String(row.next_follow_up ?? ""),
    tags: [],
  };
}

function mapCompanyToSupabase(company: Company) {
  return {
    id: company.id,
    name: company.name,
    legal_name: company.legalName,
    description: company.description,
    rut: company.rut,
    business_line: company.businessLine,
    type: company.type,
    city: company.city,
    region: company.region,
    address: company.address,
    website: company.website || null,
    instagram: company.instagram || null,
    facebook: company.facebook || null,
    whatsapp: company.whatsapp || null,
    whatsapp_number: company.whatsappNumber || company.whatsapp || null,
    whatsapp_opt_in: Boolean(company.whatsappOptIn),
    whatsapp_status: company.whatsappStatus || (company.whatsappOptIn ? "opt_in" : "sin_consentimiento"),
    phone: company.phone || null,
    email: company.email || null,
    contact_name: company.contactName,
    contact_role: company.contactRole,
    priority: company.priority,
    source: company.source,
    notes: company.notes,
    status: company.status,
    next_follow_up: company.nextFollowUp || null,
  };
}

function mapInteractionFromSupabase(row: Record<string, unknown>): Interaction {
  const typeMap: Record<string, Interaction["type"]> = {
    llamada: "Llamada",
    correo: "Correo",
    whatsapp: "WhatsApp",
    reunion: "Reunion",
    cotizacion: "Cotizacion",
    nota: "Nota",
  };

  return {
    id: String(row.id),
    companyId: String(row.company_id),
    date: String(row.occurred_at ?? "").slice(0, 10),
    type: typeMap[String(row.type)] ?? "Nota",
    owner: "Administrador",
    description: String(row.description ?? ""),
    result: String(row.result ?? ""),
    nextAction: String(row.next_action ?? ""),
  };
}

function mapInteractionToSupabase(interaction: Interaction) {
  const typeMap: Record<Interaction["type"], string> = {
    Llamada: "llamada",
    Correo: "correo",
    WhatsApp: "whatsapp",
    Reunion: "reunion",
    Cotizacion: "cotizacion",
    Nota: "nota",
  };

  return {
    id: interaction.id,
    company_id: interaction.companyId,
    type: typeMap[interaction.type],
    description: interaction.description,
    result: interaction.result,
    next_action: interaction.nextAction,
    occurred_at: `${interaction.date}T12:00:00-04:00`,
  };
}

export function useCompanyStore() {
  const context = useContext(CompanyStoreContext);
  if (!context) throw new Error("useCompanyStore debe usarse dentro de CompanyStoreProvider.");
  return context;
}

async function saveCompanyTags(companyId: string, names: string[]) {
  if (!supabase) return;
  const normalized = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
  const { error: deleteError } = await supabase.from("company_tags").delete().eq("company_id", companyId);
  if (deleteError) throw new Error(`La empresa se guardó, pero no sus etiquetas: ${deleteError.message}`);
  if (!normalized.length) return;
  const { data: tags, error: tagError } = await supabase
    .from("tags")
    .upsert(normalized.map((name) => ({ name })), { onConflict: "name" })
    .select("id,name");
  if (tagError) throw new Error(`La empresa se guardó, pero no sus etiquetas: ${tagError.message}`);
  const { error: relationError } = await supabase.from("company_tags").insert(
    (tags ?? []).map((tag) => ({ company_id: companyId, tag_id: tag.id })),
  );
  if (relationError) throw new Error(`La empresa se guardó, pero no sus etiquetas: ${relationError.message}`);
}
