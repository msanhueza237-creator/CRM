import Decimal from "decimal.js";
import type { ForeignTradeCostLine, ForeignTradeOperationLine } from "../../types/foreignTrade";

export type ForeignTradePricingMethod = "markup_on_cost" | "margin_on_sale";
export type ForeignTradeAllocationMethod = "fob_value" | "cif_value" | "units" | "weight" | "cbm" | "combined";

export interface ForeignTradeCostingSettings {
  exchangeRateClp: number;
  cifOverrideOriginal: number | null;
  generalDutyPercent: number;
  importVatPercent: number;
  salesVatPercent: number;
  importVatRecoverable: boolean;
  pricingMethod: ForeignTradePricingMethod;
  targetPercent: number;
  allocationMethod: ForeignTradeAllocationMethod;
  lineDutyPercent: Record<string, number>;
  lineTargetPercent: Record<string, number>;
}

export interface ForeignTradeCostingLineResult {
  lineId: string;
  productName: string;
  sku: string | null;
  quantity: number;
  invoiceTotalClp: number;
  invoiceUnitClp: number;
  cifClp: number;
  dutyPercent: number;
  dutyClp: number;
  importVatClp: number;
  allocatedExpensesClp: number;
  landedTotalClp: number;
  landedUnitClp: number;
  targetPercent: number;
  netSaleUnitClp: number;
  salesVatUnitClp: number;
  finalSaleUnitClp: number;
  profitUnitClp: number;
  markupPercent: number;
  marginPercent: number;
}

export interface ForeignTradeCostingResult {
  cifClp: number;
  dutyClp: number;
  importVatClp: number;
  operatingExpensesNetClp: number;
  operatingExpensesEconomicClp: number;
  operatingExpensesVatClp: number;
  recoverableExpenseVatClp: number;
  recoverableVatClp: number;
  landedTotalClp: number;
  customsFundingClp: number;
  totalCashRequirementClp: number;
  projectedNetSalesClp: number;
  projectedFinalSalesClp: number;
  projectedProfitClp: number;
  projectedMarginPercent: number;
  documentedDutyClp: number;
  documentedImportVatClp: number;
  cifAllocationEstimated: boolean;
  missingInputs: string[];
  lines: ForeignTradeCostingLineResult[];
}

export type ForeignTradeQuoteIncoterm = "EXW" | "FOB" | "CIF";

export interface ForeignTradeQuoteInput {
  unitPriceUsd: number;
  quantity: number;
  exchangeRateClp: number;
  incoterm: ForeignTradeQuoteIncoterm;
  originPercent: number;
  internationalFreightPercent: number;
  insurancePercent: number;
  chilePortPercent: number;
  storagePercent: number;
  customsAgencyPercent: number;
  nationalTransportPercent: number;
  inspectionPercent: number;
  certificatePercent: number;
  otherExpensesPercent: number;
  fixedExpensesClp: number;
  dutyPercent: number;
  importVatPercent: number;
  importVatRecoverable: boolean;
  salesVatPercent: number;
  pricingMethod: ForeignTradePricingMethod;
  targetPercent: number;
}

export interface ForeignTradeQuoteResult {
  quotedTotalClp: number;
  factoryTotalClp: number;
  originTotalClp: number;
  fobTotalClp: number;
  internationalFreightTotalClp: number;
  insuranceTotalClp: number;
  cifTotalClp: number;
  dutyTotalClp: number;
  importVatTotalClp: number;
  operatingExpensesTotalClp: number;
  landedTotalClp: number;
  cashRequirementTotalClp: number;
  projectedNetSalesClp: number;
  projectedFinalSalesClp: number;
  projectedProfitClp: number;
  quotedUnitClp: number;
  fobUnitClp: number;
  cifUnitClp: number;
  dutyUnitClp: number;
  importVatUnitClp: number;
  operatingExpensesUnitClp: number;
  landedUnitClp: number;
  cashRequirementUnitClp: number;
  netSaleUnitClp: number;
  salesVatUnitClp: number;
  finalSaleUnitClp: number;
  profitUnitClp: number;
  markupPercent: number;
  marginPercent: number;
  localExpenses: Array<{ key: string; label: string; percent: number; totalClp: number; unitClp: number }>;
  warnings: string[];
}

type CostMetadata = {
  amount_basis?: "net" | "gross";
  vat_rate_percent?: number | string;
  vat_amount_clp?: number | string;
  gross_amount_clp?: number | string;
  excluded_from_costing?: boolean;
};

type CostBreakdown = {
  net: Decimal;
  vat: Decimal;
  gross: Decimal;
  economic: Decimal;
  recoverableVat: Decimal;
};

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);
const CIF_COMPONENT_CATEGORIES = new Set(["international_freight", "insurance"]);
const NON_EXPENSE_CATEGORIES = new Set(["merchandise", "duties", "taxes", ...CIF_COMPONENT_CATEGORIES]);

export function calculateForeignTradeCosting(
  lines: ForeignTradeOperationLine[],
  costs: ForeignTradeCostLine[],
  settings: ForeignTradeCostingSettings,
): ForeignTradeCostingResult {
  const exchangeRate = positive(settings.exchangeRateClp);
  const missingInputs: string[] = [];
  const activeCosts = costs.filter((cost) => !Boolean(cost.metadata?.excluded_from_costing));

  if (!exchangeRate.gt(0)) missingInputs.push("Falta un tipo de cambio válido.");
  if (!lines.length) missingInputs.push("Faltan productos para distribuir el costo.");

  const merchandiseBases = lines.map((line) => lineBaseClp(line, exchangeRate));
  if (lines.some((line, index) => merchandiseBases[index].lte(0) || positive(line.quantity).lte(0))) {
    missingInputs.push("Hay productos sin cantidad o valor FOB/fábrica suficiente.");
  }

  const merchandiseTotal = sumDecimals(merchandiseBases);
  const allLinesHaveCif = lines.length > 0 && lines.every((line) => positive(line.cif_total).gt(0));
  const lineCifValues = lines.map((line) => convertToClp(line.cif_total, line.currency, exchangeRate));
  const allLineCifsRespectInvoice = allLinesHaveCif
    && lineCifValues.every((cif, index) => cif.gte(merchandiseBases[index] || ZERO));
  const cifComponents = activeCosts
    .filter((cost) => CIF_COMPONENT_CATEGORIES.has(cost.category))
    .reduce((sum, cost) => sum.plus(positive(cost.amount_clp)), ZERO);
  const configuredCif = positive(settings.cifOverrideOriginal).times(exchangeRate);
  const requestedCustomsCif = configuredCif.gt(0)
    ? configuredCif
    : allLinesHaveCif
      ? sumDecimals(lineCifValues)
      : merchandiseTotal.plus(cifComponents);
  const customsCif = Decimal.max(requestedCustomsCif, merchandiseTotal);

  if (!customsCif.gt(0)) missingInputs.push("Falta el CIF o los componentes necesarios para calcularlo.");
  if (requestedCustomsCif.lt(merchandiseTotal)) {
    missingInputs.push("El CIF informado era menor que el valor de factura; se conservó el costo real de la mercadería.");
  }
  if (allLinesHaveCif && !allLineCifsRespectInvoice) {
    missingInputs.push("Hay CIF individuales menores que su valor de factura; se protegió el costo invoice y se redistribuyó solo el incremento CIF.");
  }

  const documentedDuty = sumCostCategory(activeCosts, "duties");
  const documentedImportVat = sumCostCategory(activeCosts, "taxes");
  const operatingCosts = activeCosts.filter((cost) => !NON_EXPENSE_CATEGORIES.has(cost.category));
  const operatingBreakdowns = operatingCosts.map(costBreakdown);
  const operatingNet = sumDecimals(operatingBreakdowns.map((item) => item.net));
  const operatingEconomic = sumDecimals(operatingBreakdowns.map((item) => item.economic));
  const operatingVat = sumDecimals(operatingBreakdowns.map((item) => item.vat));
  const operatingGross = sumDecimals(operatingBreakdowns.map((item) => item.gross));
  const recoverableExpenseVat = sumDecimals(operatingBreakdowns.map((item) => item.recoverableVat));

  const cifAllocationBases = allLinesHaveCif ? lineCifValues : merchandiseBases;
  const baseShares = allocationShares(lines, merchandiseBases, cifAllocationBases, settings.allocationMethod);
  const additionalCif = Decimal.max(customsCif.minus(merchandiseTotal), ZERO);
  const cifByLine = configuredCif.lte(0) && allLineCifsRespectInvoice
    ? lineCifValues
    : merchandiseBases.map((invoiceBase, index) => (
      invoiceBase.plus(additionalCif.times(baseShares[index] || ZERO))
    ));

  const lineResults = lines.map((line, lineIndex) => {
    const invoiceTotal = merchandiseBases[lineIndex] || ZERO;
    const cif = cifByLine[lineIndex] || ZERO;
    const dutyPercent = boundedPercent(settings.lineDutyPercent[line.id] ?? settings.generalDutyPercent);
    const duty = cif.times(dutyPercent).div(HUNDRED);
    const importVat = cif.plus(duty).times(boundedPercent(settings.importVatPercent)).div(HUNDRED);
    const allocatedExpenses = operatingCosts.reduce((sum, cost, costIndex) => {
      const breakdown = operatingBreakdowns[costIndex];
      if (cost.operation_line_id) return cost.operation_line_id === line.id ? sum.plus(breakdown.economic) : sum;
      const method = normalizeAllocationMethod(cost.allocation_method, settings.allocationMethod);
      return sum.plus(breakdown.economic.times(allocationShares(lines, merchandiseBases, cifAllocationBases, method)[lineIndex] || ZERO));
    }, ZERO);
    const landed = cif
      .plus(duty)
      .plus(allocatedExpenses)
      .plus(settings.importVatRecoverable ? ZERO : importVat);
    const quantity = positive(line.quantity);
    const invoiceUnit = quantity.gt(0) ? invoiceTotal.div(quantity) : ZERO;
    const landedUnit = quantity.gt(0) ? landed.div(quantity) : ZERO;
    const targetPercent = boundedTargetPercent(settings.lineTargetPercent[line.id] ?? settings.targetPercent, settings.pricingMethod);
    const netSaleUnit = salePrice(landedUnit, targetPercent, settings.pricingMethod);
    const salesVatUnit = netSaleUnit.times(boundedPercent(settings.salesVatPercent)).div(HUNDRED);
    const profitUnit = netSaleUnit.minus(landedUnit);
    const markup = landedUnit.gt(0) ? profitUnit.div(landedUnit).times(HUNDRED) : ZERO;
    const margin = netSaleUnit.gt(0) ? profitUnit.div(netSaleUnit).times(HUNDRED) : ZERO;

    return {
      lineId: line.id,
      productName: line.product_name,
      sku: line.sku,
      quantity: toNumber(quantity),
      invoiceTotalClp: toMoney(invoiceTotal),
      invoiceUnitClp: toMoney(invoiceUnit),
      cifClp: toMoney(cif),
      dutyPercent: toPercent(dutyPercent),
      dutyClp: toMoney(duty),
      importVatClp: toMoney(importVat),
      allocatedExpensesClp: toMoney(allocatedExpenses),
      landedTotalClp: toMoney(landed),
      landedUnitClp: toMoney(landedUnit),
      targetPercent: toPercent(targetPercent),
      netSaleUnitClp: toMoney(netSaleUnit),
      salesVatUnitClp: toMoney(salesVatUnit),
      finalSaleUnitClp: toMoney(netSaleUnit.plus(salesVatUnit)),
      profitUnitClp: toMoney(profitUnit),
      markupPercent: toPercent(markup),
      marginPercent: toPercent(margin),
    };
  });

  const duty = sumDecimals(lineResults.map((line) => positive(line.dutyClp)));
  const importVat = sumDecimals(lineResults.map((line) => positive(line.importVatClp)));
  const landed = sumDecimals(lineResults.map((line) => positive(line.landedTotalClp)));
  const projectedNetSales = sumDecimals(lineResults.map((line) => positive(line.netSaleUnitClp).times(line.quantity)));
  const projectedFinalSales = sumDecimals(lineResults.map((line) => positive(line.finalSaleUnitClp).times(line.quantity)));
  const projectedProfit = projectedNetSales.minus(landed);
  const projectedMargin = projectedNetSales.gt(0) ? projectedProfit.div(projectedNetSales).times(HUNDRED) : ZERO;
  const recoverableImportVat = settings.importVatRecoverable ? importVat : ZERO;

  return {
    cifClp: toMoney(customsCif),
    dutyClp: toMoney(duty),
    importVatClp: toMoney(importVat),
    operatingExpensesNetClp: toMoney(operatingNet),
    operatingExpensesEconomicClp: toMoney(operatingEconomic),
    operatingExpensesVatClp: toMoney(operatingVat),
    recoverableExpenseVatClp: toMoney(recoverableExpenseVat),
    recoverableVatClp: toMoney(recoverableImportVat.plus(recoverableExpenseVat)),
    landedTotalClp: toMoney(landed),
    customsFundingClp: toMoney(duty.plus(importVat).plus(operatingGross)),
    totalCashRequirementClp: toMoney(customsCif.plus(duty).plus(importVat).plus(operatingGross)),
    projectedNetSalesClp: toMoney(projectedNetSales),
    projectedFinalSalesClp: toMoney(projectedFinalSales),
    projectedProfitClp: toMoney(projectedProfit),
    projectedMarginPercent: toPercent(projectedMargin),
    documentedDutyClp: toMoney(documentedDuty),
    documentedImportVatClp: toMoney(documentedImportVat),
    cifAllocationEstimated: settings.allocationMethod === "cif_value" && (!allLinesHaveCif || !allLineCifsRespectInvoice),
    missingInputs,
    lines: lineResults,
  };
}

export function calculateForeignTradeQuote(input: ForeignTradeQuoteInput): ForeignTradeQuoteResult {
  const quantity = positive(input.quantity);
  const exchangeRate = positive(input.exchangeRateClp);
  const quotedTotal = positive(input.unitPriceUsd).times(quantity).times(exchangeRate);
  const warnings: string[] = [];

  if (!quantity.gt(0)) warnings.push("Ingresa una cantidad mayor que cero.");
  if (!exchangeRate.gt(0)) warnings.push("Ingresa un tipo de cambio USD/CLP válido.");
  if (!positive(input.unitPriceUsd).gt(0)) warnings.push("Ingresa el precio unitario cotizado en USD.");

  const origin = input.incoterm === "EXW"
    ? quotedTotal.times(boundedPercent(input.originPercent)).div(HUNDRED)
    : ZERO;
  const fob = input.incoterm === "EXW" ? quotedTotal.plus(origin) : quotedTotal;
  const internationalFreight = input.incoterm === "CIF"
    ? ZERO
    : fob.times(boundedPercent(input.internationalFreightPercent)).div(HUNDRED);
  const insurance = input.incoterm === "CIF"
    ? ZERO
    : fob.times(boundedPercent(input.insurancePercent)).div(HUNDRED);
  const cif = input.incoterm === "CIF" ? quotedTotal : fob.plus(internationalFreight).plus(insurance);
  const duty = cif.times(boundedPercent(input.dutyPercent)).div(HUNDRED);
  const importVat = cif.plus(duty).times(boundedPercent(input.importVatPercent)).div(HUNDRED);

  const localDefinitions = [
    ["chile_port", "Puerto y desconsolidación", input.chilePortPercent],
    ["storage", "Almacenaje", input.storagePercent],
    ["customs_agency", "Agencia de aduana", input.customsAgencyPercent],
    ["national_transport", "Transporte a bodega", input.nationalTransportPercent],
    ["inspection", "Inspecciones", input.inspectionPercent],
    ["certificate", "Certificados", input.certificatePercent],
    ["other", "Otros gastos", input.otherExpensesPercent],
  ] as const;
  const localExpenses = localDefinitions.map(([key, label, rawPercent]) => {
    const percent = boundedPercent(rawPercent);
    const total = cif.times(percent).div(HUNDRED);
    return {
      key,
      label,
      percent: toPercent(percent),
      totalClp: toMoney(total),
      unitClp: toMoney(perUnit(total, quantity)),
    };
  });
  const percentageExpenses = sumDecimals(localExpenses.map((expense) => positive(expense.totalClp)));
  const fixedExpenses = positive(input.fixedExpensesClp);
  const operatingExpenses = percentageExpenses.plus(fixedExpenses);
  const landed = cif
    .plus(duty)
    .plus(operatingExpenses)
    .plus(input.importVatRecoverable ? ZERO : importVat);
  const cashRequirement = cif.plus(duty).plus(importVat).plus(operatingExpenses);
  const targetPercent = boundedTargetPercent(input.targetPercent, input.pricingMethod);
  const landedUnit = perUnit(landed, quantity);
  const netSaleUnit = salePrice(landedUnit, targetPercent, input.pricingMethod);
  const salesVatUnit = netSaleUnit.times(boundedPercent(input.salesVatPercent)).div(HUNDRED);
  const finalSaleUnit = netSaleUnit.plus(salesVatUnit);
  const profitUnit = netSaleUnit.minus(landedUnit);
  const markup = landedUnit.gt(0) ? profitUnit.div(landedUnit).times(HUNDRED) : ZERO;
  const margin = netSaleUnit.gt(0) ? profitUnit.div(netSaleUnit).times(HUNDRED) : ZERO;

  return {
    quotedTotalClp: toMoney(quotedTotal),
    factoryTotalClp: toMoney(quotedTotal),
    originTotalClp: toMoney(origin),
    fobTotalClp: toMoney(fob),
    internationalFreightTotalClp: toMoney(internationalFreight),
    insuranceTotalClp: toMoney(insurance),
    cifTotalClp: toMoney(cif),
    dutyTotalClp: toMoney(duty),
    importVatTotalClp: toMoney(importVat),
    operatingExpensesTotalClp: toMoney(operatingExpenses),
    landedTotalClp: toMoney(landed),
    cashRequirementTotalClp: toMoney(cashRequirement),
    projectedNetSalesClp: toMoney(netSaleUnit.times(quantity)),
    projectedFinalSalesClp: toMoney(finalSaleUnit.times(quantity)),
    projectedProfitClp: toMoney(profitUnit.times(quantity)),
    quotedUnitClp: toMoney(perUnit(quotedTotal, quantity)),
    fobUnitClp: toMoney(perUnit(fob, quantity)),
    cifUnitClp: toMoney(perUnit(cif, quantity)),
    dutyUnitClp: toMoney(perUnit(duty, quantity)),
    importVatUnitClp: toMoney(perUnit(importVat, quantity)),
    operatingExpensesUnitClp: toMoney(perUnit(operatingExpenses, quantity)),
    landedUnitClp: toMoney(landedUnit),
    cashRequirementUnitClp: toMoney(perUnit(cashRequirement, quantity)),
    netSaleUnitClp: toMoney(netSaleUnit),
    salesVatUnitClp: toMoney(salesVatUnit),
    finalSaleUnitClp: toMoney(finalSaleUnit),
    profitUnitClp: toMoney(profitUnit),
    markupPercent: toPercent(markup),
    marginPercent: toPercent(margin),
    localExpenses,
    warnings,
  };
}

function lineBaseClp(line: ForeignTradeOperationLine, exchangeRate: Decimal) {
  const total = Decimal.max(
    positive(line.fob_total),
    positive(line.exw_total),
    positive(line.unit_factory_cost).times(positive(line.quantity)),
  );
  return convertToClp(total, line.currency, exchangeRate);
}

function convertToClp(value: Decimal.Value | null | undefined, currency: string, exchangeRate: Decimal) {
  const amount = positive(value);
  return currency.toUpperCase() === "CLP" ? amount : amount.times(exchangeRate);
}

function costBreakdown(cost: ForeignTradeCostLine): CostBreakdown {
  const metadata = (cost.metadata || {}) as CostMetadata;
  const amount = positive(cost.amount_clp);
  const vatRate = boundedPercent(metadata.vat_rate_percent ?? 0).div(HUNDRED);
  const grossBasis = metadata.amount_basis === "gross";
  const explicitVat = positive(metadata.vat_amount_clp);
  const explicitGross = positive(metadata.gross_amount_clp);
  const net = grossBasis && vatRate.gt(0) ? amount.div(vatRate.plus(1)) : amount;
  const vat = explicitVat.gt(0) ? explicitVat : grossBasis ? amount.minus(net) : net.times(vatRate);
  const gross = explicitGross.gt(0) ? explicitGross : net.plus(vat);
  const recoverableVat = cost.recoverable_tax ? vat : ZERO;
  return {
    net,
    vat,
    gross,
    recoverableVat,
    economic: net.plus(cost.recoverable_tax ? ZERO : vat),
  };
}

function allocationShares(
  lines: ForeignTradeOperationLine[],
  merchandiseBases: Decimal[],
  cifBases: Decimal[],
  method: ForeignTradeAllocationMethod,
) {
  const vectors: Record<Exclude<ForeignTradeAllocationMethod, "combined">, Decimal[]> = {
    fob_value: merchandiseBases,
    cif_value: cifBases,
    units: lines.map((line) => positive(line.quantity)),
    weight: lines.map((line) => positive(line.gross_weight_kg)),
    cbm: lines.map((line) => positive(line.cbm_total)),
  };
  if (method !== "combined") return normalizedShares(vectors[method]);

  const available = Object.values(vectors).map(normalizedShares).filter((shares) => shares.some((share) => share.gt(0)));
  if (!available.length) return equalShares(lines.length);
  return lines.map((_, index) => sumDecimals(available.map((shares) => shares[index] || ZERO)).div(available.length));
}

function normalizedShares(values: Decimal[]) {
  const total = sumDecimals(values);
  if (!total.gt(0)) return equalShares(values.length);
  return values.map((value) => value.div(total));
}

function equalShares(length: number) {
  return length > 0 ? Array.from({ length }, () => new Decimal(1).div(length)) : [];
}

function normalizeAllocationMethod(
  method: ForeignTradeCostLine["allocation_method"],
  fallback: ForeignTradeAllocationMethod,
): ForeignTradeAllocationMethod {
  if (["fob_value", "cif_value", "units", "weight", "cbm", "combined"].includes(method)) {
    return method as ForeignTradeAllocationMethod;
  }
  return fallback;
}

function salePrice(cost: Decimal, targetPercent: Decimal, method: ForeignTradePricingMethod) {
  if (!cost.gt(0)) return ZERO;
  if (method === "margin_on_sale") {
    const divisor = new Decimal(1).minus(targetPercent.div(HUNDRED));
    return divisor.gt(0) ? cost.div(divisor) : ZERO;
  }
  return cost.times(new Decimal(1).plus(targetPercent.div(HUNDRED)));
}

function perUnit(total: Decimal, quantity: Decimal) {
  return quantity.gt(0) ? total.div(quantity) : ZERO;
}

function sumCostCategory(costs: ForeignTradeCostLine[], category: ForeignTradeCostLine["category"]) {
  return costs.filter((cost) => cost.category === category).reduce((sum, cost) => sum.plus(positive(cost.amount_clp)), ZERO);
}

function sumDecimals(values: Decimal[]) {
  return values.reduce((sum, value) => sum.plus(value), ZERO);
}

function positive(value: Decimal.Value | null | undefined) {
  const parsed = new Decimal(value === null || value === undefined || value === "" ? 0 : value);
  return parsed.isFinite() && parsed.gt(0) ? parsed : ZERO;
}

function boundedPercent(value: Decimal.Value | null | undefined) {
  return Decimal.min(HUNDRED, Decimal.max(ZERO, positive(value)));
}

function boundedTargetPercent(value: Decimal.Value | null | undefined, method: ForeignTradePricingMethod) {
  const maximum = method === "margin_on_sale" ? new Decimal("99.9999") : new Decimal(100000);
  return Decimal.min(maximum, Decimal.max(ZERO, positive(value)));
}

function toMoney(value: Decimal) {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

function toPercent(value: Decimal) {
  return value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber();
}

function toNumber(value: Decimal) {
  return value.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber();
}
