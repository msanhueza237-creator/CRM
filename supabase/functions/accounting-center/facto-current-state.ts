export type FactoCurrentStateInput = {
  currentReceivablesClp: number;
  targetReceivablesClp: number;
  currentPayablesClp: number;
  targetPayablesClp: number;
};

export type FactoCurrentStateLine = {
  classification: "receivables" | "payables" | "suspense_asset" | "suspense_liability";
  debit: number;
  credit: number;
  description: string;
};

const money = (value: number) => Math.round(value * 10_000) / 10_000;

export function buildFactoCurrentStateAdjustment(input: FactoCurrentStateInput) {
  const receivablesDelta = money(input.targetReceivablesClp - input.currentReceivablesClp);
  const payablesDelta = money(input.targetPayablesClp - input.currentPayablesClp);
  const lines: FactoCurrentStateLine[] = [];

  if (receivablesDelta < -0.005) {
    const amount = Math.abs(receivablesDelta);
    lines.push(
      {
        classification: "suspense_asset",
        debit: amount,
        credit: 0,
        description: "Cobros Facto pendientes de identificar en cartola bancaria",
      },
      {
        classification: "receivables",
        debit: 0,
        credit: amount,
        description: "Actualización de cuentas por cobrar según foto de impagos Facto",
      },
    );
  } else if (receivablesDelta > 0.005) {
    lines.push(
      {
        classification: "receivables",
        debit: receivablesDelta,
        credit: 0,
        description: "Restitución de saldo por cobrar según foto de impagos Facto",
      },
      {
        classification: "suspense_asset",
        debit: 0,
        credit: receivablesDelta,
        description: "Regularización de cobros Facto pendientes de cartola",
      },
    );
  }

  if (payablesDelta < -0.005) {
    const amount = Math.abs(payablesDelta);
    lines.push(
      {
        classification: "payables",
        debit: amount,
        credit: 0,
        description: "Actualización de cuentas por pagar según foto de impagos Facto",
      },
      {
        classification: "suspense_liability",
        debit: 0,
        credit: amount,
        description: "Pagos Facto pendientes de identificar en cartola bancaria",
      },
    );
  } else if (payablesDelta > 0.005) {
    lines.push(
      {
        classification: "suspense_liability",
        debit: payablesDelta,
        credit: 0,
        description: "Regularización de pagos Facto pendientes de cartola",
      },
      {
        classification: "payables",
        debit: 0,
        credit: payablesDelta,
        description: "Restitución de saldo por pagar según foto de impagos Facto",
      },
    );
  }

  return { receivablesDelta, payablesDelta, lines };
}
