import type { ForeignTradeOperationLine } from "../../types/foreignTrade";

export type ForeignTradeProductIdentity = {
  value: string | null;
  label: "SKU CRM" | "Código proveedor" | "Modelo proveedor" | "Código temporal" | "Sin código";
};

export function getForeignTradeProductIdentity(
  line: Pick<ForeignTradeOperationLine, "content_product_id" | "sku" | "supplier_sku" | "supplier_model" | "source_snapshot">,
): ForeignTradeProductIdentity {
  const crmSku = clean(line.sku);
  if (crmSku && line.content_product_id) return { value: crmSku, label: "SKU CRM" };

  const supplierCode = clean(line.supplier_sku)
    || snapshotValue(line.source_snapshot, "recognized_supplier_code")
    || snapshotValue(line.source_snapshot, "supplier_product_code")
    || snapshotValue(line.source_snapshot, "supplier_sku")
    || snapshotValue(line.source_snapshot, "supplier_reference");
  if (supplierCode) return { value: supplierCode, label: "Código proveedor" };

  const supplierModel = clean(line.supplier_model)
    || snapshotValue(line.source_snapshot, "recognized_supplier_model")
    || snapshotValue(line.source_snapshot, "supplier_model")
    || snapshotValue(line.source_snapshot, "model");
  if (supplierModel) return { value: supplierModel, label: "Modelo proveedor" };

  if (crmSku) return { value: crmSku, label: "Código temporal" };

  return { value: null, label: "Sin código" };
}

export function formatForeignTradeProductIdentity(identity: ForeignTradeProductIdentity) {
  return identity.value ? `${identity.label}: ${identity.value}` : identity.label;
}

function snapshotValue(snapshot: Record<string, unknown> | null | undefined, key: string) {
  return clean(snapshot?.[key]);
}

function clean(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
