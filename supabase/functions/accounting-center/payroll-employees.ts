export type PayrollEmployeeKey = "sisla" | "marco";

export interface PayrollEmployee {
  key: PayrollEmployeeKey;
  name: string;
  taxId: string;
}

function normalize(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9k]+/g, " ")
    .trim();
}

export function identifyPayrollEmployee(value: unknown): PayrollEmployee | null {
  const normalized = normalize(value);
  const compact = normalized.replace(/\s+/g, "");
  if (compact.includes("141864734") || (normalized.includes("sisla") && normalized.includes("munoz"))) {
    return { key: "sisla", name: "Sisla Muñoz", taxId: "14.186.473-4" };
  }
  if (compact.includes("154277137") || (normalized.includes("marco") && (normalized.includes("sanhueza") || normalized.includes("emilio")))) {
    return { key: "marco", name: "Marco Sanhueza", taxId: "15.427.713-7" };
  }
  return null;
}

export function protectedPayrollClassification(metadata: Record<string, unknown>) {
  if (metadata.classification_locked !== true) return null;
  const classification = String(metadata.verified_classification || "locked");
  return {
    classification,
    message: classification === "loan_repayment_sisla"
      ? "Este movimiento está protegido como devolución de préstamo de Sisla y no puede reclasificarse como sueldo."
      : `El movimiento ya tiene una clasificación protegida (${classification}).`,
  };
}
