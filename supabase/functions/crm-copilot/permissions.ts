import type { CopilotRole, Domain } from "./contracts.ts";

const access: Record<CopilotRole, readonly Domain[]> = {
  administrador: [
    "products",
    "customers",
    "sales",
    "finance",
    "foreign_trade",
    "content",
    "campaigns",
    "agents",
  ],
  finanzas: ["products", "customers", "sales", "finance"],
  vendedor: ["products", "customers", "content", "campaigns"],
  visualizador: ["products", "customers", "content", "campaigns"],
};
export function canReadDomain(role: CopilotRole, domain: Domain): boolean {
  return access[role]?.includes(domain) === true;
}
export function permittedDomains(role: CopilotRole): readonly Domain[] {
  return access[role] || [];
}
