import type { FactoTaskLease, FactoSyncPreview, JsonObject } from "./types.ts";

export class CrmAgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly workerId: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async claim(): Promise<FactoTaskLease | null> {
    const result = await this.post("facto-receivables/claim", {
      worker_id: this.workerId,
      lease_seconds: 300,
    });
    if (!result.task) return null;
    const task = asObject(result.task);
    if (task.action !== "sync_facto_receivables") {
      throw new Error(`El worker recibió una tarea de cobranza no soportada: ${String(task.action || "sin acción")}.`);
    }
    return {
      task: task as unknown as FactoTaskLease["task"],
      leaseToken: requiredText(result.lease_token, "lease_token"),
      leaseExpiresAt: requiredText(result.lease_expires_at, "lease_expires_at"),
    };
  }

  async heartbeat(lease: FactoTaskLease) {
    await this.post(`tasks/${lease.task.id}/heartbeat`, {
      worker_id: this.workerId,
      lease_token: lease.leaseToken,
      lease_seconds: 300,
    });
  }

  async event(
    lease: FactoTaskLease,
    stage: string,
    message: string,
    metrics: JsonObject = {},
    level: "debug" | "info" | "warning" | "error" = "info",
  ) {
    await this.post("facto-receivables/event", {
      ...this.leasePayload(lease),
      stage,
      message,
      metrics,
      level,
    });
  }

  async stage(lease: FactoTaskLease, preview: FactoSyncPreview) {
    for (let offset = 0; offset < preview.items.length; offset += 100) {
      await this.post("facto-receivables/stage", {
        ...this.leasePayload(lease),
        items: preview.items.slice(offset, offset + 100),
      });
      await this.heartbeat(lease);
    }
  }

  async finalize(lease: FactoTaskLease, preview: FactoSyncPreview) {
    return await this.post("facto-receivables/finalize", {
      ...this.leasePayload(lease),
      source_as_of: preview.sourceAsOf,
      api_documents: preview.apiDocuments,
      browser_rows: preview.browserRows,
      overdue_documents: preview.overdueDocuments,
      partial_payment_documents: preview.partialPaymentDocuments,
      coverage: preview.coverage,
      warnings: preview.warnings,
    });
  }

  async fail(lease: FactoTaskLease, errorCode: string, message: string, detail: JsonObject = {}) {
    return await this.post("facto-receivables/fail", {
      ...this.leasePayload(lease),
      error_code: errorCode.slice(0, 120),
      message: message.slice(0, 800),
      detail,
    });
  }

  async failTask(lease: FactoTaskLease, errorCode: string) {
    return await this.post(`tasks/${lease.task.id}/fail`, {
      worker_id: this.workerId,
      lease_token: lease.leaseToken,
      error: errorCode.slice(0, 200),
    });
  }

  private leasePayload(lease: FactoTaskLease) {
    return {
      run_id: lease.task.payload.run_id,
      task_id: lease.task.id,
      worker_id: this.workerId,
      lease_token: lease.leaseToken,
    };
  }

  private async post(operation: string, payload: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/hub/${operation}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-climactiva-api-key": this.apiKey,
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(result.error || `Agent Hub respondió con error ${response.status}.`));
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Agent Hub agotó el tiempo de espera.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredText(value: unknown, field: string) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`Agent Hub no entregó ${field}.`);
  return text;
}
