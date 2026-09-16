import { CopilotDataError, object } from "./contracts.ts";

export async function requireOpenAI(response: Response) {
  if (response.ok) return;
  const provider = object(
    object(await response.json().catch(() => ({}))).error,
  );
  if (
    [
      "insufficient_quota",
      "credit_balance_exhausted",
      "billing_hard_limit_reached",
    ].includes(String(provider.code)) ||
    provider.type === "insufficient_quota"
  )
    throw new CopilotDataError(
      "OpenAI no tiene saldo o cuota disponible en la cuenta API. El administrador debe revisar la facturacion de OpenAI. Los datos del CRM no se modificaron.",
      "AI_QUOTA_EXHAUSTED",
    );
  if (response.status === 429)
    throw new CopilotDataError(
      "OpenAI alcanzo su limite temporal de solicitudes. Espera un momento y vuelve a consultar.",
      "AI_RATE_LIMITED",
    );
  if (response.status === 403 || response.status === 404)
    throw new CopilotDataError(
      "El proyecto OpenAI no tiene acceso al modelo o servicio solicitado. Revisa los permisos del proyecto.",
      "AI_MODEL_ACCESS",
    );
  throw new CopilotDataError(
    `El servicio de IA no pudo responder (${response.status}). Puedes continuar por texto si la voz no esta disponible.`,
    "AI_PROVIDER_ERROR",
  );
}
