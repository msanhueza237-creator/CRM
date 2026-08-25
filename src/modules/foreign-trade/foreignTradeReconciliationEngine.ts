import Decimal from "decimal.js";
import { isIncludedInForeignTradeAgencyReconciliation } from "./foreignTradeAgencyPaymentScope.ts";

export type ForeignTradeReconciliationLineType =
  | "operating_expense"
  | "agency_fee"
  | "customs_duty"
  | "import_vat"
  | "adjustment";

export interface ForeignTradeReconciliationAmountLine {
  concept?: string | null;
  provider_name?: string | null;
  metadata?: Record<string, unknown> | null;
  line_type: ForeignTradeReconciliationLineType;
  provision_total_clp: number | string | null;
  provision_amount_original?: number | string | null;
  provision_currency?: string | null;
  provision_exchange_rate_clp?: number | string | null;
  actual_net_clp: number | string | null;
  actual_vat_clp: number | string | null;
  actual_total_clp: number | string | null;
  actual_amount_original?: number | string | null;
  actual_currency?: string | null;
  actual_exchange_rate_clp?: number | string | null;
}

export interface ForeignTradeReconciliationLineCalculation {
  provisionConvertedClp: number | null;
  provisionImpliedExchangeRateClp: number | null;
  actualConvertedClp: number | null;
  actualImpliedExchangeRateClp: number | null;
  actualAppliedTotalClp: number;
  conversionVarianceClp: number | null;
}

export interface ForeignTradeReconciliationResult {
  provisionExpensesClp: number;
  actualExpensesClp: number;
  provisionTaxesClp: number;
  actualTaxesClp: number;
  provisionTotalClp: number;
  actualTotalClp: number;
  balanceClp: number;
  refundDueClp: number;
  additionalPaymentClp: number;
  refundReceivedClp: number;
  lineDifferences: number[];
  lineConversions: ForeignTradeReconciliationLineCalculation[];
}

export function calculateForeignTradeReconciliation(
  remittanceAmountClp: number | string | null,
  refundReceivedClp: number | string | null,
  lines: ForeignTradeReconciliationAmountLine[],
): ForeignTradeReconciliationResult {
  let provisionExpenses = new Decimal(0);
  let actualExpenses = new Decimal(0);
  let provisionTaxes = new Decimal(0);
  let actualTaxes = new Decimal(0);

  const lineConversions: ForeignTradeReconciliationLineCalculation[] = [];
  const lineDifferences = lines.map((line) => {
    const provisionConversion = convertedAmount(
      line.provision_amount_original,
      line.provision_currency,
      line.provision_exchange_rate_clp,
    );
    const actualConversion = convertedAmount(
      line.actual_amount_original,
      line.actual_currency,
      line.actual_exchange_rate_clp,
    );
    const provision = resolvedProvisionTotal(line, provisionConversion);
    const actual = resolvedActualTotal(line);
    if (!isInformationalSummary(line.concept) && isIncludedInForeignTradeAgencyReconciliation(line)) {
      if (isTax(line.line_type)) {
        provisionTaxes = provisionTaxes.plus(provision);
        actualTaxes = actualTaxes.plus(actual);
      } else {
        provisionExpenses = provisionExpenses.plus(provision);
        actualExpenses = actualExpenses.plus(actual);
      }
    }
    const statedActual = money(line.actual_total_clp);
    const statedProvision = money(line.provision_total_clp);
    lineConversions.push({
      provisionConvertedClp: provisionConversion ? toMoney(provisionConversion) : null,
      provisionImpliedExchangeRateClp: impliedExchangeRate(
        line.provision_amount_original,
        line.provision_currency,
        line.provision_exchange_rate_clp,
        statedProvision,
      ),
      actualConvertedClp: actualConversion ? toMoney(actualConversion) : null,
      actualImpliedExchangeRateClp: impliedExchangeRate(
        line.actual_amount_original,
        line.actual_currency,
        line.actual_exchange_rate_clp,
        statedActual,
      ),
      actualAppliedTotalClp: toMoney(actual),
      conversionVarianceClp: actualConversion && !statedActual.isZero()
        ? toMoney(statedActual.minus(actualConversion))
        : null,
    });
    return isIncludedInForeignTradeAgencyReconciliation(line)
      ? toMoney(provision.minus(actual))
      : 0;
  });

  const provisionTotal = provisionExpenses.plus(provisionTaxes);
  const actualTotal = actualExpenses.plus(actualTaxes);
  const remittance = money(remittanceAmountClp);
  const received = money(refundReceivedClp);
  const balance = remittance.minus(actualTotal);

  return {
    provisionExpensesClp: toMoney(provisionExpenses),
    actualExpensesClp: toMoney(actualExpenses),
    provisionTaxesClp: toMoney(provisionTaxes),
    actualTaxesClp: toMoney(actualTaxes),
    provisionTotalClp: toMoney(provisionTotal),
    actualTotalClp: toMoney(actualTotal),
    balanceClp: toMoney(balance),
    refundDueClp: toMoney(Decimal.max(balance.minus(received), 0)),
    additionalPaymentClp: toMoney(Decimal.max(balance.negated(), 0)),
    refundReceivedClp: toMoney(received),
    lineDifferences,
    lineConversions,
  };
}

export function resolvedActualTotal(line: ForeignTradeReconciliationAmountLine) {
  const stated = money(line.actual_total_clp);
  if (!stated.isZero()) return stated;
  const components = money(line.actual_net_clp).plus(money(line.actual_vat_clp));
  if (!components.isZero()) return components;
  return convertedAmount(line.actual_amount_original, line.actual_currency, line.actual_exchange_rate_clp) || new Decimal(0);
}

function resolvedProvisionTotal(line: ForeignTradeReconciliationAmountLine, conversion: Decimal | null) {
  const stated = money(line.provision_total_clp);
  if (!stated.isZero()) return stated;
  return conversion || new Decimal(0);
}

function convertedAmount(
  amountOriginal: number | string | null | undefined,
  currency: string | null | undefined,
  exchangeRateClp: number | string | null | undefined,
) {
  const amount = money(amountOriginal);
  if (amount.isZero()) return null;
  if ((currency || "CLP").trim().toUpperCase() === "CLP") return amount;
  const rate = money(exchangeRateClp);
  if (rate.lte(0)) return null;
  return amount.times(rate);
}

function impliedExchangeRate(
  amountOriginal: number | string | null | undefined,
  currency: string | null | undefined,
  exchangeRateClp: number | string | null | undefined,
  statedTotalClp: Decimal,
) {
  const amount = money(amountOriginal);
  const rate = money(exchangeRateClp);
  if (
    amount.lte(0) ||
    statedTotalClp.lte(0) ||
    rate.gt(0) ||
    (currency || "CLP").trim().toUpperCase() === "CLP"
  ) return null;
  return statedTotalClp.dividedBy(amount).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber();
}

function isTax(type: ForeignTradeReconciliationLineType) {
  return type === "customs_duty" || type === "import_vat";
}

function isInformationalSummary(value: string | null | undefined) {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  return /^(?:(?:total|subtotal|suma)(?:desembolsos|gastos|rendicion|facturas?|documentos|general|facturaagencia|derechosaduana|aduana)?|remesa|pagodirecto|totalasufavor|saldoasufavor|devolucion)$/.test(normalized);
}

function money(value: number | string | null | undefined) {
  try {
    const parsed = new Decimal(value || 0);
    return parsed.isFinite() ? parsed : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

function toMoney(value: Decimal) {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}
