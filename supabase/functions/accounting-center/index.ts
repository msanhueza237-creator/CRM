import { parseBankWorkbook } from "./bank-parsers.ts";

type JsonRecord = Record<string, unknown>;
type AppRole = "administrador" | "finanzas" | "vendedor" | "visualizador";
type Profile = { id: string; role: AppRole; active: boolean; full_name: string };
type RestClient = { url: string; anonKey: string; serviceRoleKey: string };

const rolePermissions: Record<AppRole, Set<string>> = {
  administrador: new Set(["view","import","reconcile","entry","post","close","config","profitability","audit"]),
  finanzas: new Set(["view","import","reconcile","entry","post","profitability","audit"]),
  vendedor: new Set(),
  visualizador: new Set(),
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  const requestId = request.headers.get("x-request-id")?.slice(0, 100) || crypto.randomUUID();
  try {
    const rest = getRestClient();
    const route = routeFrom(request.url);
    if (route === "health") return json({ ok: true, service: "accounting-center", requestId }, 200, request);

    const user = await authenticate(request, rest);
    const profile = await getProfile(rest, user.id);
    if (!profile?.active) throw new HttpError(403, "Tu usuario no está activo en el CRM.");

    if (route === "bootstrap" && request.method === "GET") {
      requirePermission(profile, "view");
      return json(await bootstrap(rest, profile), 200, request);
    }
    if (route === "facto/sync" && request.method === "POST") {
      requirePermission(profile, "import");
      return json(await syncFacto(rest, profile, requestId, await readJson(request)), 200, request);
    }
    if (route === "foreign-trade/sync" && request.method === "POST") {
      requirePermission(profile, "import");
      return json(await syncForeignTrade(rest, profile, requestId), 200, request);
    }
    if (route === "accounts/create" && request.method === "POST") {
      requirePermission(profile, "config");
      return json(await createAccount(rest, profile, await readJson(request), requestId), 201, request);
    }
    if (route === "imports/preview" && request.method === "POST") {
      requirePermission(profile, "import");
      return json(await previewImport(rest, profile, await readJson(request)), 201, request);
    }
    if (route === "imports/confirm" && request.method === "POST") {
      requirePermission(profile, "import");
      return json(await confirmImport(rest, profile, await readJson(request)), 200, request);
    }
    if (route === "reconciliation/propose" && request.method === "POST") {
      requirePermission(profile, "reconcile");
      return json(await proposeReconciliation(rest, await readJson(request)), 200, request);
    }
    if (route === "reconciliation/confirm" && request.method === "POST") {
      requirePermission(profile, "reconcile");
      return json(await confirmReconciliation(rest, profile, await readJson(request)), 200, request);
    }
    if (route === "checks/create" && request.method === "POST") {
      requirePermission(profile, "entry");
      return json(await createCheck(rest, profile, await readJson(request)), 201, request);
    }
    if (route === "entries/create" && request.method === "POST") {
      requirePermission(profile, "entry");
      const payload = await readJson(request);
      return json({ id: await rpc(rest, "accounting_create_journal_entry", {
        p_payload: payload,
        p_actor_id: profile.id,
      }) }, 201, request);
    }
    if (route === "entries/post" && request.method === "POST") {
      requirePermission(profile, "post");
      const payload = await readJson(request);
      return json({ id: await rpc(rest, "accounting_post_journal_entry", { p_entry_id: requiredUuid(payload.entryId) }) }, 200, request);
    }
    if (route === "entries/reverse" && request.method === "POST") {
      requirePermission(profile, "post");
      const payload = await readJson(request);
      return json({ id: await rpc(rest, "accounting_reverse_journal_entry", {
        p_entry_id: requiredUuid(payload.entryId),
        p_reversal_date: requiredDate(payload.date),
        p_reason: requiredText(payload.reason, 500),
      }) }, 200, request);
    }
    if (route === "periods/close" && request.method === "POST") {
      requirePermission(profile, "close");
      const payload = await readJson(request);
      return json({ id: await rpc(rest, "accounting_close_period", {
        p_period_id: requiredUuid(payload.periodId), p_note: optionalText(payload.note, 500) || null,
      }) }, 200, request);
    }
    if (route === "controls/refresh" && request.method === "POST") {
      requirePermission(profile, "view");
      const payload = await readJson(request);
      return json({ count: await rpc(rest, "accounting_refresh_controls", { p_entity_id: requiredUuid(payload.entityId) }) }, 200, request);
    }
    if (route === "reports" && request.method === "GET") {
      requirePermission(profile, "view");
      return json(await report(rest, new URL(request.url)), 200, request);
    }
    throw new HttpError(404, "Ruta no encontrada.");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Error inesperado.";
    console.error("[accounting-center] request failed", { requestId, status, message });
    return json({ error: message, requestId }, status, request);
  }
});

async function bootstrap(rest: RestClient, profile: Profile) {
  const entities = await selectRows(rest, "accounting_entities?select=*&active=eq.true&order=created_at.asc&limit=10");
  const entity = entities[0];
  if (!entity) throw new HttpError(409, "Falta aplicar la migración accounting_center.sql.");
  const entityId = String(entity.id);
  const [accounts, periods, bankAccounts, bankTransactions, sources, entries, receivables, payables, checks, controls, batches, factoSyncRuns] = await Promise.all([
    selectRows(rest, `accounting_accounts?select=*&entity_id=eq.${entityId}&order=code.asc`),
    selectRows(rest, `accounting_periods?select=*&entity_id=eq.${entityId}&order=starts_on.desc&limit=48`),
    selectRows(rest, `accounting_bank_accounts?select=*&entity_id=eq.${entityId}&order=institution.asc`),
    selectRows(rest, `accounting_bank_transactions?select=*&entity_id=eq.${entityId}&order=transaction_date.desc&limit=250`),
    selectRows(rest, `accounting_source_documents?select=*&entity_id=eq.${entityId}&order=issued_on.desc.nullslast&limit=250`),
    selectRows(rest, `accounting_journal_entries?select=*&entity_id=eq.${entityId}&order=entry_date.desc,entry_number.desc&limit=250`),
    selectRows(rest, `accounting_receivables?select=*&entity_id=eq.${entityId}&order=due_on.asc.nullslast&limit=500`),
    selectRows(rest, `accounting_payables?select=*&entity_id=eq.${entityId}&order=due_on.asc.nullslast&limit=500`),
    selectRows(rest, `accounting_checks?select=*&entity_id=eq.${entityId}&order=due_on.asc.nullslast&limit=500`),
    selectRows(rest, `accounting_control_findings?select=*&entity_id=eq.${entityId}&status=eq.open&order=severity.asc,detected_at.desc&limit=250`),
    selectRows(rest, `accounting_import_batches?select=*&entity_id=eq.${entityId}&order=created_at.desc&limit=50`),
    selectRows(rest, `accounting_facto_sync_runs?select=*&entity_id=eq.${entityId}&order=created_at.desc&limit=24`),
  ]);
  const summary = await rpc(rest, "accounting_dashboard_summary", { p_entity_id: entityId, p_as_of: new Date().toISOString().slice(0, 10) });
  return {
    entity, accounts, periods, bankAccounts, bankTransactions, sources, entries,
    receivables, payables, checks, controls, batches, factoSyncRuns, summary,
    profile: { role: profile.role, permissions: [...rolePermissions[profile.role]] },
  };
}

async function createAccount(rest: RestClient, profile: Profile, payload: JsonRecord, requestId: string) {
  const entityId = requiredUuid(payload.entityId);
  const code = requiredText(payload.code, 40).toUpperCase();
  const name = requiredText(payload.name, 160);
  const accountType = requiredText(payload.accountType, 20);
  const classification = requiredText(payload.classification, 80).toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  const parentId = optionalText(payload.parentId, 80);
  const currency = optionalText(payload.currency, 3).toUpperCase() || null;
  const accountTypes = new Set(["asset", "liability", "equity", "income", "cost", "expense", "result"]);
  if (!/^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/.test(code)) throw new HttpError(400, "El código de cuenta contiene caracteres no permitidos.");
  if (!accountTypes.has(accountType)) throw new HttpError(400, "Tipo de cuenta inválido.");
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, "Moneda inválida.");
  const duplicate = await selectRows(rest, `accounting_accounts?select=id&entity_id=eq.${entityId}&code=eq.${encodeURIComponent(code)}&limit=1`);
  if (duplicate.length) throw new HttpError(409, "Ya existe una cuenta con ese código.");
  let level = 1;
  if (parentId) {
    const parents = await selectRows(rest, `accounting_accounts?select=id,level&entity_id=eq.${entityId}&id=eq.${requiredUuid(parentId)}&limit=1`);
    if (!parents[0]) throw new HttpError(400, "La cuenta padre no pertenece a esta empresa.");
    level = Math.min(Number(parents[0].level || 0) + 1, 12);
  }
  const normalBalance = accountType === "asset" || accountType === "cost" || accountType === "expense" ? "debit" : "credit";
  const inserted = await insertRows(rest, "accounting_accounts", [{
    entity_id: entityId,
    code,
    name,
    parent_id: parentId || null,
    level,
    account_type: accountType,
    normal_balance: normalBalance,
    currency,
    classification,
    allows_posting: payload.allowsPosting !== false,
    active: true,
    source_type: "MANUAL",
    metadata: { created_from: "accounting-center" },
  }]);
  const account = inserted[0];
  await insertRows(rest, "accounting_audit_events", [{
    entity_id: entityId,
    actor_id: profile.id,
    action: "account.created",
    entity_type: "accounting_account",
    entity_id_text: String(account.id),
    correlation_id: requestIdToUuid(requestId),
    new_value: { code, name, account_type: accountType, classification, parent_id: parentId || null },
  }]);
  return { id: String(account.id) };
}

async function syncFacto(rest: RestClient, profile: Profile, requestId: string, payload: JsonRecord) {
  const entity = (await selectRows(rest, "accounting_entities?select=id&active=eq.true&order=created_at.asc&limit=1"))[0];
  if (!entity) throw new HttpError(409, "Falta aplicar la migración contable.");
  const entityId = String(entity.id);
  const fromDate = requiredDate(payload.fromDate);
  const toDate = requiredDate(payload.toDate);
  if (fromDate > toDate) throw new HttpError(400, "La fecha inicial no puede ser posterior a la fecha final.");
  const resources = ["documents", "purchase_documents", "document_details", "purchase_document_details"];
  const run = (await insertRows(rest, "accounting_facto_sync_runs", [{
    entity_id: entityId,
    from_date: fromDate,
    to_date: toDate,
    status: "running",
    requested_by: profile.id,
    summary: { request_id: requestId, source: "integration_records/facto", accounting_policy: "document_only" },
  }]))[0];
  const runId = String(run.id);

  try {
    const records = await selectAllRows(rest,
      `integration_records?select=id,resource,external_id,payload,observed_at,updated_at&provider=eq.facto&resource=in.(${resources.join(",")})&order=updated_at.asc`,
    );
    const prepared = records.map((record) => {
      const resource = String(record.resource);
      const purchase = resource.includes("purchase");
      const externalId = String(record.external_id || record.id);
      const normalized = normalizeFactoDocument(asObject(record.payload), purchase, externalId);
      return {
        record,
        resource,
        purchase,
        externalId,
        normalized,
        canonicalKey: `facto:${purchase ? "purchase" : "sale"}:${externalId}`,
      };
    });
    const selectedByKey = new Map<string, typeof prepared[number]>();
    for (const item of prepared) {
      const selected = selectedByKey.get(item.canonicalKey);
      const itemScore = (item.resource.includes("details") ? 2 : 0) + (item.record.payload ? 1 : 0);
      const selectedScore = selected ? (selected.resource.includes("details") ? 2 : 0) + (selected.record.payload ? 1 : 0) : -1;
      if (!selected || itemScore >= selectedScore) selectedByKey.set(item.canonicalKey, item);
    }

    const existingSources = await selectAllRows(rest,
      `accounting_source_documents?select=id,source_key,external_id,document_type&entity_id=eq.${entityId}&source_type=eq.FACTO&order=created_at.asc`,
    );
    const existingByKey = new Map(existingSources.map((source) => [String(source.source_key), source]));
    const existingByExternal = new Map<string, JsonRecord>();
    for (const source of existingSources) {
      const externalId = String(source.external_id || "");
      const purchase = String(source.source_key || "").includes("purchase") || String(source.document_type || "").includes("purchase");
      const directionKey = `${purchase ? "purchase" : "sale"}:${externalId}`;
      if (externalId && !existingByExternal.has(directionKey)) existingByExternal.set(directionKey, source);
    }

    let accepted = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let inconsistent = 0;
    let receivables = 0;
    let payables = 0;
    let controls = 0;
    const sourceDocumentByCanonical = new Map<string, string>();
    const workItems: Array<(typeof prepared)[number] & { sourceKey: string; previous: JsonRecord | undefined }> = [];
    for (const item of selectedByKey.values()) {
      const { normalized } = item;
      if (!normalized.issuedOn || normalized.issuedOn < fromDate || normalized.issuedOn > toDate) {
        skipped += 1;
        if (!normalized.issuedOn) inconsistent += 1;
        continue;
      }
      const previous = existingByKey.get(item.canonicalKey) || existingByExternal.get(`${item.purchase ? "purchase" : "sale"}:${item.externalId}`);
      const sourceKey = previous ? String(previous.source_key) : item.canonicalKey;
      workItems.push({ ...item, sourceKey, previous });
      accepted += 1;
      if (previous) updated += 1;
      else inserted += 1;
      if (normalized.errors.length) inconsistent += 1;
    }

    const sourceRows: JsonRecord[] = [];
    const now = new Date().toISOString();
    for (let index = 0; index < workItems.length; index += 100) {
      const batch = workItems.slice(index, index + 100).map(({ record, externalId, normalized, sourceKey }) => ({
        entity_id: entityId,
        source_type: "FACTO",
        source_id: String(record.id),
        source_key: sourceKey,
        document_type: normalized.documentType,
        external_id: externalId,
        folio: normalized.folio,
        counterpart_tax_id: normalized.taxId,
        counterpart_name: normalized.counterpart,
        issued_on: normalized.issuedOn,
        due_on: normalized.dueOn,
        currency: normalized.currency,
        exchange_rate: normalized.exchangeRate,
        net_amount: normalized.net,
        tax_amount: normalized.tax,
        exempt_amount: normalized.exempt,
        total_amount: normalized.total,
        total_clp: normalized.totalClp,
        status: normalized.errors.length ? "inconsistent" : "validated",
        data_quality: normalized.errors.length ? "inconsistent" : "validated",
        raw_payload: record.payload,
        source_created_at: normalized.sourceCreatedAt,
        source_updated_at: record.updated_at,
        observed_at: record.observed_at,
        updated_at: now,
      }));
      sourceRows.push(...await upsertRows(rest, "accounting_source_documents", batch, "entity_id,source_type,source_key"));
    }
    const sourceByKey = new Map(sourceRows.map((source) => [String(source.source_key), source]));
    const receivableRows: JsonRecord[] = [];
    const payableRows: JsonRecord[] = [];
    for (const item of workItems) {
      const source = sourceByKey.get(item.sourceKey);
      if (!source) continue;
      sourceDocumentByCanonical.set(item.canonicalKey, String(source.id));
      const { normalized } = item;
      if (normalized.totalClp <= 0 || !normalized.counterpart) {
        controls += 1;
        continue;
      }
      const row = item.purchase ? {
        entity_id: entityId,
        source_document_id: source.id,
        supplier_tax_id: normalized.taxId,
        supplier_name: normalized.counterpart,
        document_number: normalized.folio || item.externalId,
        issued_on: normalized.issuedOn,
        due_on: normalized.dueOn,
        currency: normalized.currency,
        exchange_rate: normalized.exchangeRate,
        original_amount: normalized.total,
        original_amount_clp: normalized.totalClp,
        updated_at: now,
      } : {
        entity_id: entityId,
        source_document_id: source.id,
        customer_tax_id: normalized.taxId,
        customer_name: normalized.counterpart,
        document_number: normalized.folio || item.externalId,
        issued_on: normalized.issuedOn,
        due_on: normalized.dueOn,
        currency: normalized.currency,
        exchange_rate: normalized.exchangeRate,
        original_amount: normalized.total,
        original_amount_clp: normalized.totalClp,
        updated_at: now,
      };
      if (item.purchase) payableRows.push(row);
      else receivableRows.push(row);
    }
    for (let index = 0; index < receivableRows.length; index += 100) {
      await upsertRows(rest, "accounting_receivables", receivableRows.slice(index, index + 100), "entity_id,source_document_id");
    }
    for (let index = 0; index < payableRows.length; index += 100) {
      await upsertRows(rest, "accounting_payables", payableRows.slice(index, index + 100), "entity_id,source_document_id");
    }
    receivables = receivableRows.length;
    payables = payableRows.length;

    const backupRows: JsonRecord[] = await Promise.all(prepared.map(async (item) => {
      const selected = selectedByKey.get(item.canonicalKey) === item;
      const inRange = Boolean(item.normalized.issuedOn && item.normalized.issuedOn >= fromDate && item.normalized.issuedOn <= toDate);
      const decision = !item.normalized.issuedOn ? "invalid" : !inRange ? "out_of_range" : selected ? "included" : "superseded";
      return {
        run_id: runId,
        integration_record_id: item.record.id,
        resource: item.resource,
        external_id: item.externalId,
        canonical_key: item.canonicalKey,
        document_date: item.normalized.issuedOn,
        observed_at: item.record.observed_at,
        payload_hash: await sha256Text(JSON.stringify(item.record.payload || {})),
        raw_payload: item.record.payload || {},
        decision,
        source_document_id: sourceDocumentByCanonical.get(item.canonicalKey) || null,
        validation_errors: item.normalized.errors,
      };
    }));
    for (let index = 0; index < backupRows.length; index += 100) {
      await insertRows(rest, "accounting_facto_sync_records", backupRows.slice(index, index + 100));
    }

    const observed = records.map((record) => dateTimeValue(record.observed_at)).filter(Boolean).sort() as string[];
    const status = inconsistent > 0 ? "partial" : "completed";
    await patchRows(rest, "accounting_facto_sync_runs", `id=eq.${runId}`, {
      status,
      source_records: records.length,
      in_range_records: accepted,
      inserted_records: inserted,
      updated_records: updated,
      skipped_records: skipped,
      inconsistent_records: inconsistent,
      receivables,
      payables,
      source_observed_from: observed[0] || null,
      source_observed_to: observed[observed.length - 1] || null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      summary: {
        request_id: requestId,
        source: "integration_records/facto",
        accounting_policy: "document_only",
        backups: backupRows.length,
        controls,
      },
    });
    await rpc(rest, "accounting_refresh_controls", { p_entity_id: entityId });
    await insertRows(rest, "accounting_audit_events", [{
      entity_id: entityId, actor_id: profile.id, action: "facto.history_synced", entity_type: "facto_sync_run",
      entity_id_text: runId, correlation_id: requestIdToUuid(requestId),
      new_value: { from_date: fromDate, to_date: toDate, source_records: records.length, accepted, inserted, updated, skipped, inconsistent, receivables, payables, backups: backupRows.length },
    }]);
    return { runId, status, fromDate, toDate, read: records.length, accepted, inserted, updated, skipped, inconsistent, receivables, payables, controls, backups: backupRows.length };
  } catch (error) {
    await patchRows(rest, "accounting_facto_sync_runs", `id=eq.${runId}`, {
      status: "failed",
      error_message: error instanceof Error ? error.message.slice(0, 1000) : "Error inesperado.",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).catch(() => []);
    throw error;
  }
}

async function syncForeignTrade(rest: RestClient, profile: Profile, requestId: string) {
  const entity = (await selectRows(rest, "accounting_entities?select=id&active=eq.true&order=created_at.asc&limit=1"))[0];
  if (!entity) throw new HttpError(409, "Falta aplicar la migración contable.");
  const entityId = String(entity.id);
  const [operations, suppliers, costs] = await Promise.all([
    selectRows(rest,
      "import_shipments?select=id,supplier_id,reference,title,operation_type,status,value_usd,base_currency,exchange_rate_clp,incoterm,order_date,estimated_arrival,source_label,approved_at,created_at,updated_at,metadata&status=neq.cancelled&order=updated_at.asc&limit=2000",
    ),
    selectRows(rest, "suppliers?select=id,name,company_name,country_code,currency&limit=2000"),
    selectRows(rest,
      "foreign_trade_cost_lines?select=id,operation_id,category,name,amount_original,currency,exchange_rate_clp,amount_clp,source_type,recoverable_tax,notes,metadata,created_at,updated_at&source_type=in.(real,document)&order=updated_at.asc&limit=5000",
    ),
  ]);
  const supplierById = new Map(suppliers.map((supplier) => [String(supplier.id), supplier]));
  const operationById = new Map(operations.map((operation) => [String(operation.id), operation]));
  const now = new Date().toISOString();
  let acceptedOperations = 0;
  let acceptedCosts = 0;
  let inconsistent = 0;

  for (const operation of operations) {
    const operationId = String(operation.id);
    const supplier = supplierById.get(String(operation.supplier_id || ""));
    const currency = validCurrency(operation.base_currency) || "USD";
    const total = numeric(operation.value_usd);
    const exchangeRate = currency === "CLP" ? 1 : numeric(operation.exchange_rate_clp);
    const totalClp = currency === "CLP" ? total : total * exchangeRate;
    const valid = total >= 0 && (currency === "CLP" || exchangeRate > 0);
    await upsertRows(rest, "accounting_source_documents", [{
      entity_id: entityId,
      source_type: "COMERCIO_EXTERIOR",
      source_id: operationId,
      source_key: `operation:${operationId}`,
      document_type: "import_operation",
      external_id: String(operation.reference || operationId),
      folio: String(operation.reference || "") || null,
      counterpart_name: supplier ? String(supplier.company_name || supplier.name || "") || null : null,
      issued_on: dateValue(operation.order_date) || dateValue(operation.created_at),
      due_on: dateValue(operation.estimated_arrival),
      currency,
      exchange_rate: exchangeRate || 1,
      total_amount: total,
      total_clp: totalClp,
      status: valid ? "validated" : "inconsistent",
      data_quality: valid ? "validated" : "inconsistent",
      raw_payload: { ...operation, supplier: supplier || null, accounting_policy: "document_only" },
      source_created_at: dateTimeValue(operation.created_at),
      source_updated_at: dateTimeValue(operation.updated_at),
      observed_at: now,
      updated_at: now,
    }], "entity_id,source_type,source_key");
    acceptedOperations += 1;
    if (!valid) inconsistent += 1;
  }

  for (const cost of costs) {
    const costId = String(cost.id);
    const operation = operationById.get(String(cost.operation_id || ""));
    if (!operation) continue;
    const supplier = supplierById.get(String(operation.supplier_id || ""));
    const currency = validCurrency(cost.currency) || "CLP";
    const total = numeric(cost.amount_original);
    const exchangeRate = currency === "CLP" ? 1 : numeric(cost.exchange_rate_clp);
    const recordedClp = numeric(cost.amount_clp);
    const totalClp = recordedClp || (currency === "CLP" ? total : total * exchangeRate);
    const valid = totalClp > 0 && (currency === "CLP" || exchangeRate > 0);
    await upsertRows(rest, "accounting_source_documents", [{
      entity_id: entityId,
      source_type: "COMERCIO_EXTERIOR",
      source_id: costId,
      source_key: `cost:${costId}`,
      document_type: "import_cost",
      external_id: costId,
      folio: String(operation.reference || "") || null,
      counterpart_name: supplier ? String(supplier.company_name || supplier.name || "") || null : null,
      issued_on: dateValue(cost.created_at) || dateValue(operation.order_date),
      currency,
      exchange_rate: exchangeRate || 1,
      net_amount: cost.recoverable_tax === true ? total : 0,
      tax_amount: 0,
      total_amount: total,
      total_clp: totalClp,
      status: valid ? "validated" : "inconsistent",
      data_quality: valid ? "validated" : "inconsistent",
      raw_payload: {
        ...cost,
        operation_reference: operation.reference,
        operation_title: operation.title,
        accounting_policy: "document_only_requires_review",
      },
      source_created_at: dateTimeValue(cost.created_at),
      source_updated_at: dateTimeValue(cost.updated_at),
      observed_at: now,
      updated_at: now,
    }], "entity_id,source_type,source_key");
    acceptedCosts += 1;
    if (!valid) inconsistent += 1;
  }

  await rpc(rest, "accounting_refresh_controls", { p_entity_id: entityId });
  await insertRows(rest, "accounting_audit_events", [{
    entity_id: entityId,
    actor_id: profile.id,
    action: "foreign_trade.synced",
    entity_type: "integration",
    entity_id_text: "foreign_trade",
    correlation_id: requestIdToUuid(requestId),
    new_value: {
      operations_read: operations.length,
      operations_accepted: acceptedOperations,
      costs_read: costs.length,
      costs_accepted: acceptedCosts,
      inconsistent,
      policy: "document_only_no_automatic_posting",
    },
  }]);
  return {
    operations: acceptedOperations,
    costs: acceptedCosts,
    inconsistent,
    posted: 0,
    policy: "Los datos se consolidaron como evidencia y requieren revisión antes de contabilizar.",
  };
}

async function previewImport(rest: RestClient, profile: Profile, payload: JsonRecord) {
  const entityId = requiredUuid(payload.entityId);
  const storagePath = requiredText(payload.storagePath, 800);
  const fileName = requiredText(payload.fileName, 220);
  const requestedProfile = requiredText(payload.profile, 60);
  const bytes = await downloadStorage(rest, storagePath);
  const fileHash = await sha256Bytes(bytes);
  const preview = await parseBankWorkbook(bytes, requestedProfile);
  const existingBatch = await selectRows(rest,
    `accounting_import_batches?select=id,status&entity_id=eq.${entityId}&source_type=eq.${sourceType(preview.profile)}&file_hash=eq.${fileHash}&limit=1`,
  );
  if (existingBatch.length) throw new HttpError(409, "Este archivo ya fue cargado anteriormente.");
  const bankAccount = await ensureBankAccount(rest, entityId, preview);
  const existingFingerprints = preview.rows.length
    ? await selectRows(rest, `accounting_bank_transactions?select=fingerprint&bank_account_id=eq.${bankAccount.id}&fingerprint=in.(${preview.rows.map((row) => row.fingerprint).join(",")})`)
    : [];
  const duplicateSet = new Set(existingFingerprints.map((row) => String(row.fingerprint)));
  const valid = preview.rows.filter((row) => !row.errors.length && !duplicateSet.has(row.fingerprint));
  const invalid = preview.rows.filter((row) => row.errors.length);
  const duplicates = preview.rows.filter((row) => duplicateSet.has(row.fingerprint));
  const batch = (await insertRows(rest, "accounting_import_batches", [{
    entity_id: entityId,
    source_type: sourceType(preview.profile),
    import_profile: preview.profile,
    status: "previewed",
    file_name: fileName,
    storage_path: storagePath,
    file_hash: fileHash,
    row_count: preview.rows.length,
    new_count: valid.length,
    duplicate_count: duplicates.length,
    error_count: invalid.length,
    summary: { currency: preview.currency, account_hint: preview.account_hint, warnings: preview.warnings },
    imported_by: profile.id,
  }]))[0];
  await insertRows(rest, "accounting_import_rows", preview.rows.map((row) => ({
    batch_id: batch.id,
    row_number: row.row_number,
    fingerprint: row.fingerprint,
    status: row.errors.length ? "invalid" : duplicateSet.has(row.fingerprint) ? "duplicate" : "new",
    normalized_data: row,
    validation_errors: row.errors,
  })));
  return { batch, bankAccount, summary: { total: preview.rows.length, new: valid.length, duplicates: duplicates.length, errors: invalid.length }, rows: preview.rows.slice(0, 300) };
}

async function confirmImport(rest: RestClient, profile: Profile, payload: JsonRecord) {
  const batchId = requiredUuid(payload.batchId);
  const batch = (await selectRows(rest, `accounting_import_batches?select=*&id=eq.${batchId}&limit=1`))[0];
  if (!batch) throw new HttpError(404, "Importación no encontrada.");
  if (batch.status === "imported") return { imported: Number(batch.new_count || 0), existing: true };
  const entityId = String(batch.entity_id);
  const rows = await selectRows(rest, `accounting_import_rows?select=*&batch_id=eq.${batchId}&status=eq.new&order=row_number.asc&limit=5000`);
  const summary = asObject(batch.summary);
  const bankAccount = await bankAccountForBatch(rest, entityId, String(batch.source_type), String(summary.account_hint || ""), String(summary.currency || "CLP"));
  const created = await upsertRows(rest, "accounting_bank_transactions", rows.map((row) => {
    const data = asObject(row.normalized_data);
    const rate = Number(data.exchange_rate || (String(data.currency) === "CLP" ? 1 : payload.exchangeRate));
    if (!Number.isFinite(rate) || rate <= 0) throw new HttpError(400, `Falta tipo de cambio para la fila ${row.row_number}.`);
    return {
      entity_id: entityId,
      bank_account_id: bankAccount.id,
      import_batch_id: batchId,
      source_row_id: row.id,
      transaction_date: data.transaction_date,
      value_date: data.value_date || null,
      description: data.description,
      reference: data.reference || null,
      operation_number: data.operation_number || null,
      debit: Number(data.debit || 0),
      credit: Number(data.credit || 0),
      amount: Number(data.amount || 0),
      balance: data.balance === null ? null : Number(data.balance),
      currency: data.currency,
      exchange_rate: rate,
      amount_clp: Number(data.amount || 0) * rate,
      fingerprint: row.fingerprint,
      metadata: { source_row: row.row_number },
    };
  }), "bank_account_id,fingerprint", true);
  await patchRows(rest, "accounting_import_batches", `id=eq.${batchId}`, { status: "imported", updated_at: new Date().toISOString() });
  await patchRows(rest, "accounting_import_rows", `batch_id=eq.${batchId}&status=eq.new`, { status: "imported" });
  await rpc(rest, "accounting_refresh_controls", { p_entity_id: entityId });
  await insertRows(rest, "accounting_audit_events", [{
    entity_id: entityId, actor_id: profile.id, action: "bank_import.confirmed", entity_type: "import_batch",
    entity_id_text: batchId, new_value: { imported: created.length, bank_account_id: bankAccount.id },
  }]);
  return { imported: created.length, bankAccount };
}

async function proposeReconciliation(rest: RestClient, payload: JsonRecord) {
  const transactionId = requiredUuid(payload.transactionId);
  const transaction = (await selectRows(rest, `accounting_bank_transactions?select=*&id=eq.${transactionId}&limit=1`))[0];
  if (!transaction) throw new HttpError(404, "Movimiento bancario no encontrado.");
  const entityId = String(transaction.entity_id);
  const incoming = Number(transaction.amount_clp) > 0;
  const candidates = await selectRows(rest, incoming
    ? `accounting_receivables?select=*&entity_id=eq.${entityId}&status=in.(pending,partial,overdue,collections)&limit=1000`
    : `accounting_payables?select=*&entity_id=eq.${entityId}&status=in.(pending,partial,overdue)&limit=1000`);
  const amount = Math.abs(Number(transaction.amount_clp));
  const description = normalizeText(`${transaction.description || ""} ${transaction.reference || ""}`);
  const ranked = candidates.map((candidate) => {
    const balance = Number(candidate.balance_clp || 0);
    const amountScore = amount === balance ? 0.65 : Math.max(0, 0.45 - Math.abs(amount - balance) / Math.max(amount, balance, 1));
    const name = normalizeText(String(candidate.customer_name || candidate.supplier_name || ""));
    const document = normalizeText(String(candidate.document_number || ""));
    const textScore = (name && description.includes(name) ? 0.2 : 0) + (document && description.includes(document) ? 0.15 : 0);
    const score = Math.min(1, amountScore + textScore);
    return { targetType: incoming ? "receivable" : "payable", targetId: candidate.id, candidate, score, confidence: score >= 0.95 ? "exact" : score >= 0.75 ? "high" : "possible", suggestedAmount: Math.min(amount, balance) };
  }).filter((item) => item.score >= 0.2).sort((a, b) => b.score - a.score).slice(0, 20);
  return { transaction, candidates: ranked };
}

async function confirmReconciliation(rest: RestClient, profile: Profile, payload: JsonRecord) {
  const transactionId = requiredUuid(payload.transactionId);
  const links = Array.isArray(payload.links) ? payload.links.map(asObject) : [];
  if (!links.length) throw new HttpError(400, "Selecciona al menos un documento para conciliar.");
  const transaction = (await selectRows(rest, `accounting_bank_transactions?select=*&id=eq.${transactionId}&limit=1`))[0];
  if (!transaction) throw new HttpError(404, "Movimiento bancario no encontrado.");
  const entityId = String(transaction.entity_id);
  const transactionAmount = Math.abs(Number(transaction.amount_clp));
  const allocations = links.map((link) => ({ targetType: String(link.targetType), targetId: requiredUuid(link.targetId), amount: positiveNumber(link.amount) }));
  const total = allocations.reduce((sum, link) => sum + link.amount, 0);
  if (total > transactionAmount + 0.5) throw new HttpError(400, "La asignación supera el monto del movimiento bancario.");
  const reconciliation = (await insertRows(rest, "accounting_reconciliations", [{
    entity_id: entityId,
    bank_transaction_id: transactionId,
    status: "confirmed",
    confidence: "manual",
    matched_amount_clp: total,
    explanation: optionalText(payload.note, 500) || "Conciliación confirmada por usuario.",
    confirmed_by: profile.id,
    confirmed_at: new Date().toISOString(),
  }]))[0];
  await insertRows(rest, "accounting_reconciliation_links", allocations.map((link) => ({
    reconciliation_id: reconciliation.id,
    target_type: link.targetType,
    target_id: link.targetId,
    allocated_amount_clp: link.amount,
  })));
  for (const link of allocations) {
    const receivable = link.targetType === "receivable";
    const table = receivable ? "accounting_receivables" : "accounting_payables";
    const allocationTable = receivable ? "accounting_receivable_allocations" : "accounting_payable_allocations";
    const document = (await selectRows(rest, `${table}?select=id,original_amount_clp,paid_amount_clp&id=eq.${link.targetId}&limit=1`))[0];
    if (!document) throw new HttpError(404, "Documento de conciliación no encontrado.");
    const paid = Number(document.paid_amount_clp || 0) + link.amount;
    const original = Number(document.original_amount_clp || 0);
    await patchRows(rest, table, `id=eq.${link.targetId}`, { paid_amount_clp: paid, status: paid >= original - 0.5 ? "paid" : "partial", updated_at: new Date().toISOString() });
    await insertRows(rest, allocationTable, [{
      [receivable ? "receivable_id" : "payable_id"]: link.targetId,
      bank_transaction_id: transactionId,
      amount_clp: link.amount,
      allocated_on: transaction.transaction_date,
      status: "confirmed",
      created_by: profile.id,
    }]);
  }
  await patchRows(rest, "accounting_bank_transactions", `id=eq.${transactionId}`, { reconciliation_status: total >= transactionAmount - 0.5 ? "matched" : "partial", updated_at: new Date().toISOString() });
  await insertRows(rest, "accounting_audit_events", [{
    entity_id: entityId, actor_id: profile.id, action: "reconciliation.confirmed",
    entity_type: "bank_transaction", entity_id_text: transactionId,
    new_value: { reconciliation_id: reconciliation.id, total, links: allocations },
  }]);
  return { reconciliation, matched: total, remaining: Math.max(transactionAmount - total, 0) };
}

async function createCheck(rest: RestClient, profile: Profile, payload: JsonRecord) {
  const entityId = requiredUuid(payload.entityId);
  const receivableId = optionalText(payload.receivableId, 80);
  const row = (await insertRows(rest, "accounting_checks", [{
    entity_id: entityId,
    receivable_id: receivableId ? requiredUuid(receivableId) : null,
    customer_name: requiredText(payload.customerName, 180),
    bank_name: requiredText(payload.bankName, 120),
    check_number: requiredText(payload.checkNumber, 80),
    amount_clp: positiveNumber(payload.amountClp),
    received_on: requiredDate(payload.receivedOn),
    due_on: payload.dueOn ? requiredDate(payload.dueOn) : null,
    status: "portfolio",
    notes: optionalText(payload.notes, 800) || null,
  }]))[0];
  if (!row) throw new HttpError(500, "No se pudo registrar el cheque.");
  await insertRows(rest, "accounting_audit_events", [{
    entity_id: entityId,
    actor_id: profile.id,
    action: "check.created",
    entity_type: "accounting_check",
    entity_id_text: String(row.id),
    new_value: {
      customer_name: row.customer_name,
      bank_name: row.bank_name,
      check_number: row.check_number,
      amount_clp: row.amount_clp,
      status: row.status,
    },
  }]);
  return { id: row.id };
}

async function report(rest: RestClient, url: URL) {
  const entityId = requiredUuid(url.searchParams.get("entityId"));
  const from = requiredDate(url.searchParams.get("from"));
  const to = requiredDate(url.searchParams.get("to"));
  const kind = url.searchParams.get("kind") || "balance8";
  if (kind === "balance8") return { kind, rows: await rpc(rest, "accounting_balance_eight_columns", { p_entity_id: entityId, p_from: from, p_to: to }) };
  if (kind === "trial") return { kind, rows: await rpc(rest, "accounting_trial_balance", { p_entity_id: entityId, p_from: from, p_to: to }) };
  if (kind === "income") return { kind, rows: await rpc(rest, "accounting_income_statement", { p_entity_id: entityId, p_from: from, p_to: to }) };
  if (kind === "cashflow") return { kind, rows: await rpc(rest, "accounting_cash_flow", { p_entity_id: entityId, p_from: from, p_to: to }) };
  if (kind === "journal") {
    const entries = await selectRows(rest, `accounting_journal_entries?select=id,entry_date,entry_number,description,reference,origin,accounting_journal_lines(account_id,line_number,debit_clp,credit_clp,currency,description)&entity_id=eq.${entityId}&status=in.(posted,reversed)&entry_date=gte.${from}&entry_date=lte.${to}&order=entry_date.asc,entry_number.asc&limit=5000`);
    const accountIds = [...new Set(entries.flatMap((entry) => {
      const lines = Array.isArray(entry.accounting_journal_lines) ? entry.accounting_journal_lines : [];
      return lines.map((line) => String(asObject(line).account_id || "")).filter(Boolean);
    }))];
    const accounts = accountIds.length
      ? await selectRows(rest, `accounting_accounts?select=id,code,name&id=in.(${accountIds.join(",")})`)
      : [];
    const accountMap = new Map(accounts.map((account) => [String(account.id), account]));
    const rows = entries.flatMap((entry) => {
      const lines = Array.isArray(entry.accounting_journal_lines) ? entry.accounting_journal_lines : [];
      return lines
        .map((rawLine) => asObject(rawLine))
        .sort((a, b) => numeric(a.line_number) - numeric(b.line_number))
        .map((line) => {
          const account = accountMap.get(String(line.account_id)) || {};
          return {
            fecha: entry.entry_date,
            comprobante: entry.entry_number,
            cuenta_codigo: account.code || "",
            cuenta: account.name || "Cuenta sin identificar",
            glosa: line.description || entry.description,
            referencia: entry.reference || "",
            origen: entry.origin,
            moneda: line.currency || "CLP",
            debe_clp: numeric(line.debit_clp),
            haber_clp: numeric(line.credit_clp),
          };
        });
    });
    return { kind, rows };
  }
  if (kind === "ledger") {
    const accountId = requiredUuid(url.searchParams.get("accountId"));
    const account = (await selectRows(rest, `accounting_accounts?select=id,code,name,normal_balance&entity_id=eq.${entityId}&id=eq.${accountId}&limit=1`))[0];
    if (!account) throw new HttpError(404, "La cuenta solicitada no existe en esta empresa.");
    const rawRows = await selectRows(rest, `accounting_journal_lines?select=line_number,debit_clp,credit_clp,currency,description,accounting_journal_entries!inner(entry_date,entry_number,description,reference,status)&account_id=eq.${accountId}&accounting_journal_entries.entry_date=gte.${from}&accounting_journal_entries.entry_date=lte.${to}&accounting_journal_entries.status=in.(posted,reversed)&limit=5000`);
    rawRows.sort((left, right) => {
      const leftEntry = asObject(left.accounting_journal_entries);
      const rightEntry = asObject(right.accounting_journal_entries);
      return String(leftEntry.entry_date || "").localeCompare(String(rightEntry.entry_date || ""))
        || numeric(leftEntry.entry_number) - numeric(rightEntry.entry_number)
        || numeric(left.line_number) - numeric(right.line_number);
    });
    let runningBalance = 0;
    const creditNature = account.normal_balance === "credit";
    const rows = rawRows.map((line) => {
      const entry = asObject(line.accounting_journal_entries);
      const debit = numeric(line.debit_clp);
      const credit = numeric(line.credit_clp);
      runningBalance += creditNature ? credit - debit : debit - credit;
      return {
        fecha: entry.entry_date,
        comprobante: entry.entry_number,
        cuenta_codigo: account.code,
        cuenta: account.name,
        glosa: line.description || entry.description,
        referencia: entry.reference || "",
        debe_clp: debit,
        haber_clp: credit,
        saldo_acumulado_clp: runningBalance,
      };
    });
    return { kind, rows };
  }
  throw new HttpError(400, "Informe no soportado.");
}

function normalizeFactoDocument(payload: JsonRecord, purchase: boolean, externalId: string) {
  const document = {
    ...payload,
    ...asObject(payload.data),
    ...asObject(payload.document),
    ...asObject(payload.header),
    ...asObject(asObject(payload.data).document),
  };
  const counterpartObject = asObject(first(document, ["customer","client","supplier","provider","receptor","emisor"]));
  const currency = String(first(document, ["currency","moneda","currency_code"]) || "CLP").toUpperCase().slice(0, 3);
  const rate = numeric(first(document, ["exchange_rate","tipo_cambio","dolar"])) || (currency === "CLP" ? 1 : 0);
  const net = numeric(first(document, ["net","net_amount","monto_neto","total_neto"]));
  const tax = numeric(first(document, ["tax","vat","iva","monto_iva"]));
  const exempt = numeric(first(document, ["exempt","exempt_amount","monto_exento"]));
  const total = numeric(first(document, ["total","total_amount","monto_total","amount"]));
  const counterpart = String(first(counterpartObject, ["name","business_name","razon_social"]) || first(document, purchase ? ["supplier_name","provider_name","razon_social"] : ["customer_name","client_name","razon_social"]) || "").trim();
  const errors: string[] = [];
  if (!counterpart) errors.push("counterpart_missing");
  if (!total) errors.push("total_missing");
  if (currency !== "CLP" && !rate) errors.push("exchange_rate_missing");
  return {
    documentType: String(first(document, ["document_type","type","tipo_documento"]) || (purchase ? "purchase_invoice" : "sales_invoice")),
    folio: String(first(document, ["folio","number","document_number","numero"]) || externalId),
    taxId: String(first(counterpartObject, ["tax_id","rut","document_number"]) || first(document, purchase ? ["supplier_tax_id","provider_tax_id","rut"] : ["customer_tax_id","client_tax_id","rut"]) || ""),
    counterpart,
    issuedOn: dateValue(first(document, ["issued_on","issue_date","date","fecha_emision","fecha"])),
    dueOn: dateValue(first(document, ["due_on","due_date","fecha_vencimiento"])),
    currency,
    exchangeRate: rate || 1,
    net, tax, exempt, total,
    totalClp: total * (rate || 1),
    sourceCreatedAt: dateTimeValue(first(document, ["created_at","createdAt","fecha_creacion"])),
    errors,
  };
}

async function ensureBankAccount(rest: RestClient, entityId: string, preview: { profile: string; currency: string; account_hint: string }) {
  const source = sourceType(preview.profile);
  return await bankAccountForBatch(rest, entityId, source, preview.account_hint, preview.currency);
}

async function bankAccountForBatch(rest: RestClient, entityId: string, source: string, accountHint: string, currency: string) {
  const institution = source === "BANCO_ESTADO" ? "BancoEstado" : source === "MERCADO_PAGO" ? "Mercado Pago" : "Scotiabank";
  const rows = await selectRows(rest, `accounting_bank_accounts?select=*&entity_id=eq.${entityId}&institution=eq.${encodeURIComponent(institution)}&account_number_masked=eq.${encodeURIComponent(accountHint)}&currency=eq.${currency}&limit=1`);
  if (rows[0]) return rows[0];
  const classification = source === "MERCADO_PAGO" ? "payment_processor" : currency === "USD" ? "bank_usd" : "bank_clp";
  const account = (await selectRows(rest, `accounting_accounts?select=id&entity_id=eq.${entityId}&classification=eq.${classification}&allows_posting=eq.true&limit=1`))[0];
  if (!account) throw new HttpError(409, `Falta una cuenta contable para ${institution} ${currency}.`);
  return (await insertRows(rest, "accounting_bank_accounts", [{
    entity_id: entityId, institution, account_name: `${institution} ${currency}`,
    account_number_masked: accountHint, currency, ledger_account_id: account.id,
  }]))[0];
}

async function downloadStorage(rest: RestClient, path: string) {
  const clean = path.replace(/^\/+/, "");
  const response = await fetch(`${rest.url}/storage/v1/object/accounting-evidence/${clean}`, { headers: serviceHeaders(rest) });
  if (!response.ok) throw new HttpError(response.status, `No se pudo leer el archivo importado: ${(await response.text()).slice(0, 200)}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function authenticate(request: Request, rest: RestClient) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Debes iniciar sesión.");
  const response = await fetch(`${rest.url}/auth/v1/user`, { headers: { apikey: rest.anonKey, Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new HttpError(401, "Sesión inválida o expirada.");
  const user = await response.json() as JsonRecord;
  return { id: String(user.id || "") };
}

async function getProfile(rest: RestClient, userId: string): Promise<Profile | null> {
  const row = (await selectRows(rest, `profiles?select=id,full_name,role,active&id=eq.${userId}&limit=1`))[0];
  if (!row) return null;
  const role = String(row.role || "visualizador") as AppRole;
  return { id: String(row.id), full_name: String(row.full_name || ""), role: role in rolePermissions ? role : "visualizador", active: row.active !== false };
}

function requirePermission(profile: Profile, permission: string) {
  if (!rolePermissions[profile.role].has(permission)) throw new HttpError(403, "No tienes permiso para esta operación financiera.");
}

async function selectRows(rest: RestClient, path: string): Promise<JsonRecord[]> {
  const response = await fetch(`${rest.url}/rest/v1/${path}`, { headers: serviceHeaders(rest) });
  if (!response.ok) throw new HttpError(response.status, `Error leyendo contabilidad: ${(await response.text()).slice(0, 400)}`);
  return await response.json() as JsonRecord[];
}

async function selectAllRows(rest: RestClient, path: string, pageSize = 1000): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let offset = 0; offset < 50000; offset += pageSize) {
    const page = await selectRows(rest, `${path}${separator}limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function insertRows(rest: RestClient, table: string, rows: JsonRecord[]) {
  if (!rows.length) return [];
  const response = await fetch(`${rest.url}/rest/v1/${table}`, { method: "POST", headers: { ...serviceHeaders(rest), "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(rows) });
  if (!response.ok) throw new HttpError(response.status, `Error guardando ${table}: ${(await response.text()).slice(0, 400)}`);
  return await response.json() as JsonRecord[];
}

async function upsertRows(rest: RestClient, table: string, rows: JsonRecord[], onConflict: string, ignore = false) {
  if (!rows.length) return [];
  const response = await fetch(`${rest.url}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: "POST",
    headers: { ...serviceHeaders(rest), "Content-Type": "application/json", Prefer: `${ignore ? "resolution=ignore-duplicates" : "resolution=merge-duplicates"},return=representation` },
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new HttpError(response.status, `Error consolidando ${table}: ${(await response.text()).slice(0, 400)}`);
  return await response.json() as JsonRecord[];
}

async function patchRows(rest: RestClient, table: string, filter: string, row: JsonRecord) {
  const response = await fetch(`${rest.url}/rest/v1/${table}?${filter}`, { method: "PATCH", headers: { ...serviceHeaders(rest), "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(row) });
  if (!response.ok) throw new HttpError(response.status, `Error actualizando ${table}: ${(await response.text()).slice(0, 400)}`);
  return await response.json() as JsonRecord[];
}

async function rpc(rest: RestClient, fn: string, body: JsonRecord) {
  const response = await fetch(`${rest.url}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...serviceHeaders(rest), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new HttpError(response.status, String(asObject(result).message || `No se pudo ejecutar ${fn}.`));
  return result;
}

function serviceHeaders(rest: RestClient) { return { apikey: rest.serviceRoleKey, Authorization: `Bearer ${rest.serviceRoleKey}` }; }
function getRestClient(): RestClient {
  const url = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() || "";
  if (!url || !anonKey || !serviceRoleKey) throw new HttpError(500, "Faltan variables internas de Supabase.");
  return { url, anonKey, serviceRoleKey };
}

function routeFrom(rawUrl: string) {
  const parts = new URL(rawUrl).pathname.split("/").filter(Boolean);
  const index = parts.lastIndexOf("accounting-center");
  return (index >= 0 ? parts.slice(index + 1) : parts.slice(-1)).join("/") || "bootstrap";
}

function corsHeaders(request: Request) {
  const appUrl = Deno.env.get("CRM_APP_URL")?.trim() || "http://localhost:5173";
  const expected = new URL(appUrl).origin;
  const origin = request.headers.get("origin") || expected;
  return {
    "Access-Control-Allow-Origin": origin === expected ? origin : expected,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-request-id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function json(data: unknown, status: number, request: Request) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(request), "Content-Type": "application/json; charset=utf-8" } });
}

async function readJson(request: Request) {
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new HttpError(400, "El cuerpo debe ser JSON.");
  return payload as JsonRecord;
}

function requiredText(value: unknown, max = 200) { const text = String(value || "").trim(); if (!text) throw new HttpError(400, "Falta un dato obligatorio."); return text.slice(0, max); }
function optionalText(value: unknown, max = 200) { return String(value || "").trim().slice(0, max); }
function requiredUuid(value: unknown) { const text = requiredText(value, 80); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new HttpError(400, "Identificador inválido."); return text; }
function requiredDate(value: unknown) { const text = requiredText(value, 20); if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new HttpError(400, "Fecha inválida."); return text; }
function positiveNumber(value: unknown) { const number = Number(value); if (!Number.isFinite(number) || number <= 0) throw new HttpError(400, "Monto inválido."); return number; }
function asObject(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function numeric(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let text = String(value ?? "").trim().replace(/[^0-9,.-]/g, "");
  if (!text) return 0;
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    text = decimal === "," ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (comma >= 0) {
    const decimals = text.length - comma - 1;
    text = decimals > 0 && decimals <= 4 ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (dot >= 0) {
    const decimals = text.length - dot - 1;
    if (!(decimals > 0 && decimals <= 4)) text = text.replace(/\./g, "");
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}
function first(object: JsonRecord, keys: string[]) { for (const key of keys) if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key]; return null; }
function dateValue(value: unknown) {
  const text = String(value || "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const local = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (local) return `${local[3]}-${local[2].padStart(2, "0")}-${local[1].padStart(2, "0")}`;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}
function dateTimeValue(value: unknown) { const parsed = Date.parse(String(value || "")); return Number.isNaN(parsed) ? null : new Date(parsed).toISOString(); }
function validCurrency(value: unknown) { const text = String(value || "").trim().toUpperCase(); return /^[A-Z]{3}$/.test(text) ? text : null; }
function normalizeText(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function sourceType(profile: string) { return profile === "banco_estado" ? "BANCO_ESTADO" : profile === "mercado_pago" ? "MERCADO_PAGO" : "SCOTIABANK"; }
async function sha256Bytes(bytes: Uint8Array) { const digest = await crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function sha256Text(value: string) { return sha256Bytes(new TextEncoder().encode(value)); }
function requestIdToUuid(value: string) { return /^[0-9a-f-]{36}$/i.test(value) ? value : crypto.randomUUID(); }

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
