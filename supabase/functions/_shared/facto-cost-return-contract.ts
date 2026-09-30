export type FactoCostReturnInput = {
  entityId: string;
  sourceDocumentId: string;
  amountClp: number;
  evidence: string;
  saleableReturnConfirmed: boolean;
};

export type FactoCostReturnPreview = {
  id: string;
  folio: string;
  date: string;
  invoiceId: string;
  invoiceFolio: string;
  originalCost: number;
  otherReversals: number;
  amountClp: number;
  remainingCost: number;
  reviewKey: string;
};
