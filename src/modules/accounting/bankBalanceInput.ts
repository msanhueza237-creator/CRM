export function parseBankControlNumber(value: string): number {
  const text = value.trim().replace(/\s/g, '');
  if (!text || !/^-?\d[\d.,]*$/.test(text)) return NaN;
  let normalized = text;
  if (text.includes(',')) {
    if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,8}$/.test(text)) return NaN;
    normalized = text.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(text)) normalized = text.replace(/\./g, '');
  else if (!/^-?\d+(?:\.\d{1,8})?$/.test(text)) return NaN;
  const result = Number(normalized);
  return Number.isFinite(result) ? result : NaN;
}

export function bankControlValue(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '' : new Intl.NumberFormat('es-CL', {useGrouping:false,maximumFractionDigits:8}).format(value);
}
