import {
  type SocialChannelCode,
  SocialPublishError,
  createSocialAdapter,
} from "./social-adapters.ts";
import { ensureBrandHashtag, ensureOfficialWebsiteCta } from "./social-publishing-logic.ts";
import { findSimilarDraft, nextScheduleAt, selectRotatedProduct } from "./content-logic.ts";

type JsonRecord = Record<string, unknown>;
type AppRole = "administrador" | "vendedor" | "visualizador";

type Profile = {
  id: string;
  fullName: string;
  role: AppRole;
  active: boolean;
};

type RestClient = {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
};

const permissionsByRole: Record<AppRole, Set<string>> = {
  administrador: new Set([
    "content.view", "content.generate", "content.edit", "content.approve",
    "content.schedule", "content.publish", "content.automation.manage",
    "content.brand.manage", "content.templates.manage", "content.metrics.view",
    "content.settings.manage",
  ]),
  vendedor: new Set([
    "content.view", "content.generate", "content.edit", "content.schedule",
    "content.metrics.view",
  ]),
  visualizador: new Set(["content.view", "content.metrics.view"]),
};

const allowedChannels = new Set<SocialChannelCode>(["instagram", "facebook"]);
const maxJsonBodyBytes = 1_000_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });

  const requestId = req.headers.get("x-request-id")?.slice(0, 100) || crypto.randomUUID();
  try {
    const rest = getRestClient();
    const route = getRoute(req.url);

    if (route === "health") {
      return json({ ok: true, service: "content-center", requestId }, 200, req);
    }
    if (route === "worker/run" && req.method === "POST") {
      requireWorker(req, rest);
      const payload = await readJson(req, true);
      const limit = clampNumber(payload.limit, 1, 20, 5);
      return json(await runWorker(rest, limit, requestId), 200, req);
    }

    const user = await authenticateRequest(req, rest);
    const profile = await getProfile(rest, user.id);
    if (!profile?.active) throw new HttpError(403, "Tu usuario no esta activo en el CRM.");

    if (route === "bootstrap" && req.method === "GET") {
      requirePermission(profile, "content.view");
      return json(await getBootstrap(rest, profile, requestId), 200, req);
    }
    if (route === "products" && req.method === "GET") {
      requirePermission(profile, "content.view");
      return json(await getProducts(rest, new URL(req.url)), 200, req);
    }
    if (route === "sync-catalog" && req.method === "POST") {
      requirePermission(profile, "content.settings.manage");
      return json(await syncCatalog(rest, profile, requestId), 200, req);
    }
    if (route === "connections" && req.method === "GET") {
      requirePermission(profile, "content.view");
      return json(await checkConnections(rest), 200, req);
    }
    if (route === "generate" && req.method === "POST") {
      requirePermission(profile, "content.generate");
      return json(await generateContent(rest, profile, await readJson(req), requestId), 201, req);
    }
    if (route === "approve" && req.method === "POST") {
      requirePermission(profile, "content.approve");
      return json(await approvePublication(rest, profile, await readJson(req), requestId), 200, req);
    }
    if (route === "reject" && req.method === "POST") {
      requirePermission(profile, "content.approve");
      return json(await rejectPublication(rest, profile, await readJson(req), requestId), 200, req);
    }
    if (route === "schedule" && req.method === "POST") {
      requirePermission(profile, "content.schedule");
      return json(await schedulePublication(rest, profile, await readJson(req), requestId), 200, req);
    }
    if (route === "publish" && req.method === "POST") {
      requirePermission(profile, "content.publish");
      return json(await publishPublication(rest, profile, await readJson(req), requestId), 200, req);
    }

    throw new HttpError(404, "Ruta no encontrada.");
  } catch (error) {
    const status = error instanceof HttpError
      ? error.status
      : error instanceof SocialPublishError
      ? error.status
      : 500;
    const message = error instanceof Error ? error.message : "Error inesperado.";
    console.error("[content-center] request failed", { requestId, status, message });
    return json({ error: message, requestId }, status, req);
  }
});

async function getBootstrap(rest: RestClient, profile: Profile, requestId: string) {
  const [connections, channels, products, templates, brands, publications, schedules, rules] = await Promise.all([
    selectRows(rest, "integration_connections?select=provider,enabled,status,message,last_success_at&provider=in.(tiendanube,meta_social)"),
    selectRows(rest, "content_channels?select=*&order=name.asc"),
    selectRows(rest, "content_products?select=id,sync_status,source_status,paused,last_synced_at&limit=1000"),
    selectRows(rest, "content_templates?select=*&order=name.asc"),
    selectRows(rest, "brand_profiles?select=*&active=eq.true&order=is_default.desc&limit=10"),
    selectRows(rest, "content_publications?select=id,status,scheduled_at,published_at,channel_id,product_id,error_code&order=created_at.desc&limit=1000"),
    selectRows(rest, "content_schedules?select=*&order=next_run_at.asc.nullslast&limit=100"),
    selectRows(rest, "content_automation_rules?select=*&order=created_at.asc&limit=20"),
  ]);

  const tiendanube = connections.find((row) => row.provider === "tiendanube");
  let normalizedProducts = products;
  let firstSync: JsonRecord | null = null;
  if (!products.length && tiendanube?.status === "connected" && profile.role === "administrador") {
    firstSync = await syncCatalog(rest, profile, requestId);
    normalizedProducts = await selectRows(
      rest,
      "content_products?select=id,sync_status,source_status,paused,last_synced_at&limit=1000",
    );
  }

  const now = Date.now();
  const weekFromNow = now + 7 * 24 * 60 * 60 * 1000;
  const scheduledThisWeek = publications.filter((row) => {
    const date = Date.parse(String(row.scheduled_at || ""));
    return row.status === "scheduled" && date >= now && date <= weekFromNow;
  }).length;

  return {
    requestId,
    profile: { role: profile.role, permissions: [...permissionsByRole[profile.role]] },
    connections,
    channels,
    templates,
    brands,
    schedules,
    automationRules: rules,
    firstSync,
    summary: {
      products: normalizedProducts.length,
      productsIncomplete: normalizedProducts.filter((row) => row.sync_status === "incomplete").length,
      productsPaused: normalizedProducts.filter((row) => Boolean(row.paused)).length,
      publications: publications.length,
      publishedThisWeek: publications.filter((row) => isWithinPastDays(row.published_at, 7)).length,
      scheduledThisWeek,
      pendingApproval: publications.filter((row) => row.status === "pending_approval").length,
      failed: publications.filter((row) => row.status === "failed").length,
      nextPublication: publications
        .filter((row) => row.status === "scheduled" && Date.parse(String(row.scheduled_at || "")) >= now)
        .sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)))[0] || null,
    },
  };
}

async function getProducts(rest: RestClient, url: URL) {
  const search = (url.searchParams.get("search") || "").trim().toLocaleLowerCase("es-CL");
  const category = (url.searchParams.get("category") || "").trim();
  const status = (url.searchParams.get("status") || "").trim();
  const limit = clampNumber(url.searchParams.get("limit"), 1, 500, 200);
  const rows = await selectRows(
    rest,
    "content_products?select=*&order=updated_at.desc&limit=1000",
  );
  const filtered = rows.filter((row) => {
    if (search) {
      const haystack = `${row.name || ""} ${row.sku || ""} ${row.brand || ""}`.toLocaleLowerCase("es-CL");
      if (!haystack.includes(search)) return false;
    }
    if (category && row.category !== category) return false;
    if (status === "available" && (row.source_status !== "active" || row.sync_status !== "synced" || row.paused)) return false;
    if (status === "incomplete" && row.sync_status !== "incomplete") return false;
    if (status === "paused" && !row.paused) return false;
    return true;
  });
  return {
    products: filtered.slice(0, limit),
    total: filtered.length,
    categories: [...new Set(rows.map((row) => String(row.category || "")).filter(Boolean))].sort(),
  };
}

async function syncCatalog(rest: RestClient, profile: Profile, requestId: string) {
  const startedAt = Date.now();
  const result = await rpc(rest, "sync_content_products_from_tiendanube", {});
  const summary = Array.isArray(result) ? (result[0] || {}) : result;
  await insertRows(rest, "content_history", [{
    event_type: "catalog_synced",
    level: "info",
    message: "Catalogo de Tiendanube normalizado en la Biblioteca de Contenido.",
    metadata: { ...asObject(summary), duration_ms: Date.now() - startedAt },
    correlation_id: requestIdToUuid(requestId),
    actor_type: "user",
    actor_id: profile.id,
  }]);
  return { ...asObject(summary), durationMs: Date.now() - startedAt };
}

async function checkConnections(rest: RestClient) {
  const [tiendanubeRows, instagram, facebook] = await Promise.all([
    selectRows(rest, "integration_connections?select=provider,enabled,status,message,last_success_at&provider=eq.tiendanube&limit=1"),
    createSocialAdapter("instagram").validateConnection(),
    createSocialAdapter("facebook").validateConnection(),
  ]);
  const socialConnected = instagram.connected || facebook.connected;
  const socialStatus = socialConnected ? "connected" :
    instagram.status === "error" || facebook.status === "error" ? "error" : "pending_configuration";
  const socialMessage = socialConnected
    ? "Meta Social disponible para los canales validados."
    : "Falta conectar Instagram y Facebook desde Administracion > Integraciones.";
  await patchRows(rest, "integration_connections", "provider=eq.meta_social", {
    enabled: socialConnected,
    status: socialStatus,
    message: socialMessage,
    last_checked_at: new Date().toISOString(),
    ...(socialConnected ? { last_success_at: new Date().toISOString() } : {}),
  });
  for (const connection of [instagram, facebook]) {
    await patchRows(rest, "content_channels", `code=eq.${connection === instagram ? "instagram" : "facebook"}`, {
      enabled: connection.connected,
      external_account_id: connection.accountId || null,
      external_account_name: connection.accountName || null,
      last_checked_at: new Date().toISOString(),
      last_error: connection.connected ? null : connection.message,
    });
  }
  return { tiendanube: tiendanubeRows[0] || null, instagram, facebook };
}

async function generateContent(
  rest: RestClient,
  profile: Profile,
  payload: JsonRecord,
  requestId: string,
) {
  const productId = requiredUuid(payload.productId, "producto");
  const channelCodes = stringArray(payload.channels, 2)
    .filter((value): value is SocialChannelCode => allowedChannels.has(value as SocialChannelCode));
  if (!channelCodes.length) throw new HttpError(400, "Selecciona al menos una red social.");
  const variantCount = clampNumber(payload.variants, 1, 3, 1);
  const templateId = optionalUuid(payload.templateId);
  const brandProfileId = optionalUuid(payload.brandProfileId);
  const operationMode = oneOf(payload.operationMode, ["manual", "approval", "autopilot"], "approval");

  const [productRows, channelRows, templateRows, brandRows, recentRows] = await Promise.all([
    selectRows(rest, `content_products?select=*&id=eq.${productId}&limit=1`),
    selectRows(rest, `content_channels?select=*&code=in.(${channelCodes.join(",")})`),
    templateId ? selectRows(rest, `content_templates?select=*&id=eq.${templateId}&active=eq.true&limit=1`) : Promise.resolve([]),
    brandProfileId
      ? selectRows(rest, `brand_profiles?select=*&id=eq.${brandProfileId}&active=eq.true&limit=1`)
      : selectRows(rest, "brand_profiles?select=*&is_default=eq.true&active=eq.true&limit=1"),
    selectRows(rest, `content_publications?select=body,hashtags,channel_id,created_at&product_id=eq.${productId}&order=created_at.desc&limit=12`),
  ]);
  const product = productRows[0];
  if (!product) throw new HttpError(404, "Producto no encontrado en la Biblioteca de Contenido.");
  if (product.source_status !== "active" || product.paused) throw new HttpError(409, "El producto no esta disponible para generar contenido.");
  if (product.sync_status === "incomplete") {
    throw new HttpError(422, `Falta informacion verificada: ${stringArray(product.missing_fields, 10).join(", ")}.`);
  }
  const channelMap = new Map(channelRows.map((row) => [String(row.code), row]));
  if (channelCodes.some((code) => !channelMap.has(code))) throw new HttpError(409, "Uno de los canales no esta configurado.");

  const facts = buildProductFacts(product);
  const generation = await createGroundedVariants({
    facts,
    channels: channelCodes,
    variantCount,
    template: templateRows[0] || null,
    brand: brandRows[0] || null,
    objective: optionalText(payload.objective, 500),
    cta: optionalText(payload.cta, 300),
    publicationType: optionalText(payload.publicationType, 80) || "feed",
    context: optionalText(payload.context, 1000),
    useHashtags: payload.useHashtags !== false,
    recent: recentRows,
  });

  const repeated = findSimilarDraft(generation.variants, recentRows, 0.86);
  if (repeated) {
    throw new HttpError(422, `El borrador se parece demasiado a contenido reciente (${Math.round(repeated.similarity * 100)}%). Vuelve a generar para obtener otra estructura.`);
  }

  const numericIssues = generation.variants.flatMap((variant) =>
    unsupportedNumbers(`${variant.body} ${variant.cta}`, JSON.stringify(facts)).map((number) => `${variant.channel}: ${number}`)
  );
  if (numericIssues.length) {
    throw new HttpError(422, `La IA intento usar cifras no verificadas (${numericIssues.join(", ")}). No se guardo el contenido.`);
  }

  const verification = await verifyGrounding(facts, generation.variants);
  if (!verification.valid) {
    console.warn("[content-center] grounded verification blocked content", {
      requestId,
      unsupportedClaims: verification.unsupportedClaims,
    });
    throw new HttpError(422, `El borrador contenia afirmaciones no verificadas: ${verification.unsupportedClaims.join("; ") || "contenido sin respaldo"}.`);
  }

  const groupId = crypto.randomUUID();
  const rows: JsonRecord[] = [];
  for (const variant of generation.variants) {
    const channel = channelMap.get(variant.channel);
    if (!channel) continue;
    const brandedCta = ensureOfficialWebsiteCta(variant.cta);
    const brandedHashtags = ensureBrandHashtag(variant.hashtags);
    rows.push({
      generation_group_id: groupId,
      product_id: productId,
      channel_id: channel.id,
      template_id: templateRows[0]?.id || null,
      brand_profile_id: brandRows[0]?.id || null,
      publication_type: optionalText(payload.publicationType, 80) || "feed",
      objective: optionalText(payload.objective, 500),
      cta: brandedCta,
      body: variant.body,
      hashtags: brandedHashtags,
      image_url: String(product.primary_image_url || "") || null,
      source_facts: facts,
      missing_facts: [],
      content_fingerprint: await sha256(`${variant.channel}|${normalizeForFingerprint(variant.body)}`),
      model_name: generation.model,
      generator_type: String(payload.generatorType || "user") === "agent" ? "agent" : "user",
      generator_id: optionalText(payload.generatorId, 120) || profile.id,
      operation_mode: operationMode,
      status: operationMode === "manual" ? "draft" : "pending_approval",
      correlation_id: requestIdToUuid(requestId),
      created_by: profile.id,
      updated_by: profile.id,
    });
  }
  if (!rows.length) throw new HttpError(502, "La IA no produjo variantes utilizables.");
  const inserted = await insertRows(rest, "content_publications", rows);
  await insertRows(rest, "content_history", inserted.map((row) => ({
    publication_id: row.id,
    product_id: productId,
    event_type: "content_generated",
    message: `Borrador generado para ${channelCodeById(channelRows, String(row.channel_id))}.`,
    metadata: { model: generation.model, template_id: templateRows[0]?.id || null },
    correlation_id: requestIdToUuid(requestId),
    actor_type: String(payload.generatorType || "user") === "agent" ? "agent" : "user",
    actor_id: optionalText(payload.generatorId, 120) || profile.id,
  })));
  return { groupId, publications: inserted, verification, requestId };
}

async function approvePublication(rest: RestClient, profile: Profile, payload: JsonRecord, requestId: string) {
  const id = requiredUuid(payload.publicationId, "publicacion");
  const rows = await selectRows(rest, `content_publications?select=id,status,product_id,correlation_id&id=eq.${id}&limit=1`);
  const publication = rows[0];
  if (!publication) throw new HttpError(404, "Publicacion no encontrada.");
  if (!['draft', 'pending_approval'].includes(String(publication.status))) throw new HttpError(409, "La publicacion ya fue procesada.");
  const now = new Date().toISOString();
  const updated = await patchRows(rest, "content_publications", `id=eq.${id}`, {
    status: "approved", approved_by: profile.id, approved_at: now,
    updated_by: profile.id, error_code: null, error_message: null,
  });
  await history(rest, publication, "content_approved", "Contenido aprobado para programacion o publicacion.", profile, requestId);
  return { publication: updated[0] || null };
}

async function rejectPublication(rest: RestClient, profile: Profile, payload: JsonRecord, requestId: string) {
  const id = requiredUuid(payload.publicationId, "publicacion");
  const rows = await selectRows(rest, `content_publications?select=id,status,product_id,correlation_id&id=eq.${id}&limit=1`);
  const publication = rows[0];
  if (!publication) throw new HttpError(404, "Publicacion no encontrada.");
  if (!["draft", "pending_approval"].includes(String(publication.status))) {
    throw new HttpError(409, "La publicacion ya fue procesada.");
  }
  const reason = optionalText(payload.reason, 500) || "Borrador desaprobado durante la revision.";
  const updated = await patchRows(rest, "content_publications", `id=eq.${id}`, {
    status: "cancelled",
    scheduled_at: null,
    updated_by: profile.id,
    error_code: null,
    error_message: null,
  });
  await history(rest, publication, "content_rejected", reason, profile, requestId);
  return { publication: updated[0] || null };
}

async function schedulePublication(rest: RestClient, profile: Profile, payload: JsonRecord, requestId: string) {
  const id = requiredUuid(payload.publicationId, "publicacion");
  const scheduledAt = new Date(requiredText(payload.scheduledAt, "fecha programada", 80));
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) throw new HttpError(400, "Elige una fecha futura valida.");
  const rows = await selectRows(rest, `content_publications?select=id,status,product_id,correlation_id&id=eq.${id}&limit=1`);
  const publication = rows[0];
  if (!publication) throw new HttpError(404, "Publicacion no encontrada.");
  if (publication.status !== "approved") throw new HttpError(409, "La publicacion debe estar aprobada antes de programarla.");
  const updated = await patchRows(rest, "content_publications", `id=eq.${id}`, {
    status: "scheduled", scheduled_at: scheduledAt.toISOString(), updated_by: profile.id,
  });
  await history(rest, publication, "content_scheduled", `Publicacion programada para ${scheduledAt.toISOString()}.`, profile, requestId);
  return { publication: updated[0] || null };
}

async function publishPublication(rest: RestClient, profile: Profile, payload: JsonRecord, requestId: string) {
  const id = requiredUuid(payload.publicationId, "publicacion");
  const rows = await selectRows(rest, `content_publications?select=id,status,product_id,correlation_id&id=eq.${id}&limit=1`);
  const publication = rows[0];
  if (!publication) throw new HttpError(404, "Publicacion no encontrada.");
  if (!['approved', 'scheduled', 'failed'].includes(String(publication.status))) {
    throw new HttpError(409, "Aprueba el contenido antes de publicarlo.");
  }
  const jobKey = `publish:${id}`;
  const jobPayload = { publication_id: id, requested_by: profile.id };
  const existingJobs = await selectRows(
    rest,
    `content_jobs?select=id,status&idempotency_key=eq.${encodeURIComponent(jobKey)}&limit=1`,
  );
  const existingJob = existingJobs[0];
  if (existingJob && ["completed", "failed", "cancelled", "retry"].includes(String(existingJob.status))) {
    await patchRows(rest, "content_jobs", `id=eq.${existingJob.id}`, {
      status: "retry",
      payload: jobPayload,
      attempts: 0,
      next_attempt_at: new Date().toISOString(),
      worker_id: null,
      lease_token: null,
      lease_expires_at: null,
      result: null,
      error_code: null,
      error_message: null,
      started_at: null,
      completed_at: null,
    });
  } else if (!existingJob) await insertIgnoreRows(rest, "content_jobs", [{
    kind: "publish",
    publication_id: id,
    payload: jobPayload,
    priority: 100,
    idempotency_key: jobKey,
    correlation_id: publication.correlation_id || requestIdToUuid(requestId),
  }], "idempotency_key");
  await patchRows(rest, "content_publications", `id=eq.${id}`, {
    status: "scheduled", scheduled_at: new Date().toISOString(), updated_by: profile.id,
  });
  const processed = await runWorker(rest, 1, requestId);
  const refreshed = await selectRows(rest, `content_publications?select=*&id=eq.${id}&limit=1`);
  return { publication: refreshed[0] || null, worker: processed };
}

async function runWorker(rest: RestClient, limit: number, requestId: string) {
  await rpc(rest, "enqueue_due_content_publications", {});
  await enqueueDueSchedules(rest);
  await enqueueMetricJobs(rest);
  const workerId = `content-edge-${requestId.slice(0, 18)}`;
  const processed: JsonRecord[] = [];
  for (let index = 0; index < limit; index += 1) {
    const claimed = await rpc(rest, "claim_content_job", { p_worker_id: workerId, p_lease_seconds: 180 });
    const claim = Array.isArray(claimed) ? claimed[0] : null;
    if (!claim || !claim.job) break;
    const job = asObject(claim.job);
    const leaseToken = String(claim.lease_token || "");
    try {
      const result = await processJob(rest, job, requestId);
      await rpc(rest, "complete_content_job", {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_lease_token: leaseToken,
        p_result: result,
      });
      processed.push({ id: job.id, kind: job.kind, status: "completed", result });
    } catch (error) {
      const retryable = error instanceof SocialPublishError ? error.retryable : true;
      const code = error instanceof SocialPublishError ? error.code : "content_job_failed";
      const message = error instanceof Error ? error.message : "Error procesando trabajo.";
      await rpc(rest, "fail_content_job", {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_lease_token: leaseToken,
        p_error_code: code,
        p_error_message: message,
        p_retryable: retryable,
      });
      if (job.publication_id && job.kind === "publish") {
        await patchRows(rest, "content_publications", `id=eq.${job.publication_id}`, {
          status: retryable ? "scheduled" : "failed",
          error_code: code,
          error_message: message,
          retry_count: Number(job.attempts || 0),
        });
        await insertRows(rest, "content_history", [{
          publication_id: job.publication_id,
          job_id: job.id,
          event_type: "publish_failed",
          level: "error",
          message,
          metadata: { code, retryable, attempt: job.attempts },
          correlation_id: job.correlation_id || requestIdToUuid(requestId),
          actor_type: "worker",
          actor_id: workerId,
        }]);
      }
      if (job.publication_id && job.kind === "metrics_sync") {
        await insertRows(rest, "content_history", [{
          publication_id: job.publication_id,
          job_id: job.id,
          event_type: "metrics_sync_failed",
          level: "warning",
          message,
          metadata: { code, retryable, attempt: job.attempts },
          correlation_id: job.correlation_id || requestIdToUuid(requestId),
          actor_type: "worker",
          actor_id: workerId,
        }]);
      }
      processed.push({ id: job.id, kind: job.kind, status: retryable ? "retry" : "failed", error: message });
    }
  }
  return { processed, count: processed.length };
}

async function processJob(rest: RestClient, job: JsonRecord, requestId: string): Promise<JsonRecord> {
  if (job.kind === "catalog_sync") {
    const result = await rpc(rest, "sync_content_products_from_tiendanube", {});
    return { sync: Array.isArray(result) ? result[0] : result };
  }
  if (job.kind === "automation_tick") {
    return await processAutomationTick(rest, job, requestId);
  }
  if (job.kind === "metrics_sync") {
    return await processMetricsSync(rest, job, requestId);
  }
  if (job.kind !== "publish") {
    throw new SocialPublishError(`Trabajo ${job.kind} aun no tiene procesador.`, "unsupported_content_job", false, 422);
  }
  const publicationId = requiredUuid(job.publication_id, "publicacion del trabajo");
  const publications = await selectRows(rest, `content_publications?select=*&id=eq.${publicationId}&limit=1`);
  const publication = publications[0];
  if (!publication) throw new SocialPublishError("La publicacion ya no existe.", "publication_missing", false, 404);
  if (publication.status === "published" && publication.external_id) {
    return { idempotent: true, external_id: publication.external_id };
  }
  const channels = await selectRows(rest, `content_channels?select=*&id=eq.${publication.channel_id}&limit=1`);
  const channel = channels[0];
  if (!channel || !allowedChannels.has(String(channel.code) as SocialChannelCode)) {
    throw new SocialPublishError("Canal social invalido.", "invalid_social_channel", false, 422);
  }
  const products = publication.product_id
    ? await selectRows(rest, `content_products?select=product_url&id=eq.${publication.product_id}&limit=1`)
    : [];
  await patchRows(rest, "content_publications", `id=eq.${publicationId}`, {
    status: "publishing", error_code: null, error_message: null,
  });
  const adapter = createSocialAdapter(String(channel.code) as SocialChannelCode);
  const connection = await adapter.validateConnection();
  if (!connection.connected) {
    throw new SocialPublishError(connection.message, "meta_social_not_connected", false, 409);
  }
  const result = await adapter.createPost({
    body: String(publication.body || ""),
    cta: String(publication.cta || "") || null,
    hashtags: stringArray(publication.hashtags, 30),
    imageUrl: String(publication.image_url || "") || null,
    productUrl: String(products[0]?.product_url || "") || null,
    idempotencyKey: String(publication.idempotency_key || `publish:${publicationId}`),
  });
  const now = new Date().toISOString();
  await patchRows(rest, "content_publications", `id=eq.${publicationId}`, {
    status: "published",
    published_at: now,
    external_id: result.externalId,
    external_url: result.externalUrl || null,
    error_code: null,
    error_message: null,
  });
  await insertRows(rest, "content_history", [{
    publication_id: publicationId,
    product_id: publication.product_id || null,
    job_id: job.id,
    event_type: "content_published",
    message: `Publicacion confirmada por ${channel.name || channel.code}.`,
    metadata: { external_id: result.externalId, channel: channel.code },
    correlation_id: job.correlation_id || requestIdToUuid(requestId),
    actor_type: "worker",
    actor_id: String(job.worker_id || "content-edge"),
  }]);
  return { external_id: result.externalId, channel: channel.code, published_at: now };
}

async function enqueueDueSchedules(rest: RestClient) {
  const due = await selectRows(
    rest,
    `content_schedules?select=*&active=eq.true&next_run_at=lte.${encodeURIComponent(new Date().toISOString())}&order=next_run_at.asc&limit=50`,
  );
  if (!due.length) return 0;
  await insertIgnoreRows(rest, "content_jobs", due.map((schedule) => ({
    kind: "automation_tick",
    schedule_id: schedule.id,
    payload: { schedule_id: schedule.id, due_at: schedule.next_run_at },
    priority: 80,
    idempotency_key: `schedule:${schedule.id}:${schedule.next_run_at}`,
    correlation_id: crypto.randomUUID(),
  })), "idempotency_key");
  return due.length;
}

async function enqueueMetricJobs(rest: RestClient) {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const published = await selectRows(
    rest,
    `content_publications?select=id,correlation_id&status=eq.published&external_id=not.is.null&published_at=gte.${encodeURIComponent(since)}&limit=500`,
  );
  if (!published.length) return 0;
  const dayKey = new Date().toISOString().slice(0, 10);
  await insertIgnoreRows(rest, "content_jobs", published.map((publication) => ({
    kind: "metrics_sync",
    publication_id: publication.id,
    payload: { publication_id: publication.id, observed_day: dayKey },
    priority: 20,
    max_attempts: 3,
    idempotency_key: `metrics:${publication.id}:${dayKey}`,
    correlation_id: publication.correlation_id || crypto.randomUUID(),
  })), "idempotency_key");
  return published.length;
}

async function processMetricsSync(rest: RestClient, job: JsonRecord, requestId: string): Promise<JsonRecord> {
  const publicationId = requiredUuid(job.publication_id, "publicacion de metricas");
  const publications = await selectRows(
    rest,
    `content_publications?select=id,status,external_id,channel_id,product_id,correlation_id&id=eq.${publicationId}&limit=1`,
  );
  const publication = publications[0];
  if (!publication || publication.status !== "published" || !publication.external_id) {
    return { skipped: true, reason: "publication_not_published" };
  }
  const channels = await selectRows(rest, `content_channels?select=code,name&id=eq.${publication.channel_id}&limit=1`);
  const channel = channels[0];
  if (!channel || !allowedChannels.has(String(channel.code) as SocialChannelCode)) {
    throw new SocialPublishError("Canal inválido para consultar métricas.", "invalid_metrics_channel", false, 422);
  }
  const adapter = createSocialAdapter(String(channel.code) as SocialChannelCode);
  const metrics = await adapter.getMetrics(String(publication.external_id));
  const interactions = Number(metrics.likes || 0) + Number(metrics.comments || 0) + Number(metrics.shares || 0) + Number(metrics.saves || 0);
  const denominator = Number(metrics.reach || metrics.impressions || 0);
  const observedAt = new Date().toISOString();
  await insertRows(rest, "content_metrics", [{
    publication_id: publicationId,
    observed_at: observedAt,
    impressions: metrics.impressions ?? null,
    reach: metrics.reach ?? null,
    likes: metrics.likes ?? null,
    comments: metrics.comments ?? null,
    shares: metrics.shares ?? null,
    saves: metrics.saves ?? null,
    clicks: metrics.clicks ?? null,
    engagement_rate: denominator ? Math.round((interactions / denominator) * 10000) / 100 : null,
    raw_metrics: metrics.raw,
  }]);
  await insertRows(rest, "content_history", [{
    publication_id: publicationId,
    product_id: publication.product_id || null,
    job_id: job.id,
    event_type: "metrics_synced",
    level: "info",
    message: `Métricas actualizadas desde ${channel.name || channel.code}.`,
    metadata: { observed_at: observedAt, likes: metrics.likes || 0, comments: metrics.comments || 0 },
    correlation_id: publication.correlation_id || requestIdToUuid(requestId),
    actor_type: "worker",
    actor_id: String(job.worker_id || "content-metrics"),
  }]);
  return { publication_id: publicationId, observed_at: observedAt, channel: channel.code };
}

async function processAutomationTick(rest: RestClient, job: JsonRecord, requestId: string): Promise<JsonRecord> {
  const scheduleId = requiredUuid(job.schedule_id, "regla editorial");
  const scheduleRows = await selectRows(rest, `content_schedules?select=*&id=eq.${scheduleId}&limit=1`);
  const schedule = scheduleRows[0];
  if (!schedule || schedule.active !== true) return { skipped: true, reason: "schedule_inactive" };
  if (schedule.paused_until && Date.parse(String(schedule.paused_until)) > Date.now()) {
    return { skipped: true, reason: "schedule_paused" };
  }

  const channelIds = stringArray(schedule.channel_ids, 10);
  const [channels, rules, products, publications, templates, brands] = await Promise.all([
    selectRows(rest, `content_channels?select=*&id=in.(${channelIds.join(",")})`),
    selectRows(rest, `content_automation_rules?select=*&channel_id=in.(${channelIds.join(",")})`),
    selectRows(rest, "content_products?select=*&source_status=eq.active&sync_status=eq.synced&paused=eq.false&limit=1000"),
    selectRows(rest, "content_publications?select=id,product_id,channel_id,body,hashtags,status,created_at,published_at,scheduled_at&order=created_at.desc&limit=2000"),
    selectRows(rest, "content_templates?select=*&active=eq.true&order=system_template.desc,name.asc&limit=100"),
    selectRows(rest, "brand_profiles?select=*&is_default=eq.true&active=eq.true&limit=1"),
  ]);
  const activeChannels = channels.filter((channel) => channel.enabled === true);
  if (!activeChannels.length) throw new SocialPublishError("No hay canales sociales conectados para esta regla.", "schedule_channels_not_connected", false, 409);
  const ruleMap = new Map(rules.map((rule) => [String(rule.channel_id), rule]));
  const strictStock = activeChannels.some((channel) => ruleMap.get(String(channel.id))?.require_stock !== false);
  const strictImage = activeChannels.some((channel) => ruleMap.get(String(channel.id))?.require_image !== false);
  const eligible = products.filter((product) => {
    if (strictStock && product.has_stock !== true) return false;
    if (strictImage && !product.primary_image_url) return false;
    return matchesProductFilter(product, asObject(schedule.product_filter));
  });
  if (!eligible.length) throw new SocialPublishError("No hay productos elegibles para la regla editorial.", "no_eligible_products", false, 422);

  const selected = selectRotatedProduct(eligible, publications, activeChannels, ruleMap);
  if (!selected) throw new HttpError(422, "No se pudo seleccionar un producto para rotación.");
  const socialChannels = activeChannels
    .map((channel) => String(channel.code))
    .filter((code): code is SocialChannelCode => allowedChannels.has(code as SocialChannelCode));
  const facts = buildProductFacts(selected);
  const similarityGapDays = Math.max(...activeChannels.map((channel) => Number(ruleMap.get(String(channel.id))?.min_text_similarity_gap_days || 30)), 30);
  const recentCutoff = Date.now() - similarityGapDays * 86_400_000;
  const recent = publications
    .filter((publication) => Date.parse(String(publication.created_at || 0)) >= recentCutoff)
    .slice(0, 40);
  const template = templates.find((item) => item.slug === "producto-destacado") || templates[0] || null;
  const generation = await createGroundedVariants({
    facts,
    channels: socialChannels,
    variantCount: 1,
    template,
    brand: brands[0] || null,
    objective: "Mantener una presencia editorial variada y útil con productos disponibles.",
    cta: "Conoce más en climactiva.cl",
    publicationType: "feed",
    context: `Ejecución automática de la regla ${schedule.name}.`,
    useHashtags: true,
    recent,
  });
  const repeated = findSimilarDraft(generation.variants, recent, 0.74);
  if (repeated) {
    throw new HttpError(422, `La rotación detectó una estructura reciente demasiado similar (${Math.round(repeated.similarity * 100)}%).`);
  }
  const numericIssues = generation.variants.flatMap((variant) => unsupportedNumbers(`${variant.body} ${variant.cta}`, JSON.stringify(facts)));
  if (numericIssues.length) throw new HttpError(422, `La generación automática incluyó cifras no verificadas: ${numericIssues.join(", ")}.`);
  const verification = await verifyGrounding(facts, generation.variants);
  if (!verification.valid) throw new HttpError(422, `La generación automática no superó la revisión factual: ${verification.unsupportedClaims.join("; ")}.`);

  const groupId = crypto.randomUUID();
  const automatic = schedule.operation_mode === "autopilot";
  const channelMap = new Map(activeChannels.map((channel) => [String(channel.code), channel]));
  const channelsById = new Map(activeChannels.map((channel) => [String(channel.id), channel]));
  const rows: JsonRecord[] = [];
  for (const variant of generation.variants) {
    const channel = channelMap.get(variant.channel);
    if (!channel) continue;
    const brandedCta = ensureOfficialWebsiteCta(variant.cta);
    const brandedHashtags = ensureBrandHashtag(variant.hashtags);
    rows.push({
      generation_group_id: groupId,
      product_id: selected.id,
      channel_id: channel.id,
      template_id: template?.id || null,
      brand_profile_id: brands[0]?.id || null,
      publication_type: "feed",
      objective: "Rotación editorial automática",
      cta: brandedCta,
      body: variant.body,
      hashtags: brandedHashtags,
      image_url: selected.primary_image_url,
      source_facts: facts,
      missing_facts: [],
      content_fingerprint: await sha256(`${variant.channel}|${normalizeForFingerprint(variant.body)}`),
      model_name: generation.model,
      generator_type: "autopilot",
      generator_id: `schedule:${scheduleId}`,
      operation_mode: automatic ? "autopilot" : "approval",
      status: automatic ? "scheduled" : "pending_approval",
      scheduled_at: automatic ? new Date().toISOString() : null,
      correlation_id: job.correlation_id || requestIdToUuid(requestId),
    });
  }
  const inserted = await insertRows(rest, "content_publications", rows);
  if (automatic) {
    await insertIgnoreRows(rest, "content_jobs", inserted.map((publication) => ({
      kind: "publish",
      publication_id: publication.id,
      payload: { publication_id: publication.id, source: "autopilot" },
      priority: 90,
      idempotency_key: `publish:${publication.id}`,
      correlation_id: publication.correlation_id,
    })), "idempotency_key");
  }
  await insertRows(rest, "content_history", inserted.map((publication) => ({
    publication_id: publication.id,
    product_id: selected.id,
    job_id: job.id,
    event_type: automatic ? "autopilot_scheduled" : "autopilot_draft_created",
    message: automatic
      ? `Piloto automático seleccionó ${selected.name} y programó ${channelsById.get(String(publication.channel_id))?.name || "un canal"}.`
      : `La regla editorial preparó ${selected.name} para aprobación.`,
    metadata: { schedule_id: scheduleId, product_score: selected._rotation_score, model: generation.model },
    correlation_id: job.correlation_id || requestIdToUuid(requestId),
    actor_type: "worker",
    actor_id: String(job.worker_id || "content-scheduler"),
  })));

  const nextRun = nextScheduleAt(schedule, new Date());
  await patchRows(rest, "content_schedules", `id=eq.${scheduleId}`, {
    last_run_at: new Date().toISOString(),
    next_run_at: nextRun?.toISOString() || null,
    active: Boolean(nextRun),
  });
  return {
    schedule_id: scheduleId,
    product_id: selected.id,
    product_name: selected.name,
    publications: inserted.map((row) => row.id),
    mode: automatic ? "autopilot" : "approval",
    next_run_at: nextRun?.toISOString() || null,
  };
}

function matchesProductFilter(product: JsonRecord, filter: JsonRecord) {
  const categories = stringArray(filter.categories, 100);
  const brands = stringArray(filter.brands, 100);
  const productIds = stringArray(filter.product_ids, 500);
  if (categories.length && !categories.includes(String(product.category || ""))) return false;
  if (brands.length && !brands.includes(String(product.brand || ""))) return false;
  if (productIds.length && !productIds.includes(String(product.id || ""))) return false;
  return true;
}

type GenerationContext = {
  facts: JsonRecord;
  channels: SocialChannelCode[];
  variantCount: number;
  template: JsonRecord | null;
  brand: JsonRecord | null;
  objective: string;
  cta: string;
  publicationType: string;
  context: string;
  useHashtags: boolean;
  recent: JsonRecord[];
};

type GeneratedVariant = {
  channel: SocialChannelCode;
  body: string;
  hashtags: string[];
  cta: string;
  factKeysUsed: string[];
};

async function createGroundedVariants(context: GenerationContext) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["variants"],
    properties: {
      variants: {
        type: "array",
        minItems: context.channels.length * context.variantCount,
        maxItems: context.channels.length * context.variantCount,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["channel", "body", "hashtags", "cta", "fact_keys_used"],
          properties: {
            channel: { type: "string", enum: context.channels },
            body: { type: "string", minLength: 20, maxLength: 2200 },
            hashtags: { type: "array", maxItems: 30, items: { type: "string", maxLength: 80 } },
            cta: { type: "string", maxLength: 300 },
            fact_keys_used: { type: "array", items: { type: "string", maxLength: 80 } },
          },
        },
      },
    },
  };
  const prompt = {
    task: "Genera contenido social en espanol de Chile usando exclusivamente los hechos autorizados.",
    absolute_rules: [
      "No inventes precios, stock, descuentos, medidas, capacidades, beneficios ni especificaciones.",
      "Puedes resumir o reescribir, pero cada afirmacion factual debe estar respaldada por product_facts.",
      "Si un dato no aparece, omitelo. Nunca rellenes vacios con conocimiento general.",
      "Instagram y Facebook deben tener redacciones propias, no copias identicas.",
      "No incluyas marcadores como [dato faltante].",
      "Incluye ClimaActiva como hashtag de marca y dirige la llamada a la accion a https://climactiva.cl.",
    ],
    product_facts: context.facts,
    brand_profile: context.brand,
    template: context.template,
    request: {
      channels: context.channels,
      variants_per_channel: context.variantCount,
      objective: context.objective,
      requested_cta: context.cta,
      publication_type: context.publicationType,
      campaign_context: context.context,
      use_hashtags: context.useHashtags,
    },
    recent_content_to_avoid: context.recent.map((row) => ({ body: row.body, hashtags: row.hashtags })),
  };
  const result = await callOpenAiJson("grounded_social_content", schema, prompt, 2200);
  const parsed = asObject(result.data);
  const variants = Array.isArray(parsed.variants) ? parsed.variants : [];
  return {
    model: result.model,
    variants: variants.map((item): GeneratedVariant => {
      const row = asObject(item);
      const channel = String(row.channel) as SocialChannelCode;
      if (!allowedChannels.has(channel) || !context.channels.includes(channel)) {
        throw new HttpError(502, "La IA devolvio un canal no solicitado.");
      }
      return {
        channel,
        body: requiredText(row.body, "texto generado", 2200),
        hashtags: context.useHashtags ? normalizeHashtags(row.hashtags) : [],
        cta: optionalText(row.cta, 300),
        factKeysUsed: stringArray(row.fact_keys_used, 30),
      };
    }),
  };
}

async function verifyGrounding(facts: JsonRecord, variants: GeneratedVariant[]) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["valid", "unsupported_claims"],
    properties: {
      valid: { type: "boolean" },
      unsupported_claims: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } },
    },
  };
  const result = await callOpenAiJson("verify_social_grounding", schema, {
    task: "Audita cada afirmacion factual. Marca invalido si alguna no esta explicitamente respaldada.",
    product_facts: facts,
    drafts: variants,
  }, 700);
  const data = asObject(result.data);
  return {
    valid: data.valid === true,
    unsupportedClaims: stringArray(data.unsupported_claims, 20),
  };
}

async function callOpenAiJson(name: string, schema: JsonRecord, input: JsonRecord, maxTokens: number) {
  const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim();
  if (!apiKey) throw new HttpError(503, "Falta configurar OPENAI_API_KEY en la Edge Function.");
  const model = Deno.env.get("OPENAI_CONTENT_MODEL")?.trim()
    || Deno.env.get("OPENAI_TEXT_MODEL")?.trim()
    || "gpt-4.1-mini";
  const timeoutMs = clampNumber(Deno.env.get("OPENAI_REQUEST_TIMEOUT_MS"), 10_000, 120_000, 45_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: "Eres un editor de marketing estricto. La fuente entregada es el unico conocimiento permitido sobre el producto." },
          { role: "user", content: JSON.stringify(input) },
        ],
        max_output_tokens: maxTokens,
        store: false,
        text: { format: { type: "json_schema", name, strict: true, schema } },
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as JsonRecord;
    if (!response.ok) {
      const apiError = payload.error && typeof payload.error === "object" ? payload.error as JsonRecord : {};
      throw new HttpError(response.status, String(apiError.message || "OpenAI rechazo la solicitud."));
    }
    const outputText = extractOutputText(payload);
    if (!outputText) throw new HttpError(502, "OpenAI no devolvio contenido estructurado.");
    return { model, data: JSON.parse(outputText) as JsonRecord };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new HttpError(504, "La generacion excedio el tiempo disponible.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractOutputText(payload: JsonRecord) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const row = asObject(item);
    const content = Array.isArray(row.content) ? row.content : [];
    for (const part of content) {
      const block = asObject(part);
      if (block.type === "output_text" && typeof block.text === "string") return block.text;
    }
  }
  return "";
}

function buildProductFacts(product: JsonRecord): JsonRecord {
  return {
    product_id: product.id,
    source: "tiendanube",
    source_external_id: product.external_id,
    source_updated_at: product.source_updated_at,
    name: product.name,
    sku: product.sku,
    description: String(product.description_text || "").slice(0, 9000),
    category: product.category,
    brand: product.brand,
    price_clp: product.price,
    promotional_price_clp: product.promotional_price,
    stock: product.stock,
    has_stock: product.has_stock,
    product_url: product.product_url,
    image_url: product.primary_image_url,
  };
}

async function history(
  rest: RestClient,
  publication: JsonRecord,
  eventType: string,
  message: string,
  profile: Profile,
  requestId: string,
) {
  await insertRows(rest, "content_history", [{
    publication_id: publication.id,
    product_id: publication.product_id || null,
    event_type: eventType,
    message,
    correlation_id: publication.correlation_id || requestIdToUuid(requestId),
    actor_type: "user",
    actor_id: profile.id,
  }]);
}

async function authenticateRequest(req: Request, rest: RestClient) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Debes iniciar sesion.");
  const response = await fetch(`${rest.url}/auth/v1/user`, {
    headers: { apikey: rest.anonKey, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new HttpError(401, "Sesion invalida o expirada.");
  const user = await response.json() as JsonRecord;
  const id = String(user.id || "");
  if (!id) throw new HttpError(401, "Sesion sin usuario valido.");
  return { id, email: String(user.email || "") };
}

async function getProfile(rest: RestClient, userId: string): Promise<Profile | null> {
  const rows = await selectRows(rest, `profiles?select=id,full_name,role,active&id=eq.${userId}&limit=1`);
  const row = rows[0];
  if (!row) return null;
  const role = String(row.role || "visualizador") as AppRole;
  return {
    id: String(row.id),
    fullName: String(row.full_name || ""),
    role: role in permissionsByRole ? role : "visualizador",
    active: row.active !== false,
  };
}

function requirePermission(profile: Profile, permission: string) {
  if (!permissionsByRole[profile.role].has(permission)) {
    throw new HttpError(403, "No tienes permiso para realizar esta accion.");
  }
}

function requireWorker(req: Request, rest: RestClient) {
  const configured = Deno.env.get("CONTENT_SCHEDULER_SECRET")?.trim();
  const supplied = req.headers.get("x-content-scheduler-secret")?.trim();
  const authorization = req.headers.get("authorization") || "";
  if (configured && supplied === configured) return;
  if (authorization === `Bearer ${rest.serviceRoleKey}`) return;
  throw new HttpError(401, "Credencial del scheduler invalida.");
}

async function selectRows(rest: RestClient, path: string): Promise<JsonRecord[]> {
  const response = await fetch(`${rest.url}/rest/v1/${path}`, { headers: serviceHeaders(rest) });
  if (!response.ok) {
    const text = await response.text();
    throw new HttpError(response.status, `Error leyendo datos del Centro de Contenido: ${text.slice(0, 300)}`);
  }
  return await response.json() as JsonRecord[];
}

async function insertRows(rest: RestClient, table: string, rows: JsonRecord[]) {
  if (!rows.length) return [];
  const response = await fetch(`${rest.url}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...serviceHeaders(rest), "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(rows),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new HttpError(response.status, `Error guardando ${table}: ${text.slice(0, 300)}`);
  }
  return await response.json() as JsonRecord[];
}

async function insertIgnoreRows(rest: RestClient, table: string, rows: JsonRecord[], onConflict: string) {
  if (!rows.length) return [];
  const response = await fetch(`${rest.url}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: "POST",
    headers: {
      ...serviceHeaders(rest),
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new HttpError(response.status, `Error encolando ${table}: ${text.slice(0, 300)}`);
  }
  return await response.json() as JsonRecord[];
}

async function patchRows(rest: RestClient, table: string, filter: string, row: JsonRecord) {
  const response = await fetch(`${rest.url}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(rest), "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new HttpError(response.status, `Error actualizando ${table}: ${text.slice(0, 300)}`);
  }
  return await response.json() as JsonRecord[];
}

async function rpc(rest: RestClient, fn: string, body: JsonRecord) {
  const response = await fetch(`${rest.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...serviceHeaders(rest), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const details = data && typeof data === "object" ? String((data as JsonRecord).message || "") : "";
    throw new HttpError(response.status, details || `No se pudo ejecutar ${fn}.`);
  }
  return data;
}

function serviceHeaders(rest: RestClient) {
  return { apikey: rest.serviceRoleKey, Authorization: `Bearer ${rest.serviceRoleKey}` };
}

function getRestClient(): RestClient {
  const url = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() || "";
  if (!url || !anonKey || !serviceRoleKey) {
    throw new HttpError(500, "Faltan variables internas de Supabase en la Edge Function.");
  }
  return { url, anonKey, serviceRoleKey };
}

function corsHeaders(req: Request) {
  const appOrigin = Deno.env.get("CRM_APP_URL")?.trim() || "http://localhost:5173";
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = origin === appOrigin || origin === new URL(appOrigin).origin ? origin : new URL(appOrigin).origin;
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-content-scheduler-secret, x-request-id",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  };
}

function json(data: unknown, status: number, req: Request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8" },
  });
}

async function readJson(req: Request, allowEmpty = false): Promise<JsonRecord> {
  const size = Number(req.headers.get("content-length") || 0);
  if (size > maxJsonBodyBytes) throw new HttpError(413, "Solicitud demasiado grande.");
  const payload = await req.json().catch(() => allowEmpty ? {} : null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new HttpError(400, "El cuerpo debe ser JSON.");
  return payload as JsonRecord;
}

function getRoute(rawUrl: string) {
  const parts = new URL(rawUrl).pathname.split("/").filter(Boolean);
  const index = parts.lastIndexOf("content-center");
  return (index >= 0 ? parts.slice(index + 1) : parts.slice(-1)).join("/") || "bootstrap";
}

function asObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function requiredText(value: unknown, label: string, maxLength: number) {
  const text = String(value || "").trim();
  if (!text) throw new HttpError(400, `Falta ${label}.`);
  if (text.length > maxLength) throw new HttpError(400, `${label} supera el largo permitido.`);
  return text;
}

function optionalText(value: unknown, maxLength: number) {
  return String(value || "").trim().slice(0, maxLength);
}

function requiredUuid(value: unknown, label: string) {
  const text = requiredText(value, label, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new HttpError(400, `${label} no es valido.`);
  }
  return text;
}

function optionalUuid(value: unknown) {
  const text = String(value || "").trim();
  return text ? requiredUuid(text, "identificador") : "";
}

function stringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeHashtags(value: unknown) {
  return [...new Set(stringArray(value, 30)
    .map((tag) => tag.replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter(Boolean))];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const text = String(value || "") as T;
  return allowed.includes(text) ? text : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function unsupportedNumbers(content: string, source: string) {
  const numbers = content.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
  const compactSource = source.replace(/\s+/g, " ");
  return [...new Set(numbers.filter((number) => !compactSource.includes(number)))];
}

function normalizeForFingerprint(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function channelCodeById(channels: JsonRecord[], id: string) {
  return String(channels.find((row) => row.id === id)?.code || "canal social");
}

function requestIdToUuid(requestId: string) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return requestId;
  return crypto.randomUUID();
}

function isWithinPastDays(value: unknown, days: number) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) && time >= Date.now() - days * 24 * 60 * 60 * 1000 && time <= Date.now();
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
