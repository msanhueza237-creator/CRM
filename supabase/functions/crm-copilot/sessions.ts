import { CopilotDataError, object, rows, type Row } from "./contracts.ts";
import { CopilotSources } from "./sources.ts";
import { redactSecrets, sessionExpires } from "./safety.ts";

export const validUuid = (value: unknown) =>
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
    String(value),
  );

export async function ownedConversation(
  source: CopilotSources,
  id: string,
  active = false,
  days = 30,
) {
  if (!validUuid(id)) throw new CopilotDataError("Conversacion invalida.");
  const result = await source.select(
    `copilot_conversations?select=id,title,metadata,created_at&user_id=eq.${source.actor.id}&id=eq.${id}&limit=1`,
  );
  if (
    !result.length ||
    object(result[0].metadata).role !== source.actor.role ||
    object(result[0].metadata).engine !== "central"
  )
    throw new CopilotDataError(
      "Conversacion no encontrada o fuera de los permisos actuales.",
      "FORBIDDEN",
    );
  if (
    active &&
    Date.parse(
      sessionExpires(object(result[0].metadata), result[0].created_at, days),
    ) <= Date.now()
  )
    throw new CopilotDataError(
      "Esta sesion vencio. Inicia una nueva conversacion.",
      "SESSION_EXPIRED",
    );
  return result[0];
}

export async function createConversation(
  source: CopilotSources,
  title: string,
  days: number,
): Promise<Row> {
  return rows(
    await source.request("rest/v1/copilot_conversations", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: source.actor.id,
        title: redactSecrets(title).slice(0, 90),
        metadata: {
          engine: "central",
          role: source.actor.role,
          expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
          contextVersion: 1,
        },
      }),
    }),
  )[0];
}
