import {
  CopilotDataError,
  object,
  rows,
  type CopilotActor,
  type RestConfig,
  type Row,
} from "./contracts.ts";

export class CopilotSources {
  private cache = new Map<string, Promise<unknown>>();
  readonly metrics = { databaseMs: 0, serviceMs: 0, requests: 0, cacheHits: 0 };
  constructor(
    public config: RestConfig,
    public actor: CopilotActor,
    public signal?: AbortSignal,
    private fetcher: typeof fetch = fetch,
    private timeoutMs = 20000,
  ) {}

  memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) this.cache.set(key, load());
    else this.metrics.cacheHits++;
    return this.cache.get(key) as Promise<T>;
  }
  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController(), started = Date.now();
    const abort = () => controller.abort();
    if (this.signal?.aborted) abort();
    this.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    this.metrics.requests++;
    try {
      const response = await this.fetcher(`${this.config.url}/${path}`, { ...init, signal: controller.signal });
      // Read the body while the deadline is active, not only the response headers.
      const body = await response.text();
      return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, headers: response.headers });
    } catch (error) {
      if (controller.signal.aborted && !this.signal?.aborted)
        throw new CopilotDataError("La fuente excedio el tiempo de lectura. Acota el periodo o vuelve a intentar.", "SOURCE_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", abort);
      this.metrics[path.startsWith("rest/") ? "databaseMs" : "serviceMs"] += Date.now() - started;
    }
  }
  async request(
    path: string,
    init: RequestInit = {},
    user = false,
  ): Promise<unknown> {
    const response = await this.fetch(path, {
      ...init,
      signal: this.signal,
      headers: {
        apikey: user ? this.config.anonKey : this.config.serviceRoleKey,
        Authorization: `Bearer ${user ? this.actor.accessToken : this.config.serviceRoleKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok)
      throw new CopilotDataError(
        response.status === 403
          ? "Tu perfil no permite consultar esta fuente."
          : `La fuente ${path.split("?")[0]} no pudo responder (${response.status}).`,
        response.status === 403 ? "FORBIDDEN" : "SOURCE_UNAVAILABLE",
      );
    return response.json();
  }
  select(path: string): Promise<Row[]> {
    return this.memo(path, async () =>
      rows(await this.request(`rest/v1/${path}`)),
    );
  }
  all(path: string, max = 10000): Promise<Row[]> {
    return this.memo(`all:${path}:${max}`, async () => {
      const result: Row[] = [];
      for (let offset = 0; offset <= max;) {
        const response = await this.fetch(
          `rest/v1/${path}&limit=500&offset=${offset}`,
          {
            signal: this.signal,
            headers: {
              apikey: this.config.serviceRoleKey,
              Authorization: `Bearer ${this.config.serviceRoleKey}`,
              Prefer: "count=exact",
            },
          },
        );
        if (!response.ok)
          throw new CopilotDataError(
            `No se pudo consultar ${path.split("?")[0]} (${response.status}).`,
          );
        const count = response.headers.get("content-range")?.split("/")[1];
        if (!count || !/^\d+$/.test(count))
          throw new CopilotDataError(
            "La fuente no confirma el total de registros. No se presentara una lista incompleta como completa.",
            "COVERAGE_LIMIT",
          );
        const total = Number(count),
          page = rows(await response.json());
        if (total > max)
          throw new CopilotDataError(
            "La consulta supera el limite. Acota el periodo o el filtro; no se mostraran totales parciales como completos.",
            "COVERAGE_LIMIT",
          );
        result.push(...page);
        if (result.length > max)
          throw new CopilotDataError(
            "La consulta supera el limite. Acota el periodo o el filtro; no se mostraran totales parciales como completos.",
            "COVERAGE_LIMIT",
          );
        offset += page.length;
        if (offset >= total) return result;
        if (!page.length)
          throw new CopilotDataError(
            "La fuente cambio durante la lectura. Vuelve a consultar.",
            "COVERAGE_LIMIT",
          );
      }
      throw new CopilotDataError(
        "No se pudo verificar la cobertura completa.",
        "COVERAGE_LIMIT",
      );
    });
  }
  records(resource: string, provider = "facto") {
    return this.all(
      `integration_records?select=id,external_id,payload,updated_at&provider=eq.${encodeURIComponent(provider)}&resource=eq.${encodeURIComponent(resource)}&order=id.asc`,
    );
  }
  rpc(name: string, args: Row = {}, user = true): Promise<unknown> {
    return this.memo(`rpc:${name}:${JSON.stringify(args)}`, () =>
      this.request(
        `rest/v1/rpc/${name}`,
        { method: "POST", body: JSON.stringify(args) },
        user,
      ),
    );
  }
  api(service: string, route: string): Promise<Row> {
    return this.memo(`api:${service}/${route}`, async () =>
      object(await this.request(`functions/v1/${service}/${route}`, {}, true)),
    );
  }
  entity(): Promise<string> {
    return this.memo("entity", async () => {
      const entities = await this.select(
        "accounting_entities?select=id&active=eq.true&order=created_at.asc&limit=2",
      );
      if (entities.length !== 1)
        throw new CopilotDataError(
          "Es necesario seleccionar una empresa contable autorizada.",
          "ENTITY_AMBIGUOUS",
        );
      return String(entities[0].id);
    });
  }
}
