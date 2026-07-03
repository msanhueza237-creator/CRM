import { createContext, useContext, useMemo, useState } from "react";
import { demoCompanies, demoInteractions } from "../../data/demoData";
import type { Company, Interaction } from "../../types/crm";

const COMPANIES_STORAGE_KEY = "climactiva_companies";
const INTERACTIONS_STORAGE_KEY = "climactiva_interactions";

interface CompanyStoreValue {
  companies: Company[];
  interactions: Interaction[];
  createCompany: (company: Omit<Company, "id">) => Company;
  createInteraction: (interaction: Omit<Interaction, "id">) => Interaction;
  updateCompany: (id: string, company: Omit<Company, "id">) => Company;
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
  const [companies, setCompanies] = useState<Company[]>(loadCompanies);
  const [interactions, setInteractions] = useState<Interaction[]>(loadInteractions);

  const value = useMemo<CompanyStoreValue>(
    () => ({
      companies,
      interactions,
      createCompany: (company) => {
        const created = { ...company, id: `cmp-${crypto.randomUUID()}` };
        const nextCompanies = [created, ...companies];
        setCompanies(nextCompanies);
        saveCompanies(nextCompanies);
        return created;
      },
      createInteraction: (interaction) => {
        const created = { ...interaction, id: `int-${crypto.randomUUID()}` };
        const nextInteractions = [created, ...interactions];
        setInteractions(nextInteractions);
        saveInteractions(nextInteractions);
        return created;
      },
      updateCompany: (id, company) => {
        const updated = { ...company, id };
        const nextCompanies = companies.map((item) => (item.id === id ? updated : item));
        setCompanies(nextCompanies);
        saveCompanies(nextCompanies);
        return updated;
      },
      getCompany: (id) => companies.find((company) => company.id === id),
      getCompanyInteractions: (companyId) =>
        interactions
          .filter((interaction) => interaction.companyId === companyId)
          .sort((a, b) => b.date.localeCompare(a.date)),
    }),
    [companies, interactions],
  );

  return <CompanyStoreContext.Provider value={value}>{children}</CompanyStoreContext.Provider>;
}

export function useCompanyStore() {
  const context = useContext(CompanyStoreContext);
  if (!context) throw new Error("useCompanyStore debe usarse dentro de CompanyStoreProvider.");
  return context;
}
