import {
  buildSocialCaption,
  classifyInstagramContainerStatus,
  isFacebookPublishPermissionMissing,
  isInstagramMediaNotReady,
} from "./social-publishing-logic.ts";

export type SocialChannelCode = "instagram" | "facebook";

export type SocialConnectionStatus = {
  connected: boolean;
  status: "connected" | "pending_configuration" | "error";
  message: string;
  accountId?: string;
  accountName?: string;
};

export type SocialPostInput = {
  body: string;
  cta?: string | null;
  hashtags: string[];
  imageUrl?: string | null;
  productUrl?: string | null;
  idempotencyKey: string;
};

export type SocialPostResult = {
  externalId: string;
  externalUrl?: string;
  raw: Record<string, unknown>;
};

export type SocialMetrics = {
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  raw: Record<string, unknown>;
};

export interface SocialChannelAdapter {
  readonly channel: SocialChannelCode;
  validateConnection(): Promise<SocialConnectionStatus>;
  createPost(input: SocialPostInput): Promise<SocialPostResult>;
  getPostStatus(externalId: string): Promise<Record<string, unknown>>;
  getMetrics(externalId: string): Promise<SocialMetrics>;
}

export class SocialPublishError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly status = 502,
  ) {
    super(message);
  }
}

type MetaConfig = {
  accessToken: string;
  graphVersion: string;
  facebookPageId: string;
  instagramAccountId: string;
};

function readMetaConfig(): MetaConfig {
  return {
    accessToken: Deno.env.get("META_SOCIAL_ACCESS_TOKEN")?.trim() || "",
    graphVersion: Deno.env.get("META_GRAPH_API_VERSION")?.trim() || "v25.0",
    facebookPageId: Deno.env.get("META_FACEBOOK_PAGE_ID")?.trim() || "",
    instagramAccountId: Deno.env.get("META_INSTAGRAM_BUSINESS_ACCOUNT_ID")?.trim() || "",
  };
}

function graphUrl(config: MetaConfig, path: string) {
  return `https://graph.facebook.com/${config.graphVersion}/${path.replace(/^\/+/, "")}`;
}

async function graphRequest(
  config: MetaConfig,
  path: string,
  options: { method?: "GET" | "POST"; params?: Record<string, string> } = {},
) {
  const method = options.method || "GET";
  const params = new URLSearchParams(options.params || {});
  params.set("access_token", config.accessToken);
  const base = graphUrl(config, path);
  const response = await fetch(method === "GET" ? `${base}?${params}` : base, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
    body: method === "POST" ? params : undefined,
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const graphError = data.error && typeof data.error === "object"
      ? data.error as Record<string, unknown>
      : {};
    const graphCode = Number(graphError.code || 0);
    const retryable = response.status === 429 || [1, 2, 4, 17, 32, 613].includes(graphCode);
    throw new SocialPublishError(
      String(graphError.message || "Meta rechazo la operacion."),
      `meta_${graphCode || response.status}`,
      retryable,
      response.status,
    );
  }
  return data;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForInstagramContainer(config: MetaConfig, creationId: string) {
  const attempts = 15;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const raw = await graphRequest(config, creationId, {
      params: { fields: "status_code,status" },
    });
    const status = classifyInstagramContainerStatus(raw);
    console.info("[content-center][instagram] estado del contenedor", {
      creationId,
      attempt,
      statusCode: status.statusCode,
    });
    if (status.state === "ready") return raw;
    if (status.state === "failed") {
      throw new SocialPublishError(
        `Instagram no pudo preparar la imagen${status.message ? `: ${status.message}` : "."}`,
        `instagram_container_${status.statusCode.toLowerCase()}`,
        false,
        422,
      );
    }
    if (attempt < attempts) await delay(2_000);
  }
  throw new SocialPublishError(
    "Instagram aun esta procesando la imagen. El sistema volvera a intentarlo automaticamente.",
    "instagram_container_processing",
    true,
    503,
  );
}

async function publishInstagramContainer(config: MetaConfig, accountId: string, creationId: string) {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await graphRequest(config, `${accountId}/media_publish`, {
        method: "POST",
        params: { creation_id: creationId },
      });
    } catch (error) {
      if (!isInstagramMediaNotReady(error)) throw error;
      if (attempt < attempts) {
        await delay(2_000);
        continue;
      }
      throw new SocialPublishError(
        "Instagram todavia no termina de preparar la imagen. El sistema volvera a intentarlo automaticamente.",
        "instagram_media_not_ready",
        true,
        503,
      );
    }
  }
  throw new SocialPublishError(
    "Instagram no confirmo que la imagen estuviera lista.",
    "instagram_media_not_ready",
    true,
    503,
  );
}

function readInsightValues(raw: Record<string, unknown>) {
  const result: Record<string, number> = {};
  const rows = Array.isArray(raw.data) ? raw.data : [];
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = String(row.name || "");
    if (!name) continue;
    const totalValue = row.total_value && typeof row.total_value === "object"
      ? Number((row.total_value as Record<string, unknown>).value)
      : Number.NaN;
    const values = Array.isArray(row.values) ? row.values : [];
    const last = values[values.length - 1];
    const lastValue = last && typeof last === "object"
      ? Number((last as Record<string, unknown>).value)
      : Number.NaN;
    const value = Number.isFinite(totalValue) ? totalValue : lastValue;
    if (Number.isFinite(value)) result[name] = value;
  }
  return result;
}

abstract class MetaAdapterBase implements SocialChannelAdapter {
  abstract readonly channel: SocialChannelCode;
  protected readonly config = readMetaConfig();

  protected missing(...values: string[]) {
    return !this.config.accessToken || values.some((value) => !value);
  }

  abstract validateConnection(): Promise<SocialConnectionStatus>;
  abstract createPost(input: SocialPostInput): Promise<SocialPostResult>;

  async getPostStatus(externalId: string) {
    if (!this.config.accessToken) throw missingConfiguration();
    return await graphRequest(this.config, externalId, {
      params: { fields: "id,created_time,permalink_url" },
    });
  }

  async getMetrics(externalId: string): Promise<SocialMetrics> {
    if (!this.config.accessToken) throw missingConfiguration();
    const fields = this.channel === "instagram"
      ? "like_count,comments_count,permalink"
      : "shares,comments.summary(true),reactions.summary(true)";
    const post = await graphRequest(this.config, externalId, { params: { fields } });
    const comments = post.comments && typeof post.comments === "object"
      ? Number((post.comments as Record<string, unknown>).summary &&
        typeof (post.comments as Record<string, unknown>).summary === "object"
        ? ((post.comments as Record<string, unknown>).summary as Record<string, unknown>).total_count || 0
        : 0)
      : Number(post.comments_count || 0);
    const likes = post.reactions && typeof post.reactions === "object"
      ? Number((post.reactions as Record<string, unknown>).summary &&
        typeof (post.reactions as Record<string, unknown>).summary === "object"
        ? ((post.reactions as Record<string, unknown>).summary as Record<string, unknown>).total_count || 0
        : 0)
      : Number(post.like_count || 0);
    const sharesFromPost = post.shares && typeof post.shares === "object"
      ? Number((post.shares as Record<string, unknown>).count || 0)
      : 0;

    let insightValues: Record<string, number> = {};
    let insightRaw: Record<string, unknown> | null = null;
    let insightError: Record<string, unknown> | null = null;
    try {
      const metrics = this.channel === "instagram"
        ? "views,reach,saved,shares,total_interactions"
        : "post_media_views,post_media_viewers,post_clicks";
      insightRaw = await graphRequest(this.config, `${externalId}/insights`, {
        params: { metric: metrics },
      });
      insightValues = readInsightValues(insightRaw);
    } catch (error) {
      if (error instanceof SocialPublishError && error.retryable) throw error;
      insightError = {
        code: error instanceof SocialPublishError ? error.code : "meta_insights_unavailable",
        message: error instanceof Error ? error.message : "Meta no entrego metricas ampliadas.",
      };
    }

    return {
      impressions: insightValues.views ?? insightValues.post_media_views,
      reach: insightValues.reach ?? insightValues.post_media_viewers,
      likes: insightValues.likes ?? likes,
      comments: insightValues.comments ?? comments,
      shares: insightValues.shares ?? sharesFromPost,
      saves: insightValues.saved,
      clicks: insightValues.post_clicks,
      raw: { post, insights: insightRaw, insights_error: insightError },
    };
  }
}

export class InstagramAdapter extends MetaAdapterBase {
  readonly channel = "instagram" as const;

  async validateConnection(): Promise<SocialConnectionStatus> {
    if (this.missing(this.config.instagramAccountId)) return pendingConnection("Instagram");
    try {
      const data = await graphRequest(this.config, this.config.instagramAccountId, {
        params: { fields: "id,username,name" },
      });
      return {
        connected: true,
        status: "connected",
        message: "Instagram conectado mediante Meta.",
        accountId: String(data.id || this.config.instagramAccountId),
        accountName: String(data.username || data.name || "Instagram"),
      };
    } catch (error) {
      return failedConnection("Instagram", error);
    }
  }

  async createPost(input: SocialPostInput): Promise<SocialPostResult> {
    if (this.missing(this.config.instagramAccountId)) throw missingConfiguration();
    if (!input.imageUrl) {
      throw new SocialPublishError(
        "Instagram requiere una imagen publica para esta publicacion.",
        "instagram_image_required",
        false,
        422,
      );
    }
    const container = await graphRequest(this.config, `${this.config.instagramAccountId}/media`, {
      method: "POST",
      params: { image_url: input.imageUrl, caption: buildSocialCaption(input) },
    });
    const creationId = String(container.id || "");
    if (!creationId) throw new SocialPublishError("Meta no devolvio el contenedor de Instagram.", "instagram_container_missing", true);
    await waitForInstagramContainer(this.config, creationId);
    const published = await publishInstagramContainer(this.config, this.config.instagramAccountId, creationId);
    const externalId = String(published.id || "");
    if (!externalId) throw new SocialPublishError("Meta no confirmo la publicacion de Instagram.", "instagram_publish_missing", true);
    return { externalId, raw: { container_id: creationId, media_id: externalId } };
  }
}

export class FacebookAdapter extends MetaAdapterBase {
  readonly channel = "facebook" as const;

  async validateConnection(): Promise<SocialConnectionStatus> {
    if (this.missing(this.config.facebookPageId)) return pendingConnection("Facebook");
    try {
      const data = await graphRequest(this.config, this.config.facebookPageId, {
        params: { fields: "id,name,link" },
      });
      return {
        connected: true,
        status: "connected",
        message: "Pagina de Facebook conectada mediante Meta.",
        accountId: String(data.id || this.config.facebookPageId),
        accountName: String(data.name || "Facebook"),
      };
    } catch (error) {
      return failedConnection("Facebook", error);
    }
  }

  async createPost(input: SocialPostInput): Promise<SocialPostResult> {
    if (this.missing(this.config.facebookPageId)) throw missingConfiguration();
    const text = buildSocialCaption(input);
    let data: Record<string, unknown>;
    try {
      data = input.imageUrl
        ? await graphRequest(this.config, `${this.config.facebookPageId}/photos`, {
          method: "POST",
          params: { url: input.imageUrl, caption: text, published: "true" },
        })
        : await graphRequest(this.config, `${this.config.facebookPageId}/feed`, {
          method: "POST",
          params: { message: text, ...(input.productUrl ? { link: input.productUrl } : {}) },
        });
    } catch (error) {
      if (isFacebookPublishPermissionMissing(error)) {
        throw new SocialPublishError(
          "Facebook esta conectado para lectura, pero el token no permite publicar. Habilita pages_manage_posts en Meta, genera un nuevo token de pagina y actualiza META_SOCIAL_ACCESS_TOKEN en Supabase.",
          "facebook_publish_permission_missing",
          false,
          403,
        );
      }
      throw error;
    }
    const externalId = String(data.post_id || data.id || "");
    if (!externalId) throw new SocialPublishError("Meta no confirmo la publicacion de Facebook.", "facebook_publish_missing", true);
    return { externalId, raw: { post_id: externalId } };
  }
}

export function createSocialAdapter(channel: SocialChannelCode): SocialChannelAdapter {
  return channel === "instagram" ? new InstagramAdapter() : new FacebookAdapter();
}

function pendingConnection(channel: string): SocialConnectionStatus {
  return {
    connected: false,
    status: "pending_configuration",
    message: `${channel} no esta conectado. Configura Meta Social en Administracion > Integraciones.`,
  };
}

function failedConnection(channel: string, error: unknown): SocialConnectionStatus {
  return {
    connected: false,
    status: "error",
    message: error instanceof Error ? `${channel}: ${error.message}` : `${channel}: no se pudo validar la conexion.`,
  };
}

function missingConfiguration() {
  return new SocialPublishError(
    "Meta Social no esta conectado. Configura la integracion antes de publicar.",
    "meta_social_not_configured",
    false,
    409,
  );
}
