import { loadFactoConnectorConfig } from "./config.ts";
import { CrmAgentClient } from "./crm-agent-client.ts";
import { FactoApiService } from "./facto-api-service.ts";
import { FactoBrowserService } from "./facto-browser-service.ts";
import { FactoSyncService } from "./facto-sync-service.ts";
import { SafeLogger } from "./logger.ts";
import type { FactoTaskLease } from "./types.ts";

const watchMode = process.argv.includes("--watch");
const pollSeconds = boundedInteger(process.env.FACTO_WORKER_POLL_SECONDS, 10, 600, 30);
let stopping = false;

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

await main();

async function main() {
  const config = loadFactoConnectorConfig();
  const logger = new SafeLogger({ service: "facto-receivables-connector", worker_id: config.workerId });
  const agent = new CrmAgentClient(config.crmAgentUrl, config.crmAgentApiKey, config.workerId, config.api.timeoutMs);
  do {
    const worked = await runOne(agent, config, logger).catch((error) => {
      logger.error("El worker local no pudo procesar la tarea.", error, { stage: "worker" });
      return false;
    });
    if (!watchMode || stopping) break;
    if (!worked) await delay(pollSeconds * 1000);
  } while (!stopping);
}

async function runOne(
  agent: CrmAgentClient,
  config: ReturnType<typeof loadFactoConnectorConfig>,
  rootLogger: SafeLogger,
) {
  const lease = await agent.claim();
  if (!lease) {
    rootLogger.info("No hay lecturas Facto pendientes.", { stage: "idle" });
    return false;
  }
  const logger = rootLogger.child({ run_id: lease.task.payload.run_id, task_id: lease.task.id });
  let heartbeatBusy = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  try {
    validateTask(lease);
    heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void agent.heartbeat(lease)
        .catch((error) => logger.error("No se pudo renovar el arriendo de la tarea.", error, { stage: "heartbeat" }))
        .finally(() => { heartbeatBusy = false; });
    }, 60_000);
    await agent.event(lease, "started", "Worker local inició una lectura Facto de solo lectura.", {
      from_date: lease.task.payload.from_date,
      to_date: lease.task.payload.to_date,
      api_first: true,
      browser_read_only: true,
    });
    const api = new FactoApiService(config.api, logger);
    const browser = new FactoBrowserService(config.browser, logger);
    const sync = new FactoSyncService(api, browser, logger);
    const preview = await sync.previewReceivables(lease.task.payload.from_date, lease.task.payload.to_date);
    await agent.event(lease, "normalization", "API y cartera web fueron normalizadas sin modificar el CRM.", {
      api_documents: preview.apiDocuments,
      browser_rows: preview.browserRows,
      preview_items: preview.items.length,
      complete: preview.coverage.complete,
    });
    await agent.stage(lease, preview);
    const final = await agent.finalize(lease, preview);
    logger.info("Lectura Facto finalizada.", {
      stage: "complete",
      status: String(final.status || "unknown"),
      preview_items: preview.items.length,
    });
    return true;
  } catch (error) {
    const message = safeErrorMessage(error);
    const errorCode = classifyError(message);
    await agent.fail(lease, errorCode, message, {
      read_only: true,
      existing_financial_data_preserved: true,
    }).catch(async (reportError) => {
      logger.error("No se pudo reportar el fallo detallado al Agent Hub.", reportError, { stage: "fail_report" });
      await agent.failTask(lease, errorCode).catch((fallbackError) => {
        logger.error("Tampoco se pudo cerrar la tarea fallida.", fallbackError, { stage: "fail_task" });
      });
    });
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function validateTask(lease: FactoTaskLease) {
  const payload = lease.task.payload;
  if (payload.mode !== "dry_run" || payload.read_only !== true) {
    throw new Error("El worker rechazó una tarea Facto que no era de solo lectura y previsualización.");
  }
  if (![payload.run_id, payload.entity_id, lease.task.id, lease.leaseToken].every(isUuid)) {
    throw new Error("La tarea Facto contiene identificadores inválidos.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.from_date) || !/^\d{4}-\d{2}-\d{2}$/.test(payload.to_date)) {
    throw new Error("La tarea Facto contiene un período inválido.");
  }
}

function classifyError(message: string) {
  const normalized = message.toLowerCase();
  if (/captcha|verificaci[oó]n interactiva|dos factores|2fa|mfa/.test(normalized)) return "FACTO_INTERACTIVE_CHALLENGE";
  if (/autenticaci[oó]n|inicio de sesi[oó]n|token/.test(normalized)) return "FACTO_AUTH_FAILED";
  if (/tiempo de espera|timeout/.test(normalized)) return "FACTO_TIMEOUT";
  if (/tabla|secci[oó]n|p[aá]gina distinta|paginaci[oó]n/.test(normalized)) return "FACTO_UI_CHANGED";
  return "FACTO_SYNC_FAILED";
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 800);
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function boundedInteger(value: string | undefined, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
