import { parseBankWorkbook } from "./bank-parsers.ts";
import { parseFactoExcelWorkbook, type FactoExcelPreview } from "./facto-excel-parsers.ts";

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
    if (route === "facto-excel/preview" && request.method === "POST") {
      requirePermission(profile, "import");
      return json(await previewFactoExcel(rest, profile, await readJson(request)), 201, request);
    }
    if (route === "facto-excel/confirm" && request.method === "POST") {
      requirePermission(profile, "import");
      return json(await confirmFactoExcel(rest, profile, requestId, await readJson(request)), 200, request);
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
  const [accounts, periods, bankAccounts, bankTransactions, sources, entries, receivables, payables, checks, paymentEvents, controls, batches, factoSyncRuns] = await Promise.all([
    selectRows(rest, `accounting_accounts?select=*&entity_id=eq.${entityId}&order=code.asc`),
    selectRows(rest, `accounting_periods?select=*&entity_id=eq.${entityId}&order=starts_on.desc&limit=48`),
    selectRows(rest, `accounting_bank_accounts?select=*&entity_id=eq.${entityId}&order=institution.asc`),
    selectRows(rest, `accounting_bank_transactions?select=*&entity_id=eq.${entityId}&order=transaction_date.desc&limit=250`),
    selectRows(rest, `accounting_source_documents?select=*&entity_id=eq.${entityId}&order=issued_on.desc.nullslast&limit=1000`),
    selectRows(rest, `accounting_journal_entries?select=*&entity_id=eq.${entityId}&order=entry_date.desc,entry_number.desc&limit=250`),
    selectRows(rest, `accounting_receivables?select=*&entity_id=eq.${entityId}&order=due_on.asc.nullslast&limit=500`),
    selectRows(rest, `accounting_payables?select=*&entity_id=eq.${entityId}&order=due_on.asc.nullslast&limit=500`),
    selectRows(rest, `accounting_checks?select=*&entity_id=eq.${entityId}&order=due_on.asc.nullslast&limit=500`),
    selectRows(rest, `accounting_payment_events?select=*&entity_id=eq.${entityId}&order=event_date.desc,event_time.desc.nullslast&limit=2000`),
    selectRows(rest, `accounting_control_findings?select=*&entity_id=eq.${entityId}&status=eq.open&order=severity.asc,detected_at.desc&limit=250`),
    selectRows(rest, `accounting_import_batches?select=*&entity_id=eq.${entityId}&order=created_at.desc&limit=100`),
    selectRows(rest, `accounting_facto_sync_runs?select=*&entity_id=eq.${entityId}&order=created_at.desc&limit=24`),
  ]);
  const summary = await rpc(rest, "accounting_dashboard_summary", { p_entity_id: entityId, p_as_of: new Date().toISOString().slice(0, 10) });
  return {
    entity, accounts, periods, bankAccounts, bankTransactions, sources, entries,
    receivables, payables, checks, paymentEvents, controls, batches, factoSyncRuns, summary,
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
    let sourceRecords = 0;
    let backups = 0;
    let observedFrom: string | null = null;
    let observedTo: string | null = null;
    const includedCanonical = new Set<string>();
    const sourceDocumentByCanonical = new Map<string, string>();
    const backupKeys = new Set<string>();
    // Facto summaries contain the authoritative counterpart and totals. Details
    // remain in the immutable backup, but must not replace the accounting header.
    const orderedResources = ["documents", "purchase_documents", "document_details", "purchase_document_details"];
    for (const resource of orderedResources) {
      const pageSize = resource.includes("details") ? 20 : 100;
      for (let offset = 0; offset < 50000; offset += pageSize) {
        const page = await selectRows(rest,
          `integration_records?select=id,resource,external_id,payload,observed_at,updated_at&provider=eq.facto&resource=eq.${resource}&order=updated_at.asc&limit=${pageSize}&offset=${offset}`,
        );
        if (!page.length) break;
        sourceRecords += page.length;
        const now = new Date().toISOString();
        const pageItems = page.map((record) => {
          const purchase = resource.includes("purchase");
          const externalId = String(record.external_id || record.id);
          const normalized = normalizeFactoDocument(asObject(record.payload), purchase, externalId);
          const canonicalKey = `facto:${purchase ? "purchase" : "sale"}:${externalId}`;
          const observedAt = dateTimeValue(record.observed_at);
          if (observedAt && (!observedFrom || observedAt < observedFrom)) observedFrom = observedAt;
          if (observedAt && (!observedTo || observedAt > observedTo)) observedTo = observedAt;
          let decision = "included";
          if (!normalized.issuedOn) decision = "invalid";
          else if (normalized.issuedOn < fromDate || normalized.issuedOn > toDate) decision = "out_of_range";
          else if (includedCanonical.has(canonicalKey)) decision = "superseded";
          return { record, resource, purchase, externalId, normalized, canonicalKey, decision };
        });

        const includedItems = pageItems.filter((item) => item.decision === "included");
        const sourceKeyByCanonical = new Map<string, string>();
        for (const item of includedItems) {
          includedCanonical.add(item.canonicalKey);
          accepted += 1;
          const directionKey = `${item.purchase ? "purchase" : "sale"}:${item.externalId}`;
          const previous = existingByKey.get(item.canonicalKey) || existingByExternal.get(directionKey);
          const sourceKey = previous ? String(previous.source_key) : item.canonicalKey;
          sourceKeyByCanonical.set(item.canonicalKey, sourceKey);
          if (previous) updated += 1;
          else inserted += 1;
          if (item.normalized.errors.length) inconsistent += 1;
        }
        for (const item of pageItems) {
          if (item.decision === "invalid") {
            inconsistent += 1;
            skipped += 1;
          } else if (item.decision === "out_of_range") skipped += 1;
        }

        const sourceBatch = includedItems.map(({ record, externalId, normalized, canonicalKey }) => ({
          entity_id: entityId,
          source_type: "FACTO",
          source_id: String(record.id),
          source_key: sourceKeyByCanonical.get(canonicalKey) || canonicalKey,
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
          raw_payload: record.payload || {},
          source_created_at: normalized.sourceCreatedAt,
          source_updated_at: record.updated_at,
          observed_at: record.observed_at,
          updated_at: now,
        }));
        const savedSources = sourceBatch.length
          ? await upsertRowsSelected(rest, "accounting_source_documents", sourceBatch, "entity_id,source_type,source_key", "id,source_key,external_id,document_type")
          : [];
        const sourceByKey = new Map(savedSources.map((source) => [String(source.source_key), source]));
        const receivableRows: JsonRecord[] = [];
        const payableRows: JsonRecord[] = [];
        for (const item of includedItems) {
          const sourceKey = sourceKeyByCanonical.get(item.canonicalKey) || item.canonicalKey;
          const source = sourceByKey.get(sourceKey);
          if (!source) {
            controls += 1;
            continue;
          }
          sourceDocumentByCanonical.set(item.canonicalKey, String(source.id));
          existingByKey.set(sourceKey, source);
          existingByExternal.set(`${item.purchase ? "purchase" : "sale"}:${item.externalId}`, source);
          const { normalized } = item;
          if (normalized.totalClp <= 0 || !normalized.counterpart) {
            controls += 1;
            continue;
          }
          const common = {
            entity_id: entityId,
            source_document_id: source.id,
            document_number: normalized.folio || item.externalId,
            issued_on: normalized.issuedOn,
            due_on: normalized.dueOn,
            currency: normalized.currency,
            exchange_rate: normalized.exchangeRate,
            original_amount: normalized.total,
            original_amount_clp: normalized.totalClp,
            updated_at: now,
          };
          if (item.purchase) {
            payableRows.push({ ...common, supplier_tax_id: normalized.taxId, supplier_name: normalized.counterpart });
          } else {
            receivableRows.push({ ...common, customer_tax_id: normalized.taxId, customer_name: normalized.counterpart });
          }
        }
        if (receivableRows.length) {
          await upsertRowsSelected(rest, "accounting_receivables", receivableRows, "entity_id,source_document_id", "id");
          receivables += receivableRows.length;
        }
        if (payableRows.length) {
          await upsertRowsSelected(rest, "accounting_payables", payableRows, "entity_id,source_document_id", "id");
          payables += payableRows.length;
        }

        const backupRowsByKey = new Map<string, JsonRecord>();
        for (const item of pageItems) {
          // Facto can expose more than one integration row for the same document.
          // Keep the latest payload in this run instead of failing the whole history load.
          const backupKey = `${item.resource}:${item.externalId}`;
          backupKeys.add(backupKey);
          backupRowsByKey.set(backupKey, {
            run_id: runId,
            integration_record_id: item.record.id,
            resource: item.resource,
            external_id: item.externalId,
            canonical_key: item.canonicalKey,
            document_date: item.normalized.issuedOn,
            observed_at: item.record.observed_at,
            payload_hash: await sha256Text(JSON.stringify(item.record.payload || {})),
            raw_payload: item.record.payload || {},
            decision: item.decision,
            source_document_id: sourceDocumentByCanonical.get(item.canonicalKey) || null,
            validation_errors: item.normalized.errors,
          });
        }
        const backupRows = [...backupRowsByKey.values()];
        if (backupRows.length) {
          await upsertRowsMinimal(rest, "accounting_facto_sync_records", backupRows, "run_id,resource,external_id");
        }
        backups = backupKeys.size;
        await patchRows(rest, "accounting_facto_sync_runs", `id=eq.${runId}`, {
          source_records: sourceRecords,
          in_range_records: accepted,
          inserted_records: inserted,
          updated_records: updated,
          skipped_records: skipped,
          inconsistent_records: inconsistent,
          receivables,
          payables,
          source_observed_from: observedFrom,
          source_observed_to: observedTo,
          updated_at: new Date().toISOString(),
          summary: { request_id: requestId, source: "integration_records/facto", accounting_policy: "document_only", backups, controls, current_resource: resource, current_offset: offset },
        });
        if (page.length < pageSize) break;
      }
    }

    const status = inconsistent > 0 ? "partial" : "completed";
    await patchRows(rest, "accounting_facto_sync_runs", `id=eq.${runId}`, {
      status,
      source_records: sourceRecords,
      in_range_records: accepted,
      inserted_records: inserted,
      updated_records: updated,
      skipped_records: skipped,
      inconsistent_records: inconsistent,
      receivables,
      payables,
      source_observed_from: observedFrom,
      source_observed_to: observedTo,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      summary: {
        request_id: requestId,
        source: "integration_records/facto",
        accounting_policy: "document_only",
        backups,
        controls,
      },
    });
    await rpc(rest, "accounting_refresh_controls", { p_entity_id: entityId });
    await insertRows(rest, "accounting_audit_events", [{
      entity_id: entityId, actor_id: profile.id, action: "facto.history_synced", entity_type: "facto_sync_run",
      entity_id_text: runId, correlation_id: requestIdToUuid(requestId),
      new_value: { from_date: fromDate, to_date: toDate, source_records: sourceRecords, accepted, inserted, updated, skipped, inconsistent, receivables, payables, backups },
    }]);
    return { runId, status, fromDate, toDate, read: sourceRecords, accepted, inserted, updated, skipped, inconsistent, receivables, payables, controls, backups };
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
  const latestTransactionDate = preview.rows.reduce(
    (latest, row) => row.transaction_date > latest ? row.transaction_date : latest,
    "",
  );
  const suggestedExchangeRate = preview.currency === "CLP"
    ? null
    : (await selectRows(
      rest,
      `accounting_exchange_rates?select=rate,rate_date,source,status&from_currency=eq.${preview.currency}&to_currency=eq.CLP${latestTransactionDate ? `&rate_date=lte.${latestTransactionDate}` : ""}&order=rate_date.desc,created_at.desc&limit=1`,
    ))[0] || null;
  const duplicateSet = await existingBankFingerprints(
    rest,
    String(bankAccount.id),
    preview.rows.map((row) => row.fingerprint),
  );
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
  return {
    batch,
    bankAccount,
    suggestedExchangeRate,
    summary: { total: preview.rows.length, new: valid.length, duplicates: duplicates.length, errors: invalid.length },
    rows: preview.rows.slice(0, 300),
  };
}

async function existingBankFingerprints(rest: RestClient, bankAccountId: string, fingerprints: string[]) {
  const duplicateSet = new Set<string>();
  const uniqueFingerprints = [...new Set(fingerprints.filter(Boolean))];

  // PostgREST receives filters in the URL. Large bank statements can easily
  // exceed the proxy URI limit when every SHA-256 fingerprint is sent at once.
  for (let index = 0; index < uniqueFingerprints.length; index += 40) {
    const chunk = uniqueFingerprints.slice(index, index + 40);
    const rows = await selectRows(
      rest,
      `accounting_bank_transactions?select=fingerprint&bank_account_id=eq.${bankAccountId}&fingerprint=in.(${chunk.join(",")})`,
    );
    rows.forEach((row) => duplicateSet.add(String(row.fingerprint)));
  }

  return duplicateSet;
}

async function previewFactoExcel(rest: RestClient, profile: Profile, payload: JsonRecord) {
  const entityId = requiredUuid(payload.entityId);
  const storagePath = requiredText(payload.storagePath, 800);
  const fileName = requiredText(payload.fileName, 220);
  const requestedProfile = requiredText(payload.profile, 80);
  const bytes = await downloadStorage(rest, storagePath);
  const fileHash = await sha256Bytes(bytes);
  const preview = await parseFactoExcelWorkbook(bytes, requestedProfile);
  const existingBatch = await selectRows(rest,
    `accounting_import_batches?select=id,status,created_at&entity_id=eq.${entityId}&source_type=eq.${preview.source_type}&file_hash=eq.${fileHash}&limit=1`,
  );
  if (existingBatch.length) throw new HttpError(409, "Este respaldo Facto ya fue cargado. El original anterior permanece guardado y no se duplicó.");

  const duplicateSet = await existingFactoExcelDuplicates(rest, entityId, preview);
  const valid = preview.rows.filter((row) => !row.errors.length && !duplicateSet.has(row.fingerprint));
  const invalid = preview.rows.filter((row) => row.errors.length);
  const duplicates = preview.rows.filter((row) => !row.errors.length && duplicateSet.has(row.fingerprint));
  const batch = (await insertRows(rest, "accounting_import_batches", [{
    entity_id: entityId,
    source_type: preview.source_type,
    import_profile: preview.profile,
    status: "previewed",
    file_name: fileName,
    storage_path: storagePath,
    file_hash: fileHash,
    row_count: preview.rows.length,
    new_count: valid.length,
    duplicate_count: duplicates.length,
    error_count: invalid.length,
    summary: { ...preview.summary, warnings: preview.warnings, evidence_kind: "facto_excel" },
    imported_by: profile.id,
  }]))[0];
  await insertRows(rest, "accounting_import_rows", preview.rows.map((row) => ({
    batch_id: batch.id,
    row_number: row.row_number,
    fingerprint: row.fingerprint,
    status: row.errors.length ? "invalid" : duplicateSet.has(row.fingerprint) ? "duplicate" : "new",
    normalized_data: { kind: row.kind, ...row.data },
    validation_errors: row.errors,
  })));
  return {
    batch,
    profile: preview.profile,
    warnings: preview.warnings,
    summary: { total: preview.rows.length, new: valid.length, duplicates: duplicates.length, errors: invalid.length, ...preview.summary },
    rows: preview.rows.slice(0, 500),
  };
}

async function confirmFactoExcel(rest: RestClient, profile: Profile, requestId: string, payload: JsonRecord) {
  const batchId = requiredUuid(payload.batchId);
  const batch = (await selectRows(rest, `accounting_import_batches?select=*&id=eq.${batchId}&limit=1`))[0];
  if (!batch) throw new HttpError(404, "Respaldo Facto no encontrado.");
  if (!["COLLECTIONS", "PAYMENTS", "CHECKS"].includes(String(batch.source_type))) {
    throw new HttpError(400, "Este archivo no corresponde a un respaldo complementario de Facto.");
  }
  if (batch.status === "imported" || batch.status === "partial") {
    return { imported: Number(batch.new_count || 0), existing: true, summary: asObject(batch.summary) };
  }

  const entityId = String(batch.entity_id);
  const importRows = await selectAllRows(rest, `accounting_import_rows?select=*&batch_id=eq.${batchId}&status=eq.new&order=row_number.asc`);
  const sourceDocuments = await selectAllRows(rest, `accounting_source_documents?select=*&entity_id=eq.${entityId}&source_type=eq.FACTO`);
  const receivables = await selectAllRows(rest, `accounting_receivables?select=*&entity_id=eq.${entityId}`);
  const payables = await selectAllRows(rest, `accounting_payables?select=*&entity_id=eq.${entityId}`);
  const receivableBySource = new Map(receivables.map((row) => [String(row.source_document_id), row]));
  const payableBySource = new Map(payables.map((row) => [String(row.source_document_id), row]));
  let imported = 0;
  let linked = 0;
  let unmatched = 0;
  let duplicates = 0;
  const duplicateImportRowIds: string[] = [];

  if (String(batch.source_type) === "COLLECTIONS") {
    for (const row of importRows) {
      const data = asObject(row.normalized_data);
      const source = findFactoSourceDocument(sourceDocuments, data);
      const target = source
        ? String(data.direction) === "sale" ? receivableBySource.get(String(source.id)) : payableBySource.get(String(source.id))
        : null;
      if (!target) {
        unmatched += 1;
        continue;
      }
      const reportedPaid = Math.max(0, numeric(data.reported_paid_clp));
      const reportedBalance = Math.max(0, numeric(data.reported_balance_clp));
      const dueOn = String(target.due_on || "");
      const status = reportedBalance <= 1
        ? "paid"
        : reportedPaid > 0
        ? "partial"
        : dueOn && dueOn < new Date().toISOString().slice(0, 10)
        ? "overdue"
        : "pending";
      const table = String(data.direction) === "sale" ? "accounting_receivables" : "accounting_payables";
      await patchRows(rest, table, `id=eq.${target.id}`, {
        reported_paid_amount_clp: reportedPaid,
        reported_balance_clp: reportedBalance,
        reported_at: new Date().toISOString(),
        reported_source_batch_id: batchId,
        status,
        updated_at: new Date().toISOString(),
      });
      imported += 1;
      linked += 1;
    }
  } else if (String(batch.source_type) === "CHECKS") {
    const settlementAccount = await expectedBankAccount(rest, entityId, "BancoEstado");
    const existingChecks = await selectAllRows(rest,
      `accounting_checks?select=bank_name,check_number&entity_id=eq.${entityId}`,
    );
    const existingCheckKeys = new Set(existingChecks.map((row) => checkBusinessKey(row.bank_name, row.check_number)));
    const checkRows = importRows.flatMap((row) => {
      const data = asObject(row.normalized_data);
      const businessKey = checkBusinessKey(data.issuer_bank, data.check_number);
      if (existingCheckKeys.has(businessKey)) {
        duplicates += 1;
        duplicateImportRowIds.push(String(row.id));
        return [];
      }
      existingCheckKeys.add(businessKey);
      const source = findFactoSourceDocument(sourceDocuments, {
        direction: "sale",
        document_type: "sales_invoice",
        document_number: data.source_document_number,
        counterpart_tax_id: data.customer_tax_id,
      });
      const receivable = source ? receivableBySource.get(String(source.id)) : null;
      if (receivable) linked += 1;
      else unmatched += 1;
      return [{
        entity_id: entityId,
        receivable_id: receivable?.id || null,
        customer_name: String(data.customer_name || data.issuer_name || "Cliente sin identificar"),
        bank_name: String(data.issuer_bank || "Banco emisor no informado"),
        check_number: String(data.check_number || ""),
        amount_clp: numeric(data.amount_clp),
        received_on: data.received_on,
        due_on: data.due_on || null,
        status: "portfolio",
        import_batch_id: batchId,
        source_row_id: row.id,
        settlement_bank_account_id: settlementAccount?.id || null,
        source_status: data.source_status || null,
        notes: "Cheque informado por Facto; pendiente de confirmar en cartola BancoEstado.",
        metadata: {
          expected_settlement_institution: "BancoEstado",
          issuer_tax_id: data.issuer_tax_id || null,
          detail: data.detail || null,
          source_document_number: data.source_document_number || null,
        },
        updated_at: new Date().toISOString(),
      }];
    });
    const created = await upsertRows(rest, "accounting_checks", checkRows, "entity_id,bank_name,check_number", true);
    imported = created.length;
    duplicates += Math.max(0, checkRows.length - created.length);
  } else {
    const profileName = String(batch.import_profile || "facto_cash");
    const paymentRows: JsonRecord[] = [];
    const existingEvents = await selectAllRows(rest,
      `accounting_payment_events?select=fingerprint&entity_id=eq.${entityId}`,
    );
    const existingFingerprints = new Set(existingEvents.map((row) => String(row.fingerprint)));
    const expectedAccounts = new Map<string, JsonRecord | null>();
    for (const row of importRows) {
      const data = asObject(row.normalized_data);
      const fingerprint = String(row.fingerprint || "");
      if (existingFingerprints.has(fingerprint)) {
        duplicates += 1;
        duplicateImportRowIds.push(String(row.id));
        continue;
      }
      existingFingerprints.add(fingerprint);
      const source = findFactoSourceDocument(sourceDocuments, data);
      const receivable = source && String(data.direction) === "receipt" ? receivableBySource.get(String(source.id)) : null;
      const payable = source && String(data.direction) === "payment" ? payableBySource.get(String(source.id)) : null;
      const institution = optionalText(data.expected_institution, 80);
      if (institution && !expectedAccounts.has(institution)) {
        expectedAccounts.set(institution, await expectedBankAccount(rest, entityId, institution));
      }
      const expectedAccount = institution ? expectedAccounts.get(institution) || null : null;
      if (source) linked += 1;
      else unmatched += 1;
      paymentRows.push({
        entity_id: entityId,
        source_document_id: source?.id || null,
        receivable_id: receivable?.id || null,
        payable_id: payable?.id || null,
        import_batch_id: batchId,
        source_row_id: row.id,
        expected_bank_account_id: expectedAccount?.id || null,
        event_date: data.event_date,
        event_time: data.event_time || null,
        direction: data.direction,
        document_type: data.document_type || null,
        document_number: data.document_number || null,
        payment_method: data.payment_method || null,
        responsible: data.responsible || null,
        amount_clp: numeric(data.amount_clp),
        signed_amount_clp: numeric(data.signed_amount_clp),
        source_profile: profileName,
        fingerprint,
        matching_status: source ? "linked" : "unmatched",
        metadata: { expected_institution: institution || null, evidence: "Facto Excel" },
        updated_at: new Date().toISOString(),
      });
    }
    const created = await upsertRows(rest, "accounting_payment_events", paymentRows, "entity_id,fingerprint", true);
    imported = created.length;
    duplicates += Math.max(0, paymentRows.length - created.length);
  }

  const invalid = Number(batch.error_count || 0);
  const status = invalid || unmatched ? "partial" : "imported";
  const finalSummary = {
    ...asObject(batch.summary),
    imported,
    linked,
    unmatched,
    duplicates,
    confirmed_at: new Date().toISOString(),
  };
  await patchRows(rest, "accounting_import_batches", `id=eq.${batchId}`, {
    status,
    new_count: imported,
    duplicate_count: Number(batch.duplicate_count || 0) + duplicates,
    summary: finalSummary,
    updated_at: new Date().toISOString(),
  });
  if (duplicateImportRowIds.length) {
    await patchRows(rest, "accounting_import_rows", `id=in.(${duplicateImportRowIds.join(",")})`, { status: "duplicate" });
  }
  await patchRows(rest, "accounting_import_rows", `batch_id=eq.${batchId}&status=eq.new`, { status: "imported" });
  await insertRows(rest, "accounting_audit_events", [{
    entity_id: entityId,
    actor_id: profile.id,
    action: "facto_excel.confirmed",
    entity_type: "import_batch",
    entity_id_text: batchId,
    correlation_id: requestIdToUuid(requestId),
    new_value: { source_type: batch.source_type, import_profile: batch.import_profile, imported, linked, unmatched, duplicates, invalid },
  }]);
  await rpc(rest, "accounting_refresh_controls", { p_entity_id: entityId });
  return { imported, linked, unmatched, duplicates, invalid, status, summary: finalSummary };
}

async function confirmImport(rest: RestClient, profile: Profile, payload: JsonRecord) {
  const batchId = requiredUuid(payload.batchId);
  const batch = (await selectRows(rest, `accounting_import_batches?select=*&id=eq.${batchId}&limit=1`))[0];
  if (!batch) throw new HttpError(404, "Importación no encontrada.");
  if (batch.status === "imported") return { imported: Number(batch.new_count || 0), existing: true };
  const entityId = String(batch.entity_id);
  const rows = await selectRows(rest, `accounting_import_rows?select=*&batch_id=eq.${batchId}&status=eq.new&order=row_number.asc&limit=5000`);
  const summary = asObject(batch.summary);
  const batchCurrency = String(summary.currency || "CLP").toUpperCase();
  const requestedRate = numeric(payload.exchangeRate);
  if (batchCurrency !== "CLP" && requestedRate <= 0) {
    throw new HttpError(400, `Ingresa un tipo de cambio ${batchCurrency}/CLP válido para confirmar la cartola.`);
  }
  const bankAccount = await bankAccountForBatch(rest, entityId, String(batch.source_type), String(summary.account_hint || ""), String(summary.currency || "CLP"));
  const created = await upsertRows(rest, "accounting_bank_transactions", rows.map((row) => {
    const data = asObject(row.normalized_data);
    const rowCurrency = String(data.currency || batchCurrency).toUpperCase();
    const documentedRate = numeric(data.exchange_rate);
    const rate = documentedRate > 0 ? documentedRate : rowCurrency === "CLP" ? 1 : requestedRate;
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
      currency: rowCurrency,
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
    entity_id_text: batchId,
    new_value: {
      imported: created.length,
      bank_account_id: bankAccount.id,
      currency: batchCurrency,
      exchange_rate: batchCurrency === "CLP" ? 1 : requestedRate,
    },
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
  const currencyId = String(first(document, ["currency_id"]) || "");
  const currency = String(first(document, ["currency","moneda","currency_code"]) || (currencyId === "39" ? "CLP" : "CLP")).toUpperCase().slice(0, 3);
  const rate = numeric(first(document, ["exchange_rate","tipo_cambio","dolar"])) || (currency === "CLP" ? 1 : 0);
  const net = numeric(first(document, ["net","net_amount","monto_neto","total_neto"]));
  const tax = numeric(first(document, ["tax","vat","iva","monto_iva","taxes_amount"]));
  const exempt = numeric(first(document, ["exempt","exempt_amount","monto_exento"]));
  const total = numeric(first(document, ["total","total_amount","monto_total","amount"]));
  const documentType = factoDocumentType(document, purchase);
  let counterpart = String(
    first(counterpartObject, ["name","business_name","razon_social"])
      || first(document, purchase
        ? ["issuer_name","issuer_legal_name","supplier_name","provider_name","razon_social"]
        : ["receiver_legal_name","receiver_name","customer_name","client_name","razon_social"])
      || "",
  ).trim();
  // Chilean receipts can legitimately omit the customer's identity. Preserve the
  // sale without inventing a person while keeping it reconcilable as consumer sales.
  if (!counterpart && !purchase && ["sales_receipt", "sales_exempt_receipt"].includes(documentType)) {
    counterpart = "Consumidor final";
  }
  const errors: string[] = [];
  if (!counterpart) errors.push("counterpart_missing");
  if (!total) errors.push("total_missing");
  if (currency !== "CLP" && !rate) errors.push("exchange_rate_missing");
  return {
    documentType,
    folio: String(first(document, ["folio","number","document_number","numero"]) || externalId),
    taxId: String(
      first(counterpartObject, ["tax_id","rut","document_number"])
        || first(document, purchase
          ? ["issuer_tax_id_code","supplier_tax_id","provider_tax_id","rut"]
          : ["receiver_tax_id_code","customer_tax_id","client_tax_id","rut"])
        || "",
    ),
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

function factoDocumentType(document: JsonRecord, purchase: boolean) {
  const taxType = String(first(document, ["document_type_taxbureau", "tax_document_type"]) || "");
  const direction = purchase ? "purchase" : "sales";
  const suffixByTaxType: Record<string, string> = {
    "33": "invoice",
    "34": "exempt_invoice",
    "39": "receipt",
    "41": "exempt_receipt",
    "56": "debit_note",
    "61": "credit_note",
  };
  if (suffixByTaxType[taxType]) return `${direction}_${suffixByTaxType[taxType]}`;
  return String(first(document, ["document_type", "type", "tipo_documento"]) || `${direction}_invoice`);
}

function findFactoSourceDocument(documents: JsonRecord[], data: JsonRecord) {
  const folio = normalizeDocumentNumber(data.document_number || data.source_document_number);
  if (!folio) return null;
  const documentType = String(data.document_type || "");
  const direction = String(data.direction || "");
  const taxId = normalizeTaxForMatch(data.counterpart_tax_id || data.customer_tax_id);
  const candidates = documents
    .filter((row) => normalizeDocumentNumber(row.folio) === folio)
    .map((row) => {
      let score = 1;
      const rowType = String(row.document_type || "");
      if (documentType && rowType === documentType) score += 5;
      if (direction === "sale" && rowType.startsWith("sales_")) score += 3;
      if (direction === "purchase" && rowType.startsWith("purchase_")) score += 3;
      const rowTaxId = normalizeTaxForMatch(row.counterpart_tax_id);
      if (taxId && rowTaxId === taxId) score += 4;
      return { row, score };
    })
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.row || null;
}

async function existingFactoExcelDuplicates(
  rest: RestClient,
  entityId: string,
  preview: FactoExcelPreview,
) {
  const duplicateFingerprints = new Set<string>();
  if (preview.source_type === "PAYMENTS") {
    const existing = await selectAllRows(rest,
      `accounting_payment_events?select=fingerprint&entity_id=eq.${entityId}`,
    );
    const fingerprints = new Set(existing.map((row) => String(row.fingerprint)));
    for (const row of preview.rows) {
      if (fingerprints.has(row.fingerprint)) duplicateFingerprints.add(row.fingerprint);
    }
  } else if (preview.source_type === "CHECKS") {
    const existing = await selectAllRows(rest,
      `accounting_checks?select=bank_name,check_number&entity_id=eq.${entityId}`,
    );
    const keys = new Set(existing.map((row) => checkBusinessKey(row.bank_name, row.check_number)));
    for (const row of preview.rows) {
      if (keys.has(checkBusinessKey(row.data.issuer_bank, row.data.check_number))) {
        duplicateFingerprints.add(row.fingerprint);
      }
    }
  }
  return duplicateFingerprints;
}

function checkBusinessKey(bankName: unknown, checkNumber: unknown) {
  return `${normalizeText(bankName)}|${normalizeDocumentNumber(checkNumber)}`;
}

function normalizeDocumentNumber(value: unknown) {
  return String(value ?? "").trim().replace(/\.0+$/, "").replace(/[^a-z0-9-]/gi, "").toUpperCase();
}

function normalizeTaxForMatch(value: unknown) {
  return String(value ?? "").toUpperCase().replace(/[^0-9K]/g, "");
}

async function expectedBankAccount(rest: RestClient, entityId: string, institution: string) {
  const normalized = normalizeText(institution);
  const canonical = normalized.includes("mercado")
    ? "Mercado Pago"
    : normalized.includes("estado")
    ? "BancoEstado"
    : normalized.includes("scotia")
    ? "Scotiabank"
    : institution;
  const existing = await selectRows(rest,
    `accounting_bank_accounts?select=*&entity_id=eq.${entityId}&institution=eq.${encodeURIComponent(canonical)}&currency=eq.CLP&active=eq.true&order=created_at.asc&limit=1`,
  );
  if (existing[0]) return existing[0];
  const source = canonical === "BancoEstado" ? "BANCO_ESTADO" : canonical === "Mercado Pago" ? "MERCADO_PAGO" : "SCOTIABANK";
  return await bankAccountForBatch(rest, entityId, source, "Pendiente cartola Facto", "CLP");
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

async function upsertRowsSelected(rest: RestClient, table: string, rows: JsonRecord[], onConflict: string, select: string) {
  if (!rows.length) return [];
  const response = await fetch(`${rest.url}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}&select=${encodeURIComponent(select)}`, {
    method: "POST",
    headers: { ...serviceHeaders(rest), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new HttpError(response.status, `Error consolidando ${table}: ${(await response.text()).slice(0, 400)}`);
  return await response.json() as JsonRecord[];
}

async function upsertRowsMinimal(rest: RestClient, table: string, rows: JsonRecord[], onConflict: string) {
  if (!rows.length) return;
  const response = await fetch(`${rest.url}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: "POST",
    headers: { ...serviceHeaders(rest), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new HttpError(response.status, `Error consolidando ${table}: ${(await response.text()).slice(0, 400)}`);
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
function normalizeText(value: unknown) { return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function sourceType(profile: string) { return profile === "banco_estado" ? "BANCO_ESTADO" : profile === "mercado_pago" ? "MERCADO_PAGO" : "SCOTIABANK"; }
async function sha256Bytes(bytes: Uint8Array) { const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer); return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function sha256Text(value: string) { return sha256Bytes(new TextEncoder().encode(value)); }
function requestIdToUuid(value: string) { return /^[0-9a-f-]{36}$/i.test(value) ? value : crypto.randomUUID(); }

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
