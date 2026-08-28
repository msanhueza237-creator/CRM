import { parseBankWorkbook } from "./bank-parsers.ts";
import { parseFactoExcelWorkbook, type FactoExcelPreview } from "./facto-excel-parsers.ts";
import {
  buildSuggestedAllocationPlan,
  rankReconciliationCandidates,
  selectVerifiedExactAllocation,
  type ReconciliationDocumentInput,
} from "./reconciliation-engine.ts";
import { buildFactoCurrentStateAdjustment } from "./facto-current-state.ts";

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
    if (route === "facto/cost-entry" && request.method === "POST") {
      requirePermission(profile, "post");
      return json(await postFactoCostEntry(rest, profile, requestId, await readJson(request)), 200, request);
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
    if (route === "reconciliation/exact-preview" && request.method === "POST") {
      requirePermission(profile, "reconcile");
      return json(await previewExactReconciliations(rest, await readJson(request)), 200, request);
    }
    if (route === "reconciliation/exact-confirm" && request.method === "POST") {
      requirePermission(profile, "reconcile");
      return json(await confirmExactReconciliations(rest, profile, await readJson(request)), 200, request);
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
    if (route === "ledger/coverage" && request.method === "POST") {
      requirePermission(profile, "view");
      return json(await accountingLedgerCoverage(rest, await readJson(request)), 200, request);
    }
    if (route === "ledger/prepare" && request.method === "POST") {
      requirePermission(profile, "post");
      return json(await prepareAccountingLedger(rest, profile, await readJson(request)), 200, request);
    }
    if (route === "ledger/payroll-accruals" && request.method === "POST") {
      requirePermission(profile, "post");
      return json(await accruePayroll(rest, profile, await readJson(request)), 200, request);
    }
    if (route === "ledger/verified-classifications" && request.method === "POST") {
      requirePermission(profile, "post");
      return json(await postVerifiedBankClassifications(rest, profile, await readJson(request)), 200, request);
    }
    if (route === "ledger/facto-check-settlements" && request.method === "POST") {
      requirePermission(profile, "post");
      return json(await settleFactoChecks(rest, profile, await readJson(request)), 200, request);
    }
    if (route === "ledger/facto-current-state" && request.method === "POST") {
      requirePermission(profile, "post");
      return json(await applyFactoCurrentState(rest, profile, await readJson(request)), 200, request);
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
  const asOf = new Date().toISOString().slice(0, 10);
  const [summary, dashboard] = await Promise.all([
    rpc(rest, "accounting_dashboard_summary", { p_entity_id: entityId, p_as_of: asOf }),
    buildDashboardAnalytics(rest, entityId, asOf, sources),
  ]);
  return {
    entity, accounts, periods, bankAccounts, bankTransactions, sources, entries,
    receivables, payables, checks, paymentEvents, controls, batches, factoSyncRuns, summary, dashboard,
    profile: { role: profile.role, permissions: [...rolePermissions[profile.role]] },
  };
}

type DashboardResultTotals = {
  sales: number;
  costs: number;
  expenses: number;
  otherResults: number;
  grossProfit: number;
  operatingProfit: number;
  grossMargin: number | null;
  operatingMargin: number | null;
};

const dashboardMonthLabels = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

function dashboardIncomeTotals(rawRows: unknown): DashboardResultTotals {
  const totals = { sales: 0, costs: 0, expenses: 0, otherResults: 0 };
  const rows = Array.isArray(rawRows) ? rawRows : [];
  for (const rawRow of rows) {
    const row = asObject(rawRow);
    const amount = numeric(row.amount_clp);
    switch (String(row.category || "")) {
      case "Ingresos": totals.sales += amount; break;
      case "Costo de ventas": totals.costs += amount; break;
      case "Gastos operacionales": totals.expenses += amount; break;
      default: totals.otherResults += amount; break;
    }
  }
  const grossProfit = totals.sales - totals.costs;
  const operatingProfit = grossProfit - totals.expenses + totals.otherResults;
  return {
    ...totals,
    grossProfit,
    operatingProfit,
    grossMargin: totals.sales ? (grossProfit / totals.sales) * 100 : null,
    operatingMargin: totals.sales ? (operatingProfit / totals.sales) * 100 : null,
  };
}

function dashboardVariance(current: number, previous: number) {
  return previous ? ((current - previous) / Math.abs(previous)) * 100 : null;
}

async function buildDashboardAnalytics(rest: RestClient, entityId: string, asOf: string, sources: JsonRecord[]) {
  const year = Number(asOf.slice(0, 4));
  const currentMonth = Number(asOf.slice(5, 7));
  const yearStart = `${year}-01-01`;
  const priorYear = year - 1;
  const priorAsOf = `${priorYear}${asOf.slice(4)}`;
  const monthRanges = Array.from({ length: currentMonth }, (_, index) => {
    const month = index + 1;
    const monthText = String(month).padStart(2, "0");
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const to = month === currentMonth ? asOf : `${year}-${monthText}-${lastDay}`;
    return { period: `${year}-${monthText}`, label: dashboardMonthLabels[index], from: `${year}-${monthText}-01`, to };
  });

  try {
    const [monthlyRows, previousYearRows, exactCostEntries] = await Promise.all([
      Promise.all(monthRanges.map((month) => rpc(rest, "accounting_income_statement", {
        p_entity_id: entityId,
        p_from: month.from,
        p_to: month.to,
      }))),
      rpc(rest, "accounting_income_statement", {
        p_entity_id: entityId,
        p_from: `${priorYear}-01-01`,
        p_to: priorAsOf,
      }),
      selectRows(rest, `accounting_journal_entries?select=source_document_id&entity_id=eq.${entityId}&status=eq.posted&entry_date=gte.${yearStart}&entry_date=lte.${asOf}&idempotency_key=like.facto-cost:*&source_document_id=not.is.null&limit=5000`),
    ]);

    const monthly = monthRanges.map((month, index) => ({ ...month, ...dashboardIncomeTotals(monthlyRows[index]) }));
    const current = monthly.reduce<DashboardResultTotals>((accumulator, month) => {
      accumulator.sales += month.sales;
      accumulator.costs += month.costs;
      accumulator.expenses += month.expenses;
      accumulator.otherResults += month.otherResults;
      accumulator.grossProfit += month.grossProfit;
      accumulator.operatingProfit += month.operatingProfit;
      return accumulator;
    }, { sales: 0, costs: 0, expenses: 0, otherResults: 0, grossProfit: 0, operatingProfit: 0, grossMargin: null, operatingMargin: null });
    current.grossMargin = current.sales ? (current.grossProfit / current.sales) * 100 : null;
    current.operatingMargin = current.sales ? (current.operatingProfit / current.sales) * 100 : null;

    const previousYear = dashboardIncomeTotals(previousYearRows);
    const salesDocuments = sources.filter((source) => String(source.document_type || "") === "sales_invoice"
      && String(source.issued_on || "") >= yearStart
      && String(source.issued_on || "") <= asOf);
    const exactCostSourceIds = new Set(exactCostEntries.map((entry) => String(entry.source_document_id || "")).filter(Boolean));
    const salesWithExactCost = salesDocuments.filter((document) => exactCostSourceIds.has(String(document.id))).length;

    return {
      available: true,
      year,
      from: yearStart,
      to: asOf,
      monthly,
      current,
      previousYear,
      comparison: {
        sales: dashboardVariance(current.sales, previousYear.sales),
        grossProfit: dashboardVariance(current.grossProfit, previousYear.grossProfit),
        operatingProfit: dashboardVariance(current.operatingProfit, previousYear.operatingProfit),
      },
      costCoverage: {
        totalSalesDocuments: salesDocuments.length,
        salesWithExactCost,
        missingSalesCost: Math.max(0, salesDocuments.length - salesWithExactCost),
        percentage: salesDocuments.length ? (salesWithExactCost / salesDocuments.length) * 100 : 0,
      },
    };
  } catch (error) {
    console.warn("[accounting-center] dashboard analytics unavailable", {
      entityId,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      available: false,
      year,
      from: yearStart,
      to: asOf,
      monthly: [],
      current: dashboardIncomeTotals([]),
      previousYear: dashboardIncomeTotals([]),
      comparison: { sales: null, grossProfit: null, operatingProfit: null },
      costCoverage: { totalSalesDocuments: 0, salesWithExactCost: 0, missingSalesCost: 0, percentage: 0 },
    };
  }
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
  const previousPreview = existingBatch[0] || null;
  if (previousPreview && ["imported", "partial"].includes(String(previousPreview.status))) {
    throw new HttpError(409, "Esta cartola ya fue importada. No se modificó el respaldo ni se duplicaron sus movimientos.");
  }
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
  const batchData = {
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
    updated_at: new Date().toISOString(),
  };
  let batch: JsonRecord;
  if (previousPreview) {
    await deleteRows(rest, "accounting_import_rows", `batch_id=eq.${previousPreview.id}`);
    batch = (await patchRows(rest, "accounting_import_batches", `id=eq.${previousPreview.id}`, batchData))[0];
  } else {
    batch = (await insertRows(rest, "accounting_import_batches", [batchData]))[0];
  }
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
  if (batch.status === "imported") {
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
  const processedImportRowIds: string[] = [];

  if (String(batch.source_type) === "COLLECTIONS") {
    for (const row of importRows) {
      const data = asObject(row.normalized_data);
      let source = findFactoSourceDocument(sourceDocuments, data);
      let target = source
        ? String(data.direction) === "sale" ? receivableBySource.get(String(source.id)) : payableBySource.get(String(source.id))
        : null;
      if (!target && ["sale", "purchase"].includes(String(data.direction || ""))) {
        const created = await ensureFactoWorkbookDocument(rest, entityId, batch, row, data);
        source = created.source;
        target = created.target;
        sourceDocuments.push(source);
        if (String(data.direction) === "sale") receivableBySource.set(String(source.id), target);
        else payableBySource.set(String(source.id), target);
      }
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
      processedImportRowIds.push(String(row.id));
    }
  } else if (String(batch.source_type) === "CHECKS") {
    const result = await consolidateFactoCheckRows(rest, entityId, batchId, importRows, sourceDocuments, receivables);
    imported = result.checks;
    linked = result.linkedAllocations;
    unmatched = result.unmatchedAllocations;
    processedImportRowIds.push(...importRows.map((row) => String(row.id)));
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
  if (String(batch.source_type) === "COLLECTIONS") {
    if (processedImportRowIds.length) {
      await patchRows(rest, "accounting_import_rows", `id=in.(${processedImportRowIds.join(",")})`, { status: "imported" });
    }
  } else {
    await patchRows(rest, "accounting_import_rows", `batch_id=eq.${batchId}&status=eq.new`, { status: "imported" });
  }
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

async function consolidateFactoCheckRows(
  rest: RestClient,
  entityId: string,
  batchId: string,
  importRows: JsonRecord[],
  sourceDocuments: JsonRecord[],
  receivables: JsonRecord[],
) {
  const settlementAccount = await expectedBankAccount(rest, entityId, "BancoEstado");
  const receivableBySource = new Map(receivables.map((row) => [String(row.source_document_id), row]));
  const grouped = new Map<string, JsonRecord[]>();
  for (const row of importRows) {
    const data = asObject(row.normalized_data);
    const key = physicalCheckBusinessKey(data);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }
  const existingChecks = await selectAllRows(rest, `accounting_checks?select=*&entity_id=eq.${entityId}`);
  const usedCheckIds = new Set<string>();
  let linkedAllocations = 0;
  let unmatchedAllocations = 0;
  let consolidatedChecks = 0;

  for (const [sourceBusinessKey, rows] of grouped) {
    const firstRow = rows[0];
    const firstData = asObject(firstRow.normalized_data);
    const sourceRowIds = rows.map((row) => String(row.id));
    const allocations = rows.map((row) => {
      const data = asObject(row.normalized_data);
      const source = findFactoSourceDocument(sourceDocuments, {
        direction: "sale",
        document_type: "sales_invoice",
        document_number: data.source_document_number,
        counterpart_tax_id: data.customer_tax_id,
      });
      const receivable = source ? receivableBySource.get(String(source.id)) : null;
      if (receivable) linkedAllocations += 1;
      else unmatchedAllocations += 1;
      return {
        source_row_id: row.id,
        source_document_number: data.source_document_number || null,
        customer_tax_id: data.customer_tax_id || null,
        receivable_id: receivable?.id || null,
        amount_clp: Math.round(numeric(data.amount_clp) * 10000) / 10000,
      };
    });
    const amountClp = allocations.reduce((sum, allocation) => sum + numeric(allocation.amount_clp), 0);
    if (amountClp <= 0) continue;
    const receivedOn = dateValue(firstData.received_on) || dateValue(firstData.due_on);
    if (!receivedOn) continue;
    const collectedOn = dateValue(firstData.due_on);
    const factoCollected = normalizeText(firstData.source_status).includes("inactivo") && Boolean(collectedOn);
    const legacyKey = checkBusinessKey(firstData.issuer_bank, firstData.check_number);
    let check = existingChecks.find((row) => String(row.source_business_key || "") === sourceBusinessKey);
    if (!check) {
      check = existingChecks.find((row) => sourceRowIds.includes(String(row.source_row_id || "")) && !usedCheckIds.has(String(row.id)));
    }
    if (!check) {
      check = existingChecks.find((row) =>
        checkBusinessKey(row.bank_name, row.check_number) === legacyKey && !usedCheckIds.has(String(row.id))
      );
    }
    const previousMetadata = asObject(check?.metadata);
    const checkPayload = {
      entity_id: entityId,
      receivable_id: allocations.find((allocation) => allocation.receivable_id)?.receivable_id || null,
      customer_name: String(firstData.customer_name || firstData.issuer_name || "Cliente sin identificar"),
      bank_name: String(firstData.issuer_bank || "Banco emisor no informado"),
      check_number: String(firstData.check_number || ""),
      amount_clp: amountClp,
      received_on: receivedOn,
      due_on: collectedOn,
      status: check?.bank_evidence_status === "matched" ? "collected" : factoCollected ? "deposited" : "portfolio",
      import_batch_id: batchId,
      source_row_id: firstRow.id,
      source_business_key: sourceBusinessKey,
      facto_collected_on: collectedOn,
      settlement_bank_account_id: settlementAccount?.id || null,
      source_status: firstData.source_status || null,
      bank_evidence_status: check?.bank_evidence_status || "pending",
      notes: check?.bank_evidence_status === "matched"
        ? "Cobro Facto confirmado por deposito exacto en cartola BancoEstado."
        : factoCollected
        ? "Cobrado/inactivo en Facto; pendiente de confirmar el deposito en cartola BancoEstado."
        : "Cheque informado por Facto; pendiente de cobro y cartola BancoEstado.",
      metadata: {
        ...previousMetadata,
        expected_settlement_institution: "BancoEstado",
        issuer_tax_id: firstData.issuer_tax_id || null,
        customer_tax_id: firstData.customer_tax_id || null,
        detail: firstData.detail || null,
        source_row_ids: sourceRowIds,
        allocations,
        physical_check_rule: "bank+number+received_on+collected_on+customer_tax_id",
      },
      updated_at: new Date().toISOString(),
    };
    if (check) {
      await patchRows(rest, "accounting_checks", `id=eq.${check.id}`, checkPayload);
      check = { ...check, ...checkPayload };
    } else {
      check = (await insertRows(rest, "accounting_checks", [checkPayload]))[0];
      existingChecks.push(check);
    }
    usedCheckIds.add(String(check.id));
    consolidatedChecks += 1;
  }
  return { checks: consolidatedChecks, linkedAllocations, unmatchedAllocations };
}

async function ensureFactoCheckOpeningReceivables(
  rest: RestClient,
  entityId: string,
  batch: JsonRecord,
  importRows: JsonRecord[],
  sourceDocuments: JsonRecord[],
  receivables: JsonRecord[],
) {
  const firstCurrentFolio = sourceDocuments
    .filter((row) => String(row.document_type || "") === "sales_invoice" && String(row.issued_on || "") >= "2026-01-01")
    .map((row) => Number(normalizeDocumentNumber(row.folio)))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right)[0];
  if (!firstCurrentFolio) return [];

  const grouped = new Map<string, JsonRecord[]>();
  for (const row of importRows) {
    const data = asObject(row.normalized_data);
    const folio = normalizeDocumentNumber(data.source_document_number);
    const numericFolio = Number(folio);
    if (!folio || !Number.isFinite(numericFolio) || numericFolio >= firstCurrentFolio) continue;
    const existing = findFactoSourceDocument(sourceDocuments, {
      direction: "sale",
      document_type: "sales_invoice",
      document_number: folio,
      counterpart_tax_id: data.customer_tax_id,
    });
    if (existing) continue;
    const customerTaxId = normalizeTaxForMatch(data.customer_tax_id) || "SIN_RUT";
    const key = `${customerTaxId}|${folio}`;
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }

  const ensured: JsonRecord[] = [];
  for (const [key, rows] of grouped) {
    const firstData = asObject(rows[0].normalized_data);
    const folio = normalizeDocumentNumber(firstData.source_document_number);
    const amountClp = rows.reduce((sum, row) => sum + numeric(asObject(row.normalized_data).amount_clp), 0);
    if (!folio || amountClp <= 0) continue;
    const sourceKey = `facto-check-opening:${key}`;
    const now = new Date().toISOString();
    const [source] = await upsertRowsSelected(rest, "accounting_source_documents", [{
      entity_id: entityId,
      source_type: "EXCEL",
      source_id: String(batch.id),
      source_key: sourceKey,
      document_type: "sales_opening_receivable",
      external_id: sourceKey,
      folio,
      counterpart_tax_id: firstData.customer_tax_id || null,
      counterpart_name: firstData.customer_name || firstData.issuer_name || "Cliente informado por Facto",
      issued_on: "2025-12-31",
      due_on: null,
      currency: "CLP",
      exchange_rate: 1,
      net_amount: 0,
      tax_amount: 0,
      exempt_amount: 0,
      total_amount: amountClp,
      total_clp: amountClp,
      status: "validated",
      data_quality: "validated",
      raw_payload: {
        evidence: "Saldo inicial respaldado por planilla de cheques Facto",
        accounting_date_basis: "2025-12-31 representa apertura; no sustituye la fecha tributaria original",
        first_current_facto_folio: firstCurrentFolio,
        import_batch_id: batch.id,
        import_row_ids: rows.map((row) => row.id),
        normalized_rows: rows.map((row) => asObject(row.normalized_data)),
      },
      observed_at: now,
      updated_at: now,
    }], "entity_id,source_type,source_key", "*");
    if (!source) throw new Error(`No se pudo conservar el saldo inicial Facto ${folio}.`);

    let receivable = receivables.find((row) => String(row.source_document_id) === String(source.id));
    if (!receivable) {
      receivable = (await insertRows(rest, "accounting_receivables", [{
        entity_id: entityId,
        source_document_id: source.id,
        customer_tax_id: firstData.customer_tax_id || null,
        customer_name: firstData.customer_name || firstData.issuer_name || "Cliente informado por Facto",
        document_number: folio,
        issued_on: "2025-12-31",
        due_on: null,
        currency: "CLP",
        exchange_rate: 1,
        original_amount: amountClp,
        original_amount_clp: amountClp,
        paid_amount_clp: 0,
        reported_paid_amount_clp: amountClp,
        reported_balance_clp: 0,
        reported_at: now,
        reported_source_batch_id: batch.id,
        status: "pending",
        notes: "Saldo inicial anterior a 2026, respaldado por cheque cobrado en Facto; fecha tributaria original no disponible en el respaldo.",
        updated_at: now,
      }]))[0];
      receivables.push(receivable);
    } else if (numeric(receivable.original_amount_clp) < amountClp - 0.005) {
      await patchRows(rest, "accounting_receivables", `id=eq.${receivable.id}`, {
        original_amount: amountClp,
        original_amount_clp: amountClp,
        reported_paid_amount_clp: amountClp,
        reported_balance_clp: 0,
        reported_at: now,
        reported_source_batch_id: batch.id,
        updated_at: now,
      });
      receivable.original_amount = amountClp;
      receivable.original_amount_clp = amountClp;
    }
    sourceDocuments.push(source);
    ensured.push({ source, receivable, amount_clp: amountClp });
  }
  return ensured;
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
  const previousReconciliations = await selectRows(
    rest,
    `accounting_reconciliations?select=matched_amount_clp&bank_transaction_id=eq.${transactionId}&status=eq.confirmed&limit=1000`,
  );
  const allocatedAmount = previousReconciliations.reduce((sum, row) => sum + numeric(row.matched_amount_clp), 0);
  const transactionAmount = Math.abs(Number(transaction.amount_clp));
  const remainingAmount = Math.max(transactionAmount - allocatedAmount, 0);
  if (remainingAmount <= 0.5) {
    return { transaction, allocatedAmount, remainingAmount: 0, candidates: [], suggestedPlan: null };
  }
  const candidates = await selectRows(rest, incoming
    ? `accounting_receivables?select=*&entity_id=eq.${entityId}&status=in.(pending,partial,overdue,collections)&limit=1000`
    : `accounting_payables?select=*&entity_id=eq.${entityId}&status=in.(pending,partial,overdue)&limit=1000`);
  const documents: Array<ReconciliationDocumentInput<JsonRecord>> = candidates.map((candidate) => ({
    targetType: incoming ? "receivable" : "payable",
    targetId: String(candidate.id),
    counterpartyName: String(candidate.customer_name || candidate.supplier_name || ""),
    counterpartyTaxId: String(candidate.customer_tax_id || candidate.supplier_tax_id || ""),
    documentNumber: String(candidate.document_number || ""),
    issuedOn: String(candidate.issued_on || ""),
    dueOn: candidate.due_on ? String(candidate.due_on) : null,
    balanceClp: numeric(candidate.balance_clp),
    raw: candidate,
  }));
  const ranked = rankReconciliationCandidates({
    amountClp: transactionAmount,
    transactionDate: String(transaction.transaction_date || ""),
    description: String(transaction.description || ""),
    reference: transaction.reference ? String(transaction.reference) : null,
    operationNumber: transaction.operation_number ? String(transaction.operation_number) : null,
  }, documents, remainingAmount);
  const suggestedPlan = buildSuggestedAllocationPlan(ranked, remainingAmount);
  return {
    transaction,
    allocatedAmount,
    remainingAmount,
    suggestedPlan,
    candidates: ranked.map((item) => ({
      targetType: item.targetType,
      targetId: item.targetId,
      candidate: item.document.raw,
      score: item.score,
      confidence: item.confidence,
      suggestedAmount: item.suggestedAmount,
      evidence: item.evidence,
      dateDifferenceDays: item.dateDifferenceDays,
      signals: item.signals,
    })),
  };
}

async function confirmReconciliation(rest: RestClient, profile: Profile, payload: JsonRecord) {
  const transactionId = requiredUuid(payload.transactionId);
  const links = Array.isArray(payload.links) ? payload.links.map(asObject) : [];
  if (!links.length) throw new HttpError(400, "Selecciona al menos un documento para conciliar.");
  const transaction = (await selectRows(rest, `accounting_bank_transactions?select=*&id=eq.${transactionId}&limit=1`))[0];
  if (!transaction) throw new HttpError(404, "Movimiento bancario no encontrado.");
  const entityId = String(transaction.entity_id);
  const transactionAmount = Math.abs(Number(transaction.amount_clp));
  const expectedTargetType = Number(transaction.amount_clp) > 0 ? "receivable" : "payable";
  const combined = new Map<string, { targetType: string; targetId: string; amount: number }>();
  for (const link of links) {
    const targetType = String(link.targetType);
    if (targetType !== expectedTargetType) throw new HttpError(400, "El tipo de documento no corresponde a la dirección del movimiento bancario.");
    const targetId = requiredUuid(link.targetId);
    const key = `${targetType}:${targetId}`;
    const current = combined.get(key);
    combined.set(key, { targetType, targetId, amount: (current?.amount || 0) + positiveNumber(link.amount) });
  }
  const allocations = [...combined.values()];
  const total = allocations.reduce((sum, link) => sum + link.amount, 0);
  const previousReconciliations = await selectRows(
    rest,
    `accounting_reconciliations?select=matched_amount_clp&bank_transaction_id=eq.${transactionId}&status=eq.confirmed&limit=1000`,
  );
  const previouslyAllocated = previousReconciliations.reduce((sum, row) => sum + numeric(row.matched_amount_clp), 0);
  const availableAmount = Math.max(transactionAmount - previouslyAllocated, 0);
  if (availableAmount <= 0.5) throw new HttpError(409, "El movimiento bancario ya está completamente conciliado.");
  if (total > availableAmount + 0.5) throw new HttpError(400, "La asignación supera el saldo disponible del movimiento bancario.");

  const targetIds = allocations.map((link) => link.targetId);
  const documentTable = expectedTargetType === "receivable" ? "accounting_receivables" : "accounting_payables";
  const documents = await selectRows(rest, `${documentTable}?select=id,original_amount_clp,paid_amount_clp,balance_clp&id=in.(${targetIds.join(",")})&limit=1000`);
  const documentMap = new Map(documents.map((document) => [String(document.id), document]));
  for (const allocation of allocations) {
    const document = documentMap.get(allocation.targetId);
    if (!document) throw new HttpError(404, "Uno de los documentos de conciliación no existe.");
    const balance = numeric(document.balance_clp);
    if (allocation.amount > balance + 0.5) throw new HttpError(400, "Una asignación supera el saldo pendiente del documento.");
  }

  const automaticExact = payload.automation === "exact";
  const reconciliation = (await insertRows(rest, "accounting_reconciliations", [{
    entity_id: entityId,
    bank_transaction_id: transactionId,
    status: "confirmed",
    confidence: automaticExact ? "exact" : "manual",
    score: automaticExact ? 1 : null,
    matched_amount_clp: total,
    explanation: optionalText(payload.note, 500) || (automaticExact
      ? "Conciliación automática exacta revalidada por monto e identidad documental."
      : "Conciliación confirmada por usuario."),
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
    const document = documentMap.get(link.targetId)!;
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
  const allocatedAmount = previouslyAllocated + total;
  await patchRows(rest, "accounting_bank_transactions", `id=eq.${transactionId}`, { reconciliation_status: allocatedAmount >= transactionAmount - 0.5 ? "matched" : "partial", updated_at: new Date().toISOString() });
  await insertRows(rest, "accounting_audit_events", [{
    entity_id: entityId, actor_id: profile.id, action: "reconciliation.confirmed",
    entity_type: "bank_transaction", entity_id_text: transactionId,
    new_value: {
      reconciliation_id: reconciliation.id,
      total,
      previously_allocated: previouslyAllocated,
      allocated_amount: allocatedAmount,
      links: allocations,
      automation: automaticExact ? "exact" : "manual",
    },
  }]);
  return { reconciliation, matched: total, allocated: allocatedAmount, remaining: Math.max(transactionAmount - allocatedAmount, 0) };
}

async function previewExactReconciliations(rest: RestClient, payload: JsonRecord) {
  const entityId = requiredUuid(payload.entityId);
  const from = requiredDate(payload.from);
  const to = requiredDate(payload.to);
  if (from > to) throw new HttpError(400, "La fecha inicial no puede ser posterior a la final.");
  const transactions = await selectAllRows(rest,
    `accounting_bank_transactions?select=*&entity_id=eq.${entityId}&reconciliation_status=eq.unmatched&transaction_date=gte.${from}&transaction_date=lte.${to}&order=transaction_date.asc`,
  );
  const [receivables, payables] = await Promise.all([
    selectAllRows(rest, `accounting_receivables?select=*&entity_id=eq.${entityId}&status=in.(pending,partial,overdue,collections)`),
    selectAllRows(rest, `accounting_payables?select=*&entity_id=eq.${entityId}&status=in.(pending,partial,overdue)`),
  ]);
  const matches: JsonRecord[] = [];
  for (const transaction of transactions) {
    const incoming = numeric(transaction.amount_clp) > 0;
    const documents = reconciliationDocuments(incoming ? receivables : payables, incoming);
    const transactionAmount = Math.abs(numeric(transaction.amount_clp));
    const ranked = rankReconciliationCandidates(reconciliationTransaction(transaction), documents, transactionAmount);
    const selection = selectVerifiedExactAllocation(ranked, transactionAmount);
    if (!selection) continue;
    const primary = selection.candidates[0];
    matches.push({
      transactionId: transaction.id,
      transactionDate: transaction.transaction_date,
      description: transaction.description,
      amountClp: transactionAmount,
      targetType: primary.targetType,
      targetId: primary.targetId,
      documentNumber: selection.candidates.map((candidate) => candidate.document.documentNumber).filter(Boolean).join(", "),
      counterpartyName: primary.document.counterpartyName,
      links: selection.links,
      reason: selection.reason,
    });
  }
  return {
    entityId,
    from,
    to,
    reviewed: transactions.length,
    exact: matches.length,
    untouched: transactions.length - matches.length,
    matches,
    policy: "Solo identidad exacta por RUT o folio: saldo total, abono parcial a un único documento o total exacto de todos los documentos abiertos.",
  };
}

async function confirmExactReconciliations(rest: RestClient, profile: Profile, payload: JsonRecord) {
  const entityId = requiredUuid(payload.entityId);
  const requested = Array.isArray(payload.matches) ? payload.matches.map(asObject) : [];
  if (!requested.length) return { confirmed: 0, skipped: 0, errors: [] };
  let confirmed = 0;
  let skipped = 0;
  const errors: JsonRecord[] = [];
  for (const item of requested.slice(0, 500)) {
    const transactionId = requiredUuid(item.transactionId);
    try {
      const transaction = (await selectRows(rest,
        `accounting_bank_transactions?select=*&id=eq.${transactionId}&entity_id=eq.${entityId}&reconciliation_status=eq.unmatched&limit=1`,
      ))[0];
      if (!transaction) {
        skipped += 1;
        continue;
      }
      const incoming = numeric(transaction.amount_clp) > 0;
      const table = incoming ? "accounting_receivables" : "accounting_payables";
      const rows = await selectAllRows(rest, `${table}?select=*&entity_id=eq.${entityId}&status=in.(${incoming ? "pending,partial,overdue,collections" : "pending,partial,overdue"})`);
      const amount = Math.abs(numeric(transaction.amount_clp));
      const selection = selectVerifiedExactAllocation(
        rankReconciliationCandidates(reconciliationTransaction(transaction), reconciliationDocuments(rows, incoming), amount),
        amount,
      );
      const requestedLinks = (Array.isArray(item.links) ? item.links.map(asObject) : [{
        targetType: item.targetType,
        targetId: item.targetId,
        amount,
      }]).map((link) => ({
        targetType: String(link.targetType || ""),
        targetId: String(link.targetId || ""),
        amount: Math.round(numeric(link.amount) * 100) / 100,
      })).sort((left, right) => `${left.targetType}:${left.targetId}`.localeCompare(`${right.targetType}:${right.targetId}`));
      const verifiedLinks = selection?.links.map((link) => ({
        targetType: link.targetType,
        targetId: link.targetId,
        amount: Math.round(link.amount * 100) / 100,
      })).sort((left, right) => `${left.targetType}:${left.targetId}`.localeCompare(`${right.targetType}:${right.targetId}`)) || [];
      const samePlan = requestedLinks.length === verifiedLinks.length && requestedLinks.every((link, index) =>
        link.targetType === verifiedLinks[index]?.targetType
        && link.targetId === verifiedLinks[index]?.targetId
        && Math.abs(link.amount - (verifiedLinks[index]?.amount || 0)) <= 0.01
      );
      if (!selection || !samePlan) {
        skipped += 1;
        continue;
      }
      await confirmReconciliation(rest, profile, {
        transactionId,
        automation: "exact",
        note: selection.reason,
        links: selection.links,
      });
      confirmed += 1;
    } catch (error) {
      skipped += 1;
      errors.push({ transactionId, error: error instanceof Error ? error.message : "Error inesperado." });
    }
  }
  await rpc(rest, "accounting_refresh_controls", { p_entity_id: entityId });
  return { confirmed, skipped, errors };
}

function reconciliationDocuments(rows: JsonRecord[], incoming: boolean): Array<ReconciliationDocumentInput<JsonRecord>> {
  return rows.map((row) => ({
    targetType: incoming ? "receivable" : "payable",
    targetId: String(row.id),
    counterpartyName: String(row.customer_name || row.supplier_name || ""),
    counterpartyTaxId: String(row.customer_tax_id || row.supplier_tax_id || ""),
    documentNumber: String(row.document_number || ""),
    issuedOn: String(row.issued_on || ""),
    dueOn: row.due_on ? String(row.due_on) : null,
    balanceClp: numeric(row.balance_clp),
    raw: row,
  }));
}

function reconciliationTransaction(row: JsonRecord) {
  return {
    amountClp: Math.abs(numeric(row.amount_clp)),
    transactionDate: String(row.transaction_date || ""),
    description: String(row.description || ""),
    reference: row.reference ? String(row.reference) : null,
    operationNumber: row.operation_number ? String(row.operation_number) : null,
  };
}

async function accountingLedgerCoverage(rest: RestClient, payload: JsonRecord) {
  const entityId = requiredUuid(payload.entityId);
  const from = requiredDate(payload.from);
  const to = requiredDate(payload.to);
  if (from > to) throw new HttpError(400, "La fecha inicial no puede ser posterior a la final.");
  const [documents, entries, reconciliations, bankTransactions] = await Promise.all([
    selectAllRows(rest, `accounting_source_documents?select=id,document_type,total_clp,net_amount,tax_amount,exchange_rate,data_quality,status&entity_id=eq.${entityId}&source_type=eq.FACTO&issued_on=gte.${from}&issued_on=lte.${to}&data_quality=eq.validated`),
    selectAllRows(rest, `accounting_journal_entries?select=id,idempotency_key,status&entity_id=eq.${entityId}&entry_date=gte.${from}&entry_date=lte.${to}&order=id.asc`),
    selectAllRows(rest, `accounting_reconciliations?select=id,bank_transaction_id,matched_amount_clp,status,accounting_bank_transactions!inner(transaction_date)&entity_id=eq.${entityId}&status=eq.confirmed&accounting_bank_transactions.transaction_date=gte.${from}&accounting_bank_transactions.transaction_date=lte.${to}`),
    selectAllRows(rest, `accounting_bank_transactions?select=id,amount_clp,reconciliation_status&entity_id=eq.${entityId}&transaction_date=gte.${from}&transaction_date=lte.${to}&reconciliation_status=neq.ignored`),
  ]);
  const entryKeys = new Set(entries.map((entry) => String(entry.idempotency_key || "")));
  const missingFacto = documents.filter((document) => !entryKeys.has(`facto-document:${document.id}`));
  const missingReconciliations = reconciliations.filter((row) => !entryKeys.has(`bank-reconciliation:${row.id}`));
  const directlyPostedByTransaction = postedReconciliationAmounts(reconciliations, entryKeys);
  const missingBankTransactions = bankTransactions.filter((transaction) => {
    if (entryKeys.has(`bank-transaction:${transaction.id}`)) return false;
    return bankStageAmount(transaction, directlyPostedByTransaction) > 0.005;
  });
  const sales = documents.filter((document) => String(document.document_type || "").startsWith("sales_"));
  const purchases = documents.filter((document) => String(document.document_type || "").startsWith("purchase_"));
  const documentarySalesClp = sales.reduce((sum, document) => sum + signedDocumentAmount(document), 0);
  const documentaryPurchasesClp = purchases.reduce((sum, document) => sum + signedDocumentAmount(document), 0);
  return {
    entityId,
    from,
    to,
    factoDocuments: documents.length,
    factoDocumentsPending: missingFacto.length,
    confirmedReconciliations: reconciliations.length,
    reconciliationsPending: missingReconciliations.length,
    bankTransactions: bankTransactions.length,
    bankTransactionsPending: missingBankTransactions.length,
    postedEntries: entries.filter((entry) => ["posted", "reversed"].includes(String(entry.status))).length,
    unmatchedBankTransactions: bankTransactions.filter((transaction) => ["unmatched", "partial"].includes(String(transaction.reconciliation_status))).length,
    documentarySalesClp,
    documentaryPurchasesClp,
    documentaryDifferenceClp: documentarySalesClp - documentaryPurchasesClp,
    profitabilityCertified: false,
    profitabilityNote: "La diferencia documental no es utilidad neta. Las compras quedan en una cuenta transitoria hasta clasificar inventario, costo de venta y gastos devengados.",
    complete: missingFacto.length === 0 && missingReconciliations.length === 0 && missingBankTransactions.length === 0,
  };
}

async function accruePayroll(rest: RestClient, profile: Profile, payload: JsonRecord) {
  const entityId = requiredUuid(payload.entityId);
  const requested = Array.isArray(payload.periods) ? payload.periods.map(asObject) : [];
  if (!requested.length) throw new HttpError(400, "Debes indicar al menos un período de remuneraciones.");
  const [accounts, periods] = await Promise.all([
    selectAllRows(rest, `accounting_accounts?select=id,classification&entity_id=eq.${entityId}&active=eq.true&allows_posting=eq.true`),
    selectAllRows(rest, `accounting_periods?select=id,starts_on,ends_on,status&entity_id=eq.${entityId}&status=neq.closed`),
  ]);
  const accountByClassification = new Map(accounts.map((account) => [String(account.classification), String(account.id)]));
  const results: JsonRecord[] = [];
  for (const row of requested) {
    const period = requiredText(row.period, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new HttpError(400, `Período de remuneraciones inválido: ${period}.`);
    const [year, month] = period.split("-").map(Number);
    const date = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const gross = Math.round(Math.abs(numeric(row.grossClp)) * 10000) / 10000;
    const net = Math.round(Math.abs(numeric(row.netClp)) * 10000) / 10000;
    const employer = Math.round(Math.abs(numeric(row.employerContributionsClp)) * 10000) / 10000;
    if (gross <= 0 || net <= 0 || net > gross) throw new HttpError(400, `Montos de remuneraciones inválidos para ${period}.`);
    const withholdings = Math.round((gross - net + employer) * 10000) / 10000;
    const source = (await upsertRows(rest, "accounting_source_documents", [{
      entity_id: entityId,
      source_type: "SYSTEM",
      source_id: period,
      source_key: `payroll:${period}`,
      document_type: "payroll_settlement",
      external_id: `REM-${period}`,
      folio: `REM-${period}`,
      counterpart_name: optionalText(row.employeeName, 160) || "Personal de la empresa",
      issued_on: date,
      due_on: date,
      currency: "CLP",
      exchange_rate: 1,
      net_amount: gross,
      tax_amount: 0,
      exempt_amount: employer,
      total_amount: gross + employer,
      total_clp: gross + employer,
      status: "validated",
      data_quality: "validated",
      raw_payload: {
        period,
        gross_clp: gross,
        net_clp: net,
        employer_contributions_clp: employer,
        payroll_withholdings_clp: withholdings,
        evidence: optionalText(row.evidence, 500) || null,
        health_basis: optionalText(row.healthBasis, 80) || null,
        accounting_policy: "payroll_accrual_from_verified_payslip",
      },
      source_created_at: new Date().toISOString(),
      source_updated_at: new Date().toISOString(),
      observed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }], "entity_id,source_type,source_key"))[0];
    await postAutomatedEntry(rest, profile, {
      entityId,
      periodId: periodForDate(periods, date),
      date,
      description: `Devengo de remuneraciones ${period}`,
      reference: `REM-${period}`,
      sourceType: "SYSTEM",
      sourceDocumentId: String(source.id),
      idempotencyKey: `payroll-accrual:${period}`,
      currency: "CLP",
      exchangeRate: 1,
      lines: [
        postingLine(accountByClassification, "payroll_expense", gross, 0, `Remuneración imponible ${period}`),
        postingLine(accountByClassification, "payroll_employer_expense", employer, 0, `Cargas patronales ${period}`),
        postingLine(accountByClassification, "payroll_payable", 0, net, `Remuneración líquida por pagar ${period}`),
        postingLine(accountByClassification, "payroll_withholdings", 0, withholdings, `Cotizaciones y retenciones por pagar ${period}`),
      ],
    });
    results.push({ period, grossClp: gross, netClp: net, employerContributionsClp: employer, withholdingsClp: withholdings });
  }
  await rpc(rest, "accounting_refresh_controls", { p_entity_id: entityId });
  return { accrued: results.length, periods: results };
}

async function postVerifiedBankClassifications(rest: RestClient, profile: Profile, payload: JsonRecord) {
  const entityId = requiredUuid(payload.entityId);
  const from = requiredDate(payload.from);
  const to = requiredDate(payload.to);
  if (from > to) throw new HttpError(400, "La fecha inicial no puede ser posterior a la final.");
  const [accounts, periods, transactions, entries, payrollSources] = await Promise.all([
    selectAllRows(rest, `accounting_accounts?select=id,classification&entity_id=eq.${entityId}&active=eq.true&allows_posting=eq.true`),
    selectAllRows(rest, `accounting_periods?select=id,starts_on,ends_on,status&entity_id=eq.${entityId}&status=neq.closed`),
    selectAllRows(rest, `accounting_bank_transactions?select=*&entity_id=eq.${entityId}&transaction_date=gte.${from}&transaction_date=lte.${to}&reconciliation_status=eq.unmatched&order=transaction_date.asc,created_at.asc,id.asc`),
    selectAllRows(rest, `accounting_journal_entries?select=id,idempotency_key,status&entity_id=eq.${entityId}&status=in.(posted,reversed)&order=id.asc`),
    selectAllRows(rest, `accounting_source_documents?select=id,issued_on,due_on&entity_id=eq.${entityId}&document_type=eq.payroll_settlement&data_quality=eq.validated&order=issued_on.desc`),
  ]);
  const accountByClassification = new Map(accounts.map((account) => [String(account.classification), String(account.id)]));
  const entryKeys = new Set(entries.map((entry) => String(entry.idempotency_key || "")));
  const payrollBalances = await currentAccountCreditBalances(rest, entityId, accountByClassification, [
    "payroll_payable",
    "payroll_withholdings",
  ]);
  const lastPayrollDate = payrollSources.reduce((latest, row) => {
    const candidate = String(row.due_on || row.issued_on || "");
    return candidate > latest ? candidate : latest;
  }, "");
  const payrollPaymentCutoff = lastPayrollDate
    ? new Date(`${lastPayrollDate}T00:00:00.000Z`).getTime() + 31 * 86400000
    : 0;
  let payrollPosted = 0;
  let payrollAmountClp = 0;
  const payrollDetails: JsonRecord[] = [];
  for (const transaction of transactions) {
    if (numeric(transaction.amount_clp) >= 0) continue;
    const normalized = normalizeText(transaction.description);
    const classification = normalized.includes("previred")
      ? "payroll_withholdings"
      : /\b(sueldo|sueldos|remuneracion|remuneraciones|nomina|payroll)\b/.test(normalized)
      ? "payroll_payable"
      : "";
    if (!classification) continue;
    if (payrollPaymentCutoff && new Date(`${transaction.transaction_date}T00:00:00.000Z`).getTime() > payrollPaymentCutoff) continue;
    const idempotencyKey = `bank-payroll-settlement:${transaction.id}:${classification}`;
    if (entryKeys.has(idempotencyKey)) continue;
    const available = Math.max(0, payrollBalances.get(classification) || 0);
    const amount = Math.round(Math.min(Math.abs(numeric(transaction.amount_clp)), available) * 10000) / 10000;
    if (amount <= 0.005) continue;
    await postAutomatedEntry(rest, profile, {
      entityId,
      periodId: periodForDate(periods, String(transaction.transaction_date)),
      date: String(transaction.transaction_date),
      description: classification === "payroll_withholdings"
        ? "Pago previsional verificado en cartola bancaria"
        : "Pago de remuneración identificado explícitamente en cartola bancaria",
      reference: String(transaction.operation_number || transaction.reference || transaction.id),
      sourceType: "SYSTEM",
      sourceDocumentId: null,
      idempotencyKey,
      currency: String(transaction.currency || "CLP"),
      exchangeRate: Math.max(numeric(transaction.exchange_rate), 1),
      lines: [
        postingLine(accountByClassification, classification, amount, 0, "Disminución de obligación laboral verificada"),
        postingLine(accountByClassification, "suspense_asset", 0, amount, "Liberación de egreso bancario transitorio"),
      ],
    });
    payrollBalances.set(classification, Math.max(0, available - amount));
    payrollPosted += 1;
    payrollAmountClp += amount;
    payrollDetails.push({ transactionId: transaction.id, classification, amountClp: amount });
    entryKeys.add(idempotencyKey);
    await markBankTransactionClassified(rest, transaction, amount, classification, "verified_payroll_description");
  }

  const ownCompanyTransactions = transactions.filter((transaction) => isOwnCompanyBankTransfer(transaction));
  const incoming = ownCompanyTransactions.filter((transaction) => numeric(transaction.amount_clp) > 0);
  const outgoing = ownCompanyTransactions.filter((transaction) => numeric(transaction.amount_clp) < 0);
  const candidates = outgoing.map((debit) => ({
    debit,
    credits: incoming.filter((credit) =>
      String(credit.transaction_date) === String(debit.transaction_date)
      && String(credit.bank_account_id) !== String(debit.bank_account_id)
      && Math.abs(Math.abs(numeric(credit.amount_clp)) - Math.abs(numeric(debit.amount_clp))) <= 0.005
    ),
  })).filter((candidate) => candidate.credits.length === 1);
  let transfersPosted = 0;
  let transfersAmountClp = 0;
  const transferDetails: JsonRecord[] = [];
  for (const candidate of candidates) {
    const credit = candidate.credits[0];
    const reverseCount = outgoing.filter((debit) =>
      String(debit.transaction_date) === String(credit.transaction_date)
      && String(debit.bank_account_id) !== String(credit.bank_account_id)
      && Math.abs(Math.abs(numeric(debit.amount_clp)) - Math.abs(numeric(credit.amount_clp))) <= 0.005
    ).length;
    if (reverseCount !== 1) continue;
    const ids = [String(candidate.debit.id), String(credit.id)].sort();
    const idempotencyKey = `bank-internal-transfer:${ids.join(":")}`;
    if (entryKeys.has(idempotencyKey)) continue;
    const amount = Math.round(Math.abs(numeric(candidate.debit.amount_clp)) * 10000) / 10000;
    await postAutomatedEntry(rest, profile, {
      entityId,
      periodId: periodForDate(periods, String(candidate.debit.transaction_date)),
      date: String(candidate.debit.transaction_date),
      description: "Transferencia interna verificada entre cuentas de la empresa",
      reference: ids.join(" / "),
      sourceType: "SYSTEM",
      sourceDocumentId: null,
      idempotencyKey,
      currency: "CLP",
      exchangeRate: 1,
      lines: [
        postingLine(accountByClassification, "suspense_liability", amount, 0, "Liberación de ingreso por transferencia interna"),
        postingLine(accountByClassification, "suspense_asset", 0, amount, "Liberación de egreso por transferencia interna"),
      ],
    });
    await Promise.all([
      markBankTransactionClassified(rest, candidate.debit, amount, "internal_transfer", "exact_own_company_pair"),
      markBankTransactionClassified(rest, credit, amount, "internal_transfer", "exact_own_company_pair"),
    ]);
    transfersPosted += 1;
    transfersAmountClp += amount;
    transferDetails.push({ outgoingTransactionId: candidate.debit.id, incomingTransactionId: credit.id, amountClp: amount });
    entryKeys.add(idempotencyKey);
  }
  await rpc(rest, "accounting_refresh_controls", { p_entity_id: entityId });
  return {
    entityId,
    payroll: { posted: payrollPosted, amountClp: payrollAmountClp, details: payrollDetails },
    internalTransfers: { posted: transfersPosted, amountClp: transfersAmountClp, details: transferDetails },
    safeguards: {
      payroll: "Sólo PREVIRED o texto explícito de sueldo/remuneración, limitado al pasivo devengado y a la ventana de pago.",
      internalTransfers: "Mismo día, mismo monto, cuentas distintas, identificación propia en ambos lados y coincidencia única.",
    },
  };
}

async function currentAccountCreditBalances(
  rest: RestClient,
  entityId: string,
  accounts: Map<string, string>,
  classifications: string[],
) {
  const result = new Map<string, number>();
  for (const classification of classifications) {
    const accountId = postingAccount(accounts, classification);
    const lines = await selectAllRows(rest,
      `accounting_journal_lines?select=debit_clp,credit_clp,accounting_journal_entries!inner(entity_id,status)&account_id=eq.${accountId}&accounting_journal_entries.entity_id=eq.${entityId}&accounting_journal_entries.status=in.(posted,reversed)&order=id.asc`,
    );
    result.set(classification, Math.round(lines.reduce((sum, line) => sum + numeric(line.credit_clp) - numeric(line.debit_clp), 0) * 10000) / 10000);
  }
  return result;
}

function isOwnCompanyBankTransfer(transaction: JsonRecord) {
  const description = normalizeText(transaction.description);
  return description.includes("77724382 9") || description.includes("importadora latin chile");
}

async function markBankTransactionClassified(
  rest: RestClient,
  transaction: JsonRecord,
  classifiedAmount: number,
  classification: string,
  policy: string,
) {
  const total = Math.abs(numeric(transaction.amount_clp));
  const full = Math.abs(total - classifiedAmount) <= 0.005;
  const metadata = asObject(transaction.metadata);
  await patchRows(rest, "accounting_bank_transactions", `id=eq.${transaction.id}`, {
    reconciliation_status: full ? "matched" : "partial",
    metadata: {
      ...metadata,
      verified_classification: classification,
      classified_amount_clp: classifiedAmount,
      classification_policy: policy,
      classified_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  });
}

async function prepareAccountingLedger(rest: RestClient, profile: Profile, payload: JsonRecord) {
  const entityId = requiredUuid(payload.entityId);
  const from = requiredDate(payload.from);
  const to = requiredDate(payload.to);
  const batchSize = Math.min(Math.max(Math.trunc(numeric(payload.batchSize) || 50), 1), 200);
  const [documents, reconciliations, bankTransactions, entries, accounts, periods, bankAccounts] = await Promise.all([
    selectAllRows(rest, `accounting_source_documents?select=*&entity_id=eq.${entityId}&source_type=eq.FACTO&issued_on=gte.${from}&issued_on=lte.${to}&data_quality=eq.validated&order=issued_on.asc`),
    selectAllRows(rest, `accounting_reconciliations?select=*,accounting_bank_transactions!inner(*)&entity_id=eq.${entityId}&status=eq.confirmed&accounting_bank_transactions.transaction_date=gte.${from}&accounting_bank_transactions.transaction_date=lte.${to}&order=confirmed_at.asc`),
    selectAllRows(rest, `accounting_bank_transactions?select=*&entity_id=eq.${entityId}&transaction_date=gte.${from}&transaction_date=lte.${to}&reconciliation_status=neq.ignored&order=transaction_date.asc,created_at.asc`),
    selectAllRows(rest, `accounting_journal_entries?select=id,idempotency_key,status&entity_id=eq.${entityId}&entry_date=gte.${from}&entry_date=lte.${to}&order=id.asc`),
    selectAllRows(rest, `accounting_accounts?select=id,classification,active,allows_posting&entity_id=eq.${entityId}&active=eq.true&allows_posting=eq.true`),
    selectAllRows(rest, `accounting_periods?select=id,starts_on,ends_on,status&entity_id=eq.${entityId}&status=neq.closed`),
    selectAllRows(rest, `accounting_bank_accounts?select=id,ledger_account_id&entity_id=eq.${entityId}`),
  ]);
  const entryKeys = new Set(entries.map((entry) => String(entry.idempotency_key || "")));
  const accountByClassification = new Map(accounts.map((account) => [String(account.classification), String(account.id)]));
  const bankLedgerById = new Map(bankAccounts.map((account) => [String(account.id), String(account.ledger_account_id)]));
  const directlyPostedByTransaction = postedReconciliationAmounts(reconciliations, entryKeys);
  const pending: Array<{ type: "document" | "bank_transaction" | "reconciliation"; row: JsonRecord; amountClp?: number }> = [
    ...documents.filter((row) => !entryKeys.has(`facto-document:${row.id}`)).map((row) => ({ type: "document" as const, row })),
    ...bankTransactions
      .filter((row) => !entryKeys.has(`bank-transaction:${row.id}`))
      .map((row) => ({ type: "bank_transaction" as const, row, amountClp: bankStageAmount(row, directlyPostedByTransaction) }))
      .filter((item) => numeric(item.amountClp) > 0.005),
    ...reconciliations.filter((row) => !entryKeys.has(`bank-reconciliation:${row.id}`)).map((row) => ({ type: "reconciliation" as const, row })),
  ];
  let posted = 0;
  let skipped = 0;
  const errors: JsonRecord[] = [];
  for (const item of pending.slice(0, batchSize)) {
    try {
      if (item.type === "document") {
        await postFactoDocument(rest, profile, item.row, periods, accountByClassification);
      } else if (item.type === "bank_transaction") {
        await postBankTransaction(rest, profile, item.row, numeric(item.amountClp), periods, bankLedgerById, accountByClassification);
      } else {
        await postConfirmedReconciliation(rest, profile, item.row, periods, bankLedgerById, accountByClassification);
      }
      posted += 1;
    } catch (error) {
      skipped += 1;
      errors.push({ type: item.type, id: item.row.id, error: error instanceof Error ? error.message : "Error inesperado." });
    }
  }
  const remaining = Math.max(pending.length - posted, 0);
  let bankBalanceAdjustments = 0;
  if (remaining === 0 && skipped === 0) {
    bankBalanceAdjustments = await postBankBalanceAdjustments(
      rest, profile, entityId, bankTransactions, periods, bankLedgerById, accountByClassification,
    );
  }
  await rpc(rest, "accounting_refresh_controls", { p_entity_id: entityId });
  return {
    posted,
    skipped,
    errors,
    remaining,
    bankBalanceAdjustments,
    coverage: await accountingLedgerCoverage(rest, { entityId, from, to }),
  };
}

function postedReconciliationAmounts(reconciliations: JsonRecord[], entryKeys: Set<string>) {
  const totals = new Map<string, number>();
  for (const reconciliation of reconciliations) {
    if (!entryKeys.has(`bank-reconciliation:${reconciliation.id}`)) continue;
    const transactionId = String(reconciliation.bank_transaction_id || "");
    if (!transactionId) continue;
    totals.set(transactionId, (totals.get(transactionId) || 0) + Math.abs(numeric(reconciliation.matched_amount_clp)));
  }
  return totals;
}

function bankStageAmount(transaction: JsonRecord, directlyPostedByTransaction: Map<string, number>) {
  const total = Math.abs(numeric(transaction.amount_clp));
  const alreadyPosted = directlyPostedByTransaction.get(String(transaction.id || "")) || 0;
  return Math.max(Math.round((total - alreadyPosted) * 10000) / 10000, 0);
}

async function postFactoDocument(
  rest: RestClient,
  profile: Profile,
  document: JsonRecord,
  periods: JsonRecord[],
  accounts: Map<string, string>,
) {
  const type = String(document.document_type || "");
  const sale = type.startsWith("sales_");
  const purchase = type.startsWith("purchase_");
  if (!sale && !purchase) throw new Error(`Tipo Facto no soportado: ${type || "sin tipo"}.`);
  const total = Math.round(Math.abs(numeric(document.total_clp)) * 10000) / 10000;
  if (total <= 0) throw new Error("El documento no tiene total CLP válido.");
  const exchangeRate = Math.max(numeric(document.exchange_rate), 1);
  const tax = Math.min(total, Math.max(0, Math.round(numeric(document.tax_amount) * exchangeRate * 10000) / 10000));
  const economic = Math.round((total - tax) * 10000) / 10000;
  const creditNote = type.includes("credit_note");
  const lines: Array<{ accountId: string; debit: number; credit: number; description: string }> = [];
  if (sale) {
    lines.push(postingLine(accounts, "receivables", creditNote ? 0 : total, creditNote ? total : 0, "Cliente / documento por cobrar"));
    if (economic > 0) lines.push(postingLine(accounts, "net_sales", creditNote ? economic : 0, creditNote ? 0 : economic, "Venta neta Facto"));
    if (tax > 0) lines.push(postingLine(accounts, "vat_debit", creditNote ? tax : 0, creditNote ? 0 : tax, "IVA débito fiscal Facto"));
  } else {
    if (economic > 0) lines.push(postingLine(accounts, "suspense_asset", creditNote ? 0 : economic, creditNote ? economic : 0, "Compra pendiente de clasificación contable"));
    if (tax > 0) lines.push(postingLine(accounts, "vat_credit", creditNote ? 0 : tax, creditNote ? tax : 0, "IVA crédito fiscal Facto"));
    lines.push(postingLine(accounts, "payables", creditNote ? total : 0, creditNote ? 0 : total, "Proveedor / documento por pagar"));
  }
  await postAutomatedEntry(rest, profile, {
    entityId: String(document.entity_id),
    periodId: periodForDate(periods, String(document.issued_on)),
    date: String(document.issued_on),
    description: `${creditNote ? "Nota de crédito" : sale ? "Venta" : "Compra"} Facto ${String(document.folio || document.external_id || "")}`.trim(),
    reference: String(document.folio || document.external_id || document.id),
    sourceType: "FACTO",
    sourceDocumentId: String(document.id),
    idempotencyKey: `facto-document:${document.id}`,
    currency: String(document.currency || "CLP"),
    exchangeRate,
    lines,
  });
}

async function postFactoCostEntry(
  rest: RestClient,
  profile: Profile,
  requestId: string,
  payload: JsonRecord,
) {
  const entityId = requiredUuid(payload.entityId);
  const sourceDocumentId = requiredUuid(payload.sourceDocumentId);
  const amountClp = Math.round(Math.abs(numeric(payload.amountClp)) * 10000) / 10000;
  if (amountClp <= 0) throw new HttpError(400, "El costo de venta Facto debe ser mayor que cero.");

  const document = (await selectRows(
    rest,
    `accounting_source_documents?select=*&id=eq.${sourceDocumentId}&entity_id=eq.${entityId}&source_type=eq.FACTO&limit=1`,
  ))[0];
  if (!document) throw new HttpError(404, "No se encontró el documento Facto asociado al asiento.");
  const documentType = String(document.document_type || "");
  if (!documentType.startsWith("sales_")) {
    throw new HttpError(409, "El costo de venta solo puede asociarse a un documento de venta Facto.");
  }

  const [periods, accounts] = await Promise.all([
    selectRows(rest, `accounting_periods?select=*&entity_id=eq.${entityId}&status=in.(open,review)&order=starts_on.asc`),
    selectRows(rest, `accounting_accounts?select=id,classification&entity_id=eq.${entityId}&active=eq.true`),
  ]);
  const accountByClassification = new Map(
    accounts.map((account) => [String(account.classification), String(account.id)]),
  );
  const issuedOn = requiredDate(document.issued_on);
  const creditNote = documentType.includes("credit_note");
  const evidence = optionalText(payload.evidence, 500) || "Asiento contable Facto verificado por administración";
  const idempotencyKey = `facto-cost:${sourceDocumentId}`;
  const existingEntry = (await selectRows(
    rest,
    `accounting_journal_entries?select=id,status&entity_id=eq.${entityId}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`,
  ))[0];
  if (existingEntry) {
    return {
      entryId: existingEntry.id,
      sourceDocumentId,
      folio: document.folio,
      amountClp,
      status: existingEntry.status,
      existing: true,
    };
  }
  const lines = creditNote
    ? [
      {
        ...postingLine(accountByClassification, "inventory", amountClp, 0, "Reverso de inventario por nota de crédito Facto"),
        metadata: { facto_account_code: "1201", evidence },
      },
      {
        ...postingLine(accountByClassification, "cost_of_sales", 0, amountClp, "Reverso de costo de venta Facto"),
        metadata: { facto_account_code: "5101", evidence },
      },
    ]
    : [
      {
        ...postingLine(accountByClassification, "cost_of_sales", amountClp, 0, "Costo de ventas de mercaderías Facto"),
        metadata: { facto_account_code: "5101", evidence },
      },
      {
        ...postingLine(accountByClassification, "inventory", 0, amountClp, "Salida de inventario de mercaderías Facto"),
        metadata: { facto_account_code: "1201", evidence },
      },
    ];
  const entry = await postAutomatedEntry(rest, profile, {
    entityId,
    periodId: periodForDate(periods, issuedOn),
    date: issuedOn,
    description: `${creditNote ? "Reverso de costo" : "Costo de venta"} Facto ${String(document.folio || document.external_id || "")}`.trim(),
    reference: String(document.folio || document.external_id || sourceDocumentId),
    sourceType: "FACTO",
    sourceDocumentId,
    sourceModule: "facto_accounting_entry",
    idempotencyKey,
    currency: "CLP",
    exchangeRate: 1,
    lines,
  });
  await insertRows(rest, "accounting_audit_events", [{
    entity_id: entityId,
    actor_id: profile.id,
    action: "facto.cost_entry_imported",
    entity_type: "journal_entry",
    entity_id_text: String(entry.id),
    correlation_id: requestIdToUuid(requestId),
    new_value: {
      source_document_id: sourceDocumentId,
      folio: document.folio || null,
      amount_clp: amountClp,
      source_module: "facto_accounting_entry",
      evidence,
    },
  }]);
  await rpc(rest, "accounting_refresh_controls", { p_entity_id: entityId });
  return { entryId: entry.id, sourceDocumentId, folio: document.folio, amountClp, status: "posted", existing: false };
}

async function postBankTransaction(
  rest: RestClient,
  profile: Profile,
  transaction: JsonRecord,
  stageAmountClp: number,
  periods: JsonRecord[],
  bankLedgerById: Map<string, string>,
  accounts: Map<string, string>,
) {
  const amount = Math.round(Math.abs(stageAmountClp) * 10000) / 10000;
  if (amount <= 0) throw new Error("El movimiento bancario no tiene monto pendiente válido.");
  const incoming = numeric(transaction.amount_clp) > 0;
  const bankAccount = bankLedgerById.get(String(transaction.bank_account_id || ""));
  if (!bankAccount) throw new Error("La cuenta bancaria no tiene cuenta contable asociada.");
  const suspense = postingAccount(accounts, incoming ? "suspense_liability" : "suspense_asset");
  const lines = incoming
    ? [
      { accountId: bankAccount, debit: amount, credit: 0, description: "Ingreso bancario pendiente de clasificar" },
      { accountId: suspense, debit: 0, credit: amount, description: "Contrapartida transitoria de ingreso bancario" },
    ]
    : [
      { accountId: suspense, debit: amount, credit: 0, description: "Contrapartida transitoria de egreso bancario" },
      { accountId: bankAccount, debit: 0, credit: amount, description: "Egreso bancario pendiente de clasificar" },
    ];
  await postAutomatedEntry(rest, profile, {
    entityId: String(transaction.entity_id),
    periodId: periodForDate(periods, String(transaction.transaction_date)),
    date: String(transaction.transaction_date),
    description: `Movimiento bancario pendiente: ${String(transaction.description || "Sin descripción")}`.slice(0, 500),
    reference: String(transaction.operation_number || transaction.reference || transaction.id),
    sourceType: "SYSTEM",
    sourceDocumentId: null,
    idempotencyKey: `bank-transaction:${transaction.id}`,
    currency: String(transaction.currency || "CLP"),
    exchangeRate: Math.max(numeric(transaction.exchange_rate), 1),
    lines,
  });
}

async function postConfirmedReconciliation(
  rest: RestClient,
  profile: Profile,
  reconciliation: JsonRecord,
  periods: JsonRecord[],
  bankLedgerById: Map<string, string>,
  accounts: Map<string, string>,
) {
  const transaction = asObject(reconciliation.accounting_bank_transactions);
  const amount = Math.round(numeric(reconciliation.matched_amount_clp) * 10000) / 10000;
  if (amount <= 0) throw new Error("La conciliación no tiene monto válido.");
  const incoming = numeric(transaction.amount_clp) > 0;
  const bankAccount = bankLedgerById.get(String(transaction.bank_account_id || ""));
  if (!bankAccount) throw new Error("La cuenta bancaria no tiene cuenta contable asociada.");
  const staged = (await selectRows(rest,
    `accounting_journal_entries?select=id&entity_id=eq.${reconciliation.entity_id}&idempotency_key=eq.${encodeURIComponent(`bank-transaction:${transaction.id}`)}&status=in.(posted,reversed)&limit=1`,
  ))[0];
  const counterpart = postingAccount(accounts, incoming ? "receivables" : "payables");
  const lines = staged
    ? incoming
      ? [
        postingLine(accounts, "suspense_liability", amount, 0, "Liberación de ingreso bancario transitorio"),
        { accountId: counterpart, debit: 0, credit: amount, description: "Cobro de cuenta por cobrar" },
      ]
      : [
        { accountId: counterpart, debit: amount, credit: 0, description: "Pago de cuenta por pagar" },
        postingLine(accounts, "suspense_asset", 0, amount, "Liberación de egreso bancario transitorio"),
      ]
    : incoming
    ? [
      { accountId: bankAccount, debit: amount, credit: 0, description: "Ingreso bancario conciliado" },
      { accountId: counterpart, debit: 0, credit: amount, description: "Cobro de cuenta por cobrar" },
    ]
    : [
      { accountId: counterpart, debit: amount, credit: 0, description: "Pago de cuenta por pagar" },
      { accountId: bankAccount, debit: 0, credit: amount, description: "Egreso bancario conciliado" },
    ];
  await postAutomatedEntry(rest, profile, {
    entityId: String(reconciliation.entity_id),
    periodId: periodForDate(periods, String(transaction.transaction_date)),
    date: String(transaction.transaction_date),
    description: staged
      ? incoming ? "Aplicación de cobro bancario conciliado" : "Aplicación de pago bancario conciliado"
      : incoming ? "Cobro bancario conciliado" : "Pago bancario conciliado",
    reference: String(transaction.operation_number || transaction.reference || reconciliation.id),
    sourceType: "SYSTEM",
    sourceDocumentId: null,
    idempotencyKey: `bank-reconciliation:${reconciliation.id}`,
    currency: String(transaction.currency || "CLP"),
    exchangeRate: Math.max(numeric(transaction.exchange_rate), 1),
    lines,
  });
}

async function postBankBalanceAdjustments(
  rest: RestClient,
  profile: Profile,
  entityId: string,
  transactions: JsonRecord[],
  periods: JsonRecord[],
  bankLedgerById: Map<string, string>,
  accounts: Map<string, string>,
) {
  const latestByBank = new Map<string, JsonRecord>();
  for (const transaction of transactions) {
    if (transaction.balance === null || transaction.balance === undefined || transaction.balance === "") continue;
    const bankId = String(transaction.bank_account_id || "");
    if (!bankId) continue;
    const current = latestByBank.get(bankId);
    const key = bankTransactionSequence(transaction);
    const currentKey = current ? bankTransactionSequence(current) : "";
    if (!current || key >= currentKey) latestByBank.set(bankId, transaction);
  }
  let posted = 0;
  for (const [bankId, transaction] of latestByBank) {
    const bankAccount = bankLedgerById.get(bankId);
    if (!bankAccount) continue;
    const idempotencyKey = `bank-statement-balance:v2:${bankId}:${transaction.id}`;
    const existing = await selectRows(rest,
      `accounting_journal_entries?select=id&entity_id=eq.${entityId}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`,
    );
    if (existing[0]) continue;
    const statementDate = String(transaction.transaction_date || "");
    const lines = await selectAllRows(rest,
      `accounting_journal_lines?select=id,debit_clp,credit_clp,accounting_journal_entries!inner(entry_date,status,entity_id)&account_id=eq.${bankAccount}&accounting_journal_entries.entity_id=eq.${entityId}&accounting_journal_entries.status=in.(posted,reversed)&accounting_journal_entries.entry_date=lte.${statementDate}&order=id.asc`,
    );
    const ledgerBalance = lines.reduce((sum, line) => sum + numeric(line.debit_clp) - numeric(line.credit_clp), 0);
    const statementBalance = Math.round(numeric(transaction.balance) * Math.max(numeric(transaction.exchange_rate), 1) * 10000) / 10000;
    const difference = Math.round((statementBalance - ledgerBalance) * 10000) / 10000;
    if (Math.abs(difference) < 0.5) continue;
    const adjustmentLines = difference > 0
      ? [
        { accountId: bankAccount, debit: difference, credit: 0, description: "Ajuste controlado a saldo de cartola" },
        postingLine(accounts, "suspense_liability", 0, difference, "Saldo inicial o brecha bancaria por identificar"),
      ]
      : [
        postingLine(accounts, "suspense_asset", Math.abs(difference), 0, "Saldo inicial o brecha bancaria por identificar"),
        { accountId: bankAccount, debit: 0, credit: Math.abs(difference), description: "Ajuste controlado a saldo de cartola" },
      ];
    await postAutomatedEntry(rest, profile, {
      entityId,
      periodId: periodForDate(periods, statementDate),
      date: statementDate,
      description: "Control de saldo contra última cartola importada",
      reference: String(transaction.operation_number || transaction.reference || transaction.id),
      sourceType: "SYSTEM",
      sourceDocumentId: null,
      idempotencyKey,
      currency: String(transaction.currency || "CLP"),
      exchangeRate: Math.max(numeric(transaction.exchange_rate), 1),
      lines: adjustmentLines,
    });
    posted += 1;
  }
  return posted;
}

function bankTransactionSequence(transaction: JsonRecord) {
  const metadata = asObject(transaction.metadata);
  const sourceRow = String(Math.max(Math.trunc(numeric(metadata.source_row)), 0)).padStart(10, "0");
  return `${String(transaction.transaction_date || "")}|${String(transaction.created_at || "")}|${sourceRow}|${String(transaction.id || "")}`;
}

async function postAutomatedEntry(rest: RestClient, profile: Profile, input: {
  entityId: string;
  periodId: string;
  date: string;
  description: string;
  reference: string;
  sourceType: string;
  sourceDocumentId: string | null;
  sourceModule?: string;
  idempotencyKey: string;
  currency: string;
  exchangeRate: number;
  lines: Array<{ accountId: string; debit: number; credit: number; description: string; metadata?: JsonRecord }>;
}) {
  const existing = await selectRows(rest, `accounting_journal_entries?select=id,status&entity_id=eq.${input.entityId}&idempotency_key=eq.${encodeURIComponent(input.idempotencyKey)}&limit=1`);
  if (existing[0]) return existing[0];
  const debit = input.lines.reduce((sum, line) => sum + line.debit, 0);
  const credit = input.lines.reduce((sum, line) => sum + line.credit, 0);
  if (debit <= 0 || Math.abs(debit - credit) > 0.0001) throw new Error("El asiento automático quedó descuadrado.");
  const entry = (await insertRows(rest, "accounting_journal_entries", [{
    entity_id: input.entityId,
    period_id: input.periodId,
    entry_date: input.date,
    description: input.description,
    reference: input.reference,
    source_type: input.sourceType,
    source_document_id: input.sourceDocumentId,
    source_module: input.sourceModule || "accounting_automation",
    idempotency_key: input.idempotencyKey,
    currency: validCurrency(input.currency) || "CLP",
    exchange_rate: input.exchangeRate,
    status: "validated",
    created_by: profile.id,
  }]))[0];
  try {
    await insertRows(rest, "accounting_journal_lines", input.lines.map((line, index) => ({
      entry_id: entry.id,
      line_number: index + 1,
      account_id: line.accountId,
      description: line.description,
      debit_clp: line.debit,
      credit_clp: line.credit,
      currency: validCurrency(input.currency) || "CLP",
      exchange_rate: input.exchangeRate,
      metadata: { automated: true, policy: "verified_source", ...(line.metadata || {}) },
    })));
    await rpc(rest, "accounting_post_journal_entry", { p_entry_id: entry.id });
    return entry;
  } catch (error) {
    await deleteRows(rest, "accounting_journal_lines", `entry_id=eq.${entry.id}`).catch(() => undefined);
    await deleteRows(rest, "accounting_journal_entries", `id=eq.${entry.id}`).catch(() => undefined);
    throw error;
  }
}

function postingLine(accounts: Map<string, string>, classification: string, debit: number, credit: number, description: string) {
  return { accountId: postingAccount(accounts, classification), debit, credit, description };
}

function postingAccount(accounts: Map<string, string>, classification: string) {
  const id = accounts.get(classification);
  if (!id) throw new Error(`Falta una cuenta contable activa para ${classification}.`);
  return id;
}

function periodForDate(periods: JsonRecord[], value: string) {
  const period = periods.find((row) => value >= String(row.starts_on) && value <= String(row.ends_on));
  if (!period) throw new Error(`No existe un período abierto para ${value}.`);
  return String(period.id);
}

function signedDocumentAmount(document: JsonRecord) {
  const amount = numeric(document.total_clp);
  return String(document.document_type || "").includes("credit_note") ? -amount : amount;
}

function checkSettlementLines(
  accounts: Map<string, string>,
  bankLedgerAccount: string | undefined,
  staged: boolean,
  depositAmount: number,
  checkAmount: number,
) {
  const lines = staged
    ? [postingLine(accounts, "suspense_liability", depositAmount, 0, "Liberación de depósito de cheque identificado")]
    : [{
      accountId: bankLedgerAccount || postingAccount(accounts, "bank_bancoestado_clp"),
      debit: depositAmount,
      credit: 0,
      description: "Depósito de cheque en BancoEstado",
    }];
  lines.push(postingLine(accounts, "checks_portfolio", 0, checkAmount, "Cheque cobrado en BancoEstado"));
  const difference = Math.round((depositAmount - checkAmount) * 10000) / 10000;
  if (difference > 0.005) {
    lines.push(postingLine(accounts, "other_income", 0, difference, "Diferencia positiva documentada entre depósito y cheque"));
  } else if (difference < -0.005) {
    lines.push(postingLine(accounts, "bank_fees", -difference, 0, "Diferencia negativa documentada entre depósito y cheque"));
  }
  return lines;
}

async function settleFactoChecks(rest: RestClient, profile: Profile, payload: JsonRecord) {
  const entityId = requiredUuid(payload.entityId);
  const [batches, sourceDocuments, receivables, periods, accountRows, bankAccounts] = await Promise.all([
    selectAllRows(rest, `accounting_import_batches?select=*&entity_id=eq.${entityId}&source_type=eq.CHECKS&order=created_at.asc`),
    selectAllRows(rest, `accounting_source_documents?select=*&entity_id=eq.${entityId}&source_type=eq.FACTO`),
    selectAllRows(rest, `accounting_receivables?select=*&entity_id=eq.${entityId}`),
    selectAllRows(rest, `accounting_periods?select=*&entity_id=eq.${entityId}&order=starts_on.asc`),
    selectAllRows(rest, `accounting_accounts?select=id,classification&entity_id=eq.${entityId}&active=eq.true&allows_posting=eq.true`),
    selectAllRows(rest, `accounting_bank_accounts?select=id,institution,ledger_account_id&entity_id=eq.${entityId}&active=eq.true`),
  ]);
  if (!batches.length) throw new HttpError(409, "No hay una planilla de cheques Facto respaldada.");
  const openingReceivables = new Map<string, JsonRecord>();
  for (const batch of batches) {
    const rows = await selectAllRows(rest, `accounting_import_rows?select=*&batch_id=eq.${batch.id}&order=row_number.asc`);
    const ensured = await ensureFactoCheckOpeningReceivables(
      rest,
      entityId,
      batch,
      rows,
      sourceDocuments,
      receivables,
    );
    for (const item of ensured) openingReceivables.set(String(asObject(item.receivable).id), item);
    await consolidateFactoCheckRows(rest, entityId, String(batch.id), rows, sourceDocuments, receivables);
  }

  const accounts = new Map(accountRows.map((row) => [String(row.classification), String(row.id)]));
  const bankLedgerById = new Map(bankAccounts.map((row) => [String(row.id), String(row.ledger_account_id || "")]));
  for (const item of openingReceivables.values()) {
    const receivable = asObject(item.receivable);
    const source = asObject(item.source);
    const amount = numeric(item.amount_clp);
    await postAutomatedEntry(rest, profile, {
      entityId,
      periodId: periodForDate(periods, "2026-01-01"),
      date: "2026-01-01",
      description: `Saldo inicial cuenta por cobrar Facto ${String(receivable.document_number)}`,
      reference: String(receivable.document_number || receivable.id),
      sourceType: "EXCEL",
      sourceDocumentId: String(source.id),
      idempotencyKey: `facto-check-opening:${receivable.id}`,
      currency: "CLP",
      exchangeRate: 1,
      lines: [
        postingLine(accounts, "receivables", amount, 0, "Saldo por cobrar anterior a 2026 respaldado por Facto"),
        postingLine(accounts, "retained_earnings", 0, amount, "Contrapartida de apertura; no es venta del ejercicio 2026"),
      ],
    });
  }
  const checks = await selectAllRows(rest, `accounting_checks?select=*&entity_id=eq.${entityId}&source_business_key=not.is.null&order=received_on.asc`);
  const receivableMap = new Map(receivables.map((row) => [String(row.id), { ...row }]));
  const existingAllocations = await selectAllRows(rest,
    `accounting_receivable_allocations?select=*&check_id=not.is.null&status=eq.confirmed`,
  );
  const allocationKeys = new Set(existingAllocations.map((row) => `${row.check_id}|${row.receivable_id}`));
  const checkReceiptTotals = new Map<string, number>();
  for (const allocation of existingAllocations) {
    const checkId = String(allocation.check_id || "");
    checkReceiptTotals.set(checkId, (checkReceiptTotals.get(checkId) || 0) + numeric(allocation.amount_clp));
  }
  let allocationsCreated = 0;
  let receivablesAppliedClp = 0;
  const allocationWarnings: JsonRecord[] = [];

  for (const check of checks) {
    const metadata = asObject(check.metadata);
    const allocations = Array.isArray(metadata.allocations) ? metadata.allocations.map(asObject) : [];
    for (const allocation of allocations) {
      const receivableId = String(allocation.receivable_id || "");
      const receivable = receivableMap.get(receivableId);
      if (!receivable) {
        allocationWarnings.push({ checkId: check.id, document: allocation.source_document_number, warning: "Documento Facto no vinculado." });
        continue;
      }
      const allocationKey = `${check.id}|${receivableId}`;
      if (allocationKeys.has(allocationKey)) continue;
      const requested = Math.round(numeric(allocation.amount_clp) * 10000) / 10000;
      const balance = Math.max(numeric(receivable.original_amount_clp) - numeric(receivable.paid_amount_clp), 0);
      const applied = Math.min(requested, balance);
      if (applied <= 0.005) continue;
      const entry = await postAutomatedEntry(rest, profile, {
        entityId,
        periodId: periodForDate(periods, String(check.received_on)),
        date: String(check.received_on),
        description: `Recepción cheque Facto ${String(check.check_number)} para documento ${String(receivable.document_number)}`,
        reference: String(check.check_number || check.id),
        sourceType: "FACTO",
        sourceDocumentId: String(receivable.source_document_id || "") || null,
        idempotencyKey: `facto-check-receivable:${check.id}:${receivableId}`,
        currency: "CLP",
        exchangeRate: 1,
        lines: [
          postingLine(accounts, "checks_portfolio", applied, 0, "Cheque recibido y pendiente de respaldo bancario"),
          postingLine(accounts, "receivables", 0, applied, "Aplicación a cuenta por cobrar"),
        ],
      });
      await insertRows(rest, "accounting_receivable_allocations", [{
        receivable_id: receivableId,
        check_id: check.id,
        journal_entry_id: entry.id,
        amount_clp: applied,
        allocated_on: check.received_on,
        status: "confirmed",
        created_by: profile.id,
      }]);
      const paid = numeric(receivable.paid_amount_clp) + applied;
      const original = numeric(receivable.original_amount_clp);
      await patchRows(rest, "accounting_receivables", `id=eq.${receivableId}`, {
        paid_amount_clp: paid,
        status: paid >= original - 0.5 ? "paid" : paid > 0 ? "partial" : receivable.status,
        updated_at: new Date().toISOString(),
      });
      receivable.paid_amount_clp = paid;
      receivable.status = paid >= original - 0.5 ? "paid" : "partial";
      allocationKeys.add(allocationKey);
      checkReceiptTotals.set(String(check.id), (checkReceiptTotals.get(String(check.id)) || 0) + applied);
      allocationsCreated += 1;
      receivablesAppliedClp += applied;
    }
  }

  // The REST workflow above spans multiple requests. If a previous execution
  // inserted an allocation and stopped before updating the receivable, rebuild
  // the operational paid amount from every confirmed allocation. Never lower a
  // pre-existing amount because older/manual evidence may not have an allocation.
  const confirmedReceivableAllocations = await selectAllRows(rest,
    "accounting_receivable_allocations?select=receivable_id,amount_clp&status=eq.confirmed",
  );
  const confirmedAllocationTotals = new Map<string, number>();
  for (const allocation of confirmedReceivableAllocations) {
    const receivableId = String(allocation.receivable_id || "");
    if (!receivableMap.has(receivableId)) continue;
    confirmedAllocationTotals.set(
      receivableId,
      (confirmedAllocationTotals.get(receivableId) || 0) + numeric(allocation.amount_clp),
    );
  }
  for (const [receivableId, allocated] of confirmedAllocationTotals) {
    const receivable = receivableMap.get(receivableId)!;
    const currentPaid = numeric(receivable.paid_amount_clp);
    if (allocated <= currentPaid + 0.005) continue;
    const original = numeric(receivable.original_amount_clp);
    await patchRows(rest, "accounting_receivables", `id=eq.${receivableId}`, {
      paid_amount_clp: allocated,
      status: allocated >= original - 0.5 ? "paid" : "partial",
      updated_at: new Date().toISOString(),
    });
    receivable.paid_amount_clp = allocated;
    receivable.status = allocated >= original - 0.5 ? "paid" : "partial";
  }

  // Recover a previous run that created the reconciliation link but stopped
  // before updating the cheque or the bank transaction. This keeps retries
  // idempotent across the multi-request REST workflow.
  const checkIds = new Set(checks.map((row) => String(row.id)));
  const existingCheckLinks = (await selectAllRows(rest,
    "accounting_reconciliation_links?select=id,target_id,reconciliation_id,target_reference,allocated_amount_clp&target_type=eq.check",
  )).filter((row) => checkIds.has(String(row.target_id || "")));
  const existingReconciliationIds = [...new Set(existingCheckLinks.map((row) => String(row.reconciliation_id || "")).filter(Boolean))];
  const existingCheckReconciliations = existingReconciliationIds.length
    ? await selectAllRows(rest,
      `accounting_reconciliations?select=id,bank_transaction_id,status&entity_id=eq.${entityId}&id=in.(${existingReconciliationIds.join(",")})`,
    )
    : [];
  const allReconciliationById = new Map(existingCheckReconciliations.map((row) => [String(row.id), row]));
  const reconciliationById = new Map(existingCheckReconciliations
    .filter((row) => String(row.status) === "confirmed")
    .map((row) => [String(row.id), row]));
  const recoveredBankTransactionIds = [...new Set(existingCheckLinks
    .map((link) => reconciliationById.get(String(link.reconciliation_id || "")))
    .map((row) => String(row?.bank_transaction_id || ""))
    .filter(Boolean))];
  const recoveredBankTransactions = recoveredBankTransactionIds.length
    ? await selectAllRows(rest,
      `accounting_bank_transactions?select=id,transaction_date&entity_id=eq.${entityId}&id=in.(${recoveredBankTransactionIds.join(",")})`,
    )
    : [];
  const recoveredTransactionById = new Map(recoveredBankTransactions.map((row) => [String(row.id), row]));
  for (const link of existingCheckLinks) {
    const reconciliation = reconciliationById.get(String(link.reconciliation_id || ""));
    if (!reconciliation) continue;
    const transactionId = String(reconciliation.bank_transaction_id || "");
    const transaction = recoveredTransactionById.get(transactionId);
    const checkId = String(link.target_id || "");
    const check = checks.find((row) => String(row.id) === checkId);
    if (!transaction || !check) continue;
    await patchRows(rest, "accounting_bank_transactions", `id=eq.${transactionId}`, {
      reconciliation_status: "matched",
      updated_at: new Date().toISOString(),
    });
    await patchRows(rest, "accounting_checks", `id=eq.${checkId}`, {
      status: "collected",
      deposited_on: transaction.transaction_date,
      bank_evidence_status: "matched",
      notes: "Cobro Facto confirmado por depósito exacto en cartola BancoEstado.",
      metadata: {
        ...asObject(check.metadata),
        matched_bank_transaction_id: transactionId,
        matched_bank_transaction_date: transaction.transaction_date,
        bank_match_rule: "exact_amount+facto_date_window",
      },
      updated_at: new Date().toISOString(),
    });
    check.status = "collected";
    check.deposited_on = transaction.transaction_date;
    check.bank_evidence_status = "matched";
  }

  const bancoEstadoIds = new Set(bankAccounts
    .filter((row) => normalizeText(row.institution).includes("estado"))
    .map((row) => String(row.id)));
  const allBancoEstadoDeposits = (await selectAllRows(rest,
    `accounting_bank_transactions?select=*&entity_id=eq.${entityId}&amount_clp=gt.0&reconciliation_status=neq.ignored&order=transaction_date.asc`,
  )).filter((row) => {
    const description = normalizeText(row.description);
    return bancoEstadoIds.has(String(row.bank_account_id)) && description.includes("deposito") && description.includes("document");
  });

  // Facto can report several partial cheques for the same invoice with amounts
  // separated by one peso. Prefer the deposit closest to the cheque reception
  // date before the amount, otherwise two sequential cheques can be crossed.
  // This block repairs only reconciliations created by this cheque workflow;
  // reconciliations belonging to another target are never reassigned.
  const repairCandidates: Array<{ check: JsonRecord; deposit: JsonRecord; checkIndex: number; depositIndex: number; days: number; amountDelta: number }> = [];
  for (let checkIndex = 0; checkIndex < checks.length; checkIndex += 1) {
    const check = checks[checkIndex];
    const receivedAmount = checkReceiptTotals.get(String(check.id)) || 0;
    if (receivedAmount < numeric(check.amount_clp) - 0.5) continue;
    for (let depositIndex = 0; depositIndex < allBancoEstadoDeposits.length; depositIndex += 1) {
      const deposit = allBancoEstadoDeposits[depositIndex];
      const amountDelta = Math.abs(numeric(check.amount_clp) - numeric(deposit.amount_clp));
      if (amountDelta > 1.005) continue;
      const receivedOn = String(check.received_on || "");
      const collectedOn = String(check.facto_collected_on || check.due_on || receivedOn);
      const depositOn = String(deposit.transaction_date || "");
      if (!dateWithinWindow(depositOn, receivedOn, collectedOn, 3, 21)) continue;
      repairCandidates.push({
        check,
        deposit,
        checkIndex,
        depositIndex,
        days: Math.abs(daysBetween(receivedOn, depositOn)),
        amountDelta,
      });
    }
  }
  const repairCheckCandidateCount = new Map<number, number>();
  const repairDepositCandidateCount = new Map<number, number>();
  for (const candidate of repairCandidates) {
    repairCheckCandidateCount.set(candidate.checkIndex, (repairCheckCandidateCount.get(candidate.checkIndex) || 0) + 1);
    repairDepositCandidateCount.set(candidate.depositIndex, (repairDepositCandidateCount.get(candidate.depositIndex) || 0) + 1);
  }
  repairCandidates.sort((left, right) =>
    (repairCheckCandidateCount.get(left.checkIndex) || 0) - (repairCheckCandidateCount.get(right.checkIndex) || 0)
    || (repairDepositCandidateCount.get(left.depositIndex) || 0) - (repairDepositCandidateCount.get(right.depositIndex) || 0)
    || left.days - right.days
    || left.amountDelta - right.amountDelta
    || String(left.check.id).localeCompare(String(right.check.id))
  );
  const desiredDepositByCheck = new Map<string, JsonRecord>();
  const desiredCheckByDeposit = new Map<string, JsonRecord>();
  for (const candidate of repairCandidates) {
    const checkId = String(candidate.check.id);
    const depositId = String(candidate.deposit.id);
    if (desiredDepositByCheck.has(checkId) || desiredCheckByDeposit.has(depositId)) continue;
    desiredDepositByCheck.set(checkId, candidate.deposit);
    desiredCheckByDeposit.set(depositId, candidate.check);
  }
  const confirmedCheckReconciliationByDeposit = new Map(existingCheckLinks
    .map((link) => allReconciliationById.get(String(link.reconciliation_id || "")))
    .filter((row) => row && String(row.status) === "confirmed")
    .map((row) => [String(row!.bank_transaction_id || ""), row!]));
  let bankEvidenceCorrections = 0;
  let bankEvidenceCorrectionClp = 0;
  for (const [depositId, desiredCheck] of desiredCheckByDeposit) {
    const reconciliation = confirmedCheckReconciliationByDeposit.get(depositId);
    if (!reconciliation) continue;
    const reconciliationId = String(reconciliation.id);
    const link = existingCheckLinks.find((row) => String(row.reconciliation_id || "") === reconciliationId);
    if (!link) continue;
    const currentCheckId = String(link.target_id || "");
    const desiredCheckId = String(desiredCheck.id);
    if (!currentCheckId || currentCheckId === desiredCheckId) continue;
    if (existingCheckLinks.some((row) => String(row.target_id || "") === desiredCheckId)) continue;
    const currentCheck = checks.find((row) => String(row.id) === currentCheckId);
    const currentDesiredDeposit = desiredDepositByCheck.get(currentCheckId);
    if (!currentCheck || !currentDesiredDeposit || String(currentDesiredDeposit.id) === depositId) continue;
    if (String(currentDesiredDeposit.reconciliation_status || "unmatched") !== "unmatched") continue;
    const deposit = allBancoEstadoDeposits.find((row) => String(row.id) === depositId);
    if (!deposit) continue;

    const oldEntry = (await selectRows(rest,
      `accounting_journal_entries?select=id,entry_date,status&entity_id=eq.${entityId}&idempotency_key=eq.${encodeURIComponent(`bank-reconciliation:${reconciliationId}`)}&limit=1`,
    ))[0];
    const correctedKey = `bank-reconciliation-corrected:${reconciliationId}`;
    const correctedEntry = (await selectRows(rest,
      `accounting_journal_entries?select=id&entity_id=eq.${entityId}&idempotency_key=eq.${encodeURIComponent(correctedKey)}&limit=1`,
    ))[0];
    if (!correctedEntry) {
      if (oldEntry && String(oldEntry.status) === "posted") {
        await rpc(rest, "accounting_reverse_journal_entry", {
          p_entry_id: oldEntry.id,
          p_reversal_date: oldEntry.entry_date,
          p_reason: "Corrección de asociación entre cheque Facto y depósito BancoEstado.",
        });
      }
      const depositAmount = numeric(deposit.amount_clp);
      const checkAmount = numeric(desiredCheck.amount_clp);
      const staged = (await selectRows(rest,
        `accounting_journal_entries?select=id&entity_id=eq.${entityId}&idempotency_key=eq.${encodeURIComponent(`bank-transaction:${depositId}`)}&status=in.(posted,reversed)&limit=1`,
      ))[0];
      await postAutomatedEntry(rest, profile, {
        entityId,
        periodId: periodForDate(periods, String(deposit.transaction_date)),
        date: String(deposit.transaction_date),
        description: `Cobro cheque ${String(desiredCheck.check_number)} corregido por cartola BancoEstado`,
        reference: String(deposit.operation_number || deposit.reference || depositId),
        sourceType: "SYSTEM",
        sourceDocumentId: null,
        idempotencyKey: correctedKey,
        currency: "CLP",
        exchangeRate: 1,
        lines: checkSettlementLines(
          accounts,
          bankLedgerById.get(String(deposit.bank_account_id || "")),
          Boolean(staged),
          depositAmount,
          checkAmount,
        ),
      });
    }
    await patchRows(rest, "accounting_reconciliation_links", `id=eq.${link.id}`, {
      target_id: desiredCheckId,
      target_reference: String(desiredCheck.source_business_key || desiredCheck.check_number),
      allocated_amount_clp: numeric(desiredCheck.amount_clp),
    });
    await patchRows(rest, "accounting_reconciliations", `id=eq.${reconciliationId}`, {
      matched_amount_clp: numeric(deposit.amount_clp),
      explanation: "Asociación corregida por monto con tolerancia de $1 y mayor proximidad a la fecha de recepción del cheque.",
      updated_at: new Date().toISOString(),
    });
    await patchRows(rest, "accounting_checks", `id=eq.${currentCheckId}`, {
      status: currentCheck.facto_collected_on ? "deposited" : "portfolio",
      deposited_on: null,
      bank_evidence_status: "pending",
      notes: currentCheck.facto_collected_on
        ? "Cobrado/inactivo en Facto; pendiente de confirmar el depósito correcto en cartola BancoEstado."
        : "Cheque informado por Facto; pendiente de cobro y cartola BancoEstado.",
      metadata: {
        ...asObject(currentCheck.metadata),
        matched_bank_transaction_id: null,
        matched_bank_transaction_date: null,
        bank_match_rule: null,
      },
      updated_at: new Date().toISOString(),
    });
    await patchRows(rest, "accounting_checks", `id=eq.${desiredCheckId}`, {
      status: "collected",
      deposited_on: deposit.transaction_date,
      bank_evidence_status: "matched",
      notes: "Cobro Facto confirmado por depósito en cartola BancoEstado con tolerancia documentada de $1.",
      metadata: {
        ...asObject(desiredCheck.metadata),
        matched_bank_transaction_id: depositId,
        matched_bank_transaction_date: deposit.transaction_date,
        bank_match_rule: "amount_tolerance_1_clp+closest_received_date",
      },
      updated_at: new Date().toISOString(),
    });
    link.target_id = desiredCheckId;
    currentCheck.status = currentCheck.facto_collected_on ? "deposited" : "portfolio";
    currentCheck.bank_evidence_status = "pending";
    desiredCheck.status = "collected";
    desiredCheck.bank_evidence_status = "matched";
    bankEvidenceCorrections += 1;
    bankEvidenceCorrectionClp += numeric(deposit.amount_clp);
  }

  // A retry can resume after the reconciliation link was reassigned but before
  // the previous cheque was reset. Rebuild the evidence flag from the durable
  // link set so a partially completed correction cannot leave two cheques
  // pointing at the same bank deposit.
  const linkedCheckIds = new Set(existingCheckLinks.map((row) => String(row.target_id || "")).filter(Boolean));
  for (const check of checks) {
    if (String(check.bank_evidence_status || "pending") !== "matched") continue;
    if (linkedCheckIds.has(String(check.id))) continue;
    await patchRows(rest, "accounting_checks", `id=eq.${check.id}`, {
      status: check.facto_collected_on ? "deposited" : "portfolio",
      deposited_on: null,
      bank_evidence_status: "pending",
      notes: check.facto_collected_on
        ? "Cobrado/inactivo en Facto; pendiente de confirmar el depósito correcto en cartola BancoEstado."
        : "Cheque informado por Facto; pendiente de cobro y cartola BancoEstado.",
      metadata: {
        ...asObject(check.metadata),
        matched_bank_transaction_id: null,
        matched_bank_transaction_date: null,
        bank_match_rule: null,
      },
      updated_at: new Date().toISOString(),
    });
    check.status = check.facto_collected_on ? "deposited" : "portfolio";
    check.deposited_on = null;
    check.bank_evidence_status = "pending";
  }

  const bankTransactions = await selectAllRows(rest,
    `accounting_bank_transactions?select=*&entity_id=eq.${entityId}&amount_clp=gt.0&reconciliation_status=eq.unmatched&order=transaction_date.asc`,
  );
  const deposits = bankTransactions.filter((row) => {
    const description = normalizeText(row.description);
    return bancoEstadoIds.has(String(row.bank_account_id)) && description.includes("deposito") && description.includes("document");
  });
  const candidateRows: Array<{ check: JsonRecord; deposit: JsonRecord; checkIndex: number; depositIndex: number; days: number }> = [];
  for (let checkIndex = 0; checkIndex < checks.length; checkIndex += 1) {
    const check = checks[checkIndex];
    if (String(check.bank_evidence_status || "pending") === "matched") continue;
    const receivedAmount = checkReceiptTotals.get(String(check.id)) || 0;
    if (receivedAmount < numeric(check.amount_clp) - 0.5) continue;
    for (let depositIndex = 0; depositIndex < deposits.length; depositIndex += 1) {
      const deposit = deposits[depositIndex];
      if (Math.abs(numeric(check.amount_clp) - numeric(deposit.amount_clp)) > 1.005) continue;
      const receivedOn = String(check.received_on || "");
      const collectedOn = String(check.facto_collected_on || check.due_on || receivedOn);
      const depositOn = String(deposit.transaction_date || "");
      if (!dateWithinWindow(depositOn, receivedOn, collectedOn, 3, 21)) continue;
      candidateRows.push({
        check,
        deposit,
        checkIndex,
        depositIndex,
        days: Math.abs(daysBetween(collectedOn, depositOn)),
      });
    }
  }
  const checkCandidateCount = new Map<number, number>();
  const depositCandidateCount = new Map<number, number>();
  for (const candidate of candidateRows) {
    checkCandidateCount.set(candidate.checkIndex, (checkCandidateCount.get(candidate.checkIndex) || 0) + 1);
    depositCandidateCount.set(candidate.depositIndex, (depositCandidateCount.get(candidate.depositIndex) || 0) + 1);
  }
  candidateRows.sort((left, right) =>
    (checkCandidateCount.get(left.checkIndex) || 0) - (checkCandidateCount.get(right.checkIndex) || 0)
    || (depositCandidateCount.get(left.depositIndex) || 0) - (depositCandidateCount.get(right.depositIndex) || 0)
    || left.days - right.days
    || String(left.check.id).localeCompare(String(right.check.id))
  );
  const usedChecks = new Set<string>();
  const usedDeposits = new Set<string>();
  let bankMatches = 0;
  let bankMatchedClp = 0;
  for (const candidate of candidateRows) {
    const checkId = String(candidate.check.id);
    const depositId = String(candidate.deposit.id);
    if (usedChecks.has(checkId) || usedDeposits.has(depositId)) continue;
    const amount = numeric(candidate.check.amount_clp);
    const depositAmount = numeric(candidate.deposit.amount_clp);
    const staged = (await selectRows(rest,
      `accounting_journal_entries?select=id&entity_id=eq.${entityId}&idempotency_key=eq.${encodeURIComponent(`bank-transaction:${depositId}`)}&status=in.(posted,reversed)&limit=1`,
    ))[0];
    const bankLedgerAccount = bankLedgerById.get(String(candidate.deposit.bank_account_id || ""));
    const lines = checkSettlementLines(accounts, bankLedgerAccount, Boolean(staged), depositAmount, amount);
    const previousLink = existingCheckLinks.find((row) => String(row.target_id || "") === checkId);
    let reconciliation = previousLink
      ? allReconciliationById.get(String(previousLink.reconciliation_id || ""))
      : null;
    if (!reconciliation) {
      reconciliation = (await insertRows(rest, "accounting_reconciliations", [{
        entity_id: entityId,
        bank_transaction_id: depositId,
        status: "proposed",
        confidence: "exact",
        score: 1,
        matched_amount_clp: depositAmount,
        explanation: "Cheque Facto conciliado por monto exacto o diferencia documentada de hasta $1 y ventana de fechas BancoEstado.",
      }]))[0];
      await insertRows(rest, "accounting_reconciliation_links", [{
        reconciliation_id: reconciliation.id,
        target_type: "check",
        target_id: checkId,
        target_reference: String(candidate.check.source_business_key || candidate.check.check_number),
        allocated_amount_clp: amount,
      }]);
      existingCheckLinks.push({ target_id: checkId, reconciliation_id: reconciliation.id });
      allReconciliationById.set(String(reconciliation.id), reconciliation);
    }
    await postAutomatedEntry(rest, profile, {
      entityId,
      periodId: periodForDate(periods, String(candidate.deposit.transaction_date)),
      date: String(candidate.deposit.transaction_date),
      description: `Cobro cheque ${String(candidate.check.check_number)} confirmado por cartola BancoEstado`,
      reference: String(candidate.deposit.operation_number || candidate.deposit.reference || depositId),
      sourceType: "SYSTEM",
      sourceDocumentId: null,
      idempotencyKey: `bank-reconciliation:${reconciliation.id}`,
      currency: "CLP",
      exchangeRate: 1,
      lines,
    });
    await patchRows(rest, "accounting_reconciliations", `id=eq.${reconciliation.id}`, {
      status: "confirmed",
      confidence: "exact",
      score: 1,
      matched_amount_clp: depositAmount,
      explanation: "Cheque Facto conciliado por monto exacto o diferencia documentada de hasta $1 y ventana de fechas BancoEstado.",
      confirmed_by: profile.id,
      confirmed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await patchRows(rest, "accounting_bank_transactions", `id=eq.${depositId}`, {
      reconciliation_status: "matched",
      updated_at: new Date().toISOString(),
    });
    await patchRows(rest, "accounting_checks", `id=eq.${checkId}`, {
      status: "collected",
      deposited_on: candidate.deposit.transaction_date,
      bank_evidence_status: "matched",
      notes: "Cobro Facto confirmado por depósito exacto en cartola BancoEstado.",
      metadata: {
        ...asObject(candidate.check.metadata),
        matched_bank_transaction_id: depositId,
        matched_bank_transaction_date: candidate.deposit.transaction_date,
        bank_match_rule: Math.abs(depositAmount - amount) <= 0.005
          ? "exact_amount+facto_date_window"
          : "amount_tolerance_1_clp+facto_date_window",
      },
      updated_at: new Date().toISOString(),
    });
    usedChecks.add(checkId);
    usedDeposits.add(depositId);
    bankMatches += 1;
    bankMatchedClp += depositAmount;
  }

  const refreshedChecks = await selectAllRows(rest, `accounting_checks?select=*&entity_id=eq.${entityId}&source_business_key=not.is.null`);
  const factoCollected = refreshedChecks.filter((row) => normalizeText(row.source_status).includes("inactivo") && row.facto_collected_on);
  const bankConfirmed = refreshedChecks.filter((row) => row.bank_evidence_status === "matched");
  const totalAmount = refreshedChecks.reduce((sum, row) => sum + numeric(row.amount_clp), 0);
  const factCollectedAmount = factoCollected.reduce((sum, row) => sum + numeric(row.amount_clp), 0);
  const bankConfirmedAmount = bankConfirmed.reduce((sum, row) => sum + numeric(row.amount_clp), 0);
  await insertRows(rest, "accounting_audit_events", [{
    entity_id: entityId,
    actor_id: profile.id,
    action: "facto_checks.settled",
    entity_type: "accounting_check_batch",
    entity_id_text: String(batches[batches.length - 1].id),
    new_value: {
      physical_checks: refreshedChecks.length,
      total_amount_clp: totalAmount,
      facto_collected: factoCollected.length,
      facto_collected_amount_clp: factCollectedAmount,
      bank_confirmed: bankConfirmed.length,
      bank_confirmed_amount_clp: bankConfirmedAmount,
      bank_evidence_corrections: bankEvidenceCorrections,
      bank_evidence_correction_clp: bankEvidenceCorrectionClp,
      allocations_created: allocationsCreated,
      receivables_applied_clp: receivablesAppliedClp,
      warnings: allocationWarnings.slice(0, 50),
    },
  }]);
  await rpc(rest, "accounting_refresh_controls", { p_entity_id: entityId });
  return {
    physicalChecks: refreshedChecks.length,
    totalAmountClp: totalAmount,
    factoCollected: factoCollected.length,
    factoCollectedAmountClp: factCollectedAmount,
    factoCollectedPercent: refreshedChecks.length ? Math.round(factoCollected.length / refreshedChecks.length * 10000) / 100 : 0,
    bankConfirmed: bankConfirmed.length,
    bankConfirmedAmountClp: bankConfirmedAmount,
    bankConfirmedPercent: totalAmount ? Math.round(bankConfirmedAmount / totalAmount * 10000) / 100 : 0,
    bankMatchesCreated: bankMatches,
    bankMatchedClp,
    bankEvidenceCorrections,
    bankEvidenceCorrectionClp,
    allocationsCreated,
    receivablesAppliedClp,
    warnings: allocationWarnings,
  };
}

async function applyFactoCurrentState(rest: RestClient, profile: Profile, payload: JsonRecord) {
  const entityId = requiredUuid(payload.entityId);
  const requestedBatchId = payload.batchId ? requiredUuid(payload.batchId) : "";
  const batchPath = requestedBatchId
    ? `accounting_import_batches?select=*&id=eq.${requestedBatchId}&entity_id=eq.${entityId}&limit=1`
    : `accounting_import_batches?select=*&entity_id=eq.${entityId}&source_type=eq.COLLECTIONS&import_profile=eq.facto_unpaid_documents&status=eq.imported&order=created_at.desc&limit=1`;
  const batch = (await selectRows(rest, batchPath))[0];
  if (!batch) throw new HttpError(404, "No existe una foto importada de documentos impagos Facto.");
  if (String(batch.source_type) !== "COLLECTIONS" || String(batch.import_profile) !== "facto_unpaid_documents") {
    throw new HttpError(400, "El respaldo seleccionado no corresponde a documentos impagos Facto.");
  }

  const createdOn = String(batch.created_at || "").slice(0, 10);
  const asOf = payload.asOf ? requiredDate(payload.asOf) : requiredDate(createdOn);
  const [importRows, sourceDocuments, receivables, payables, accountRows, periods] = await Promise.all([
    selectAllRows(rest, `accounting_import_rows?select=*&batch_id=eq.${batch.id}&status=neq.invalid&order=row_number.asc`),
    selectAllRows(rest, `accounting_source_documents?select=*&entity_id=eq.${entityId}&source_type=eq.FACTO`),
    selectAllRows(rest, `accounting_receivables?select=*&entity_id=eq.${entityId}`),
    selectAllRows(rest, `accounting_payables?select=*&entity_id=eq.${entityId}`),
    selectAllRows(rest, `accounting_accounts?select=id,classification&entity_id=eq.${entityId}&active=eq.true&allows_posting=eq.true`),
    selectAllRows(rest, `accounting_periods?select=*&entity_id=eq.${entityId}&status=neq.closed&order=starts_on.asc`),
  ]);
  if (!importRows.length) throw new HttpError(409, "La foto Facto no contiene filas válidas para aplicar.");

  const receivableBySource = new Map(receivables.map((row) => [String(row.source_document_id), row]));
  const payableBySource = new Map(payables.map((row) => [String(row.source_document_id), row]));
  const outstandingReceivableIds = new Set<string>();
  const outstandingPayableIds = new Set<string>();
  const representedSourceDocumentIds = new Set<string>();
  const now = new Date().toISOString();
  let linkedRows = 0;
  let unmatchedRows = 0;

  for (const importRow of importRows) {
    const data = asObject(importRow.normalized_data);
    const direction = String(data.direction || "");
    if (!['sale', 'purchase'].includes(direction)) continue;
    let source = findFactoSourceDocument(sourceDocuments, data);
    let target = source
      ? direction === "sale" ? receivableBySource.get(String(source.id)) : payableBySource.get(String(source.id))
      : null;
    if (!target) {
      const created = await ensureFactoWorkbookDocument(rest, entityId, batch, importRow, data);
      source = created.source;
      target = created.target;
      sourceDocuments.push(source);
      if (direction === "sale") receivableBySource.set(String(source.id), target);
      else payableBySource.set(String(source.id), target);
    }
    if (!target) {
      unmatchedRows += 1;
      continue;
    }

    const reportedPaid = Math.max(0, numeric(data.reported_paid_clp));
    const reportedBalance = Math.max(0, numeric(data.reported_balance_clp));
    const dueOn = String(target.due_on || "");
    const status = reportedBalance <= 1
      ? "paid"
      : reportedPaid > 0
      ? "partial"
      : dueOn && dueOn < asOf
      ? "overdue"
      : "pending";
    const table = direction === "sale" ? "accounting_receivables" : "accounting_payables";
    await patchRows(rest, table, `id=eq.${target.id}`, {
      reported_paid_amount_clp: reportedPaid,
      reported_balance_clp: reportedBalance,
      reported_at: now,
      reported_source_batch_id: batch.id,
      status,
      updated_at: now,
    });
    if (direction === "sale") outstandingReceivableIds.add(String(target.id));
    else outstandingPayableIds.add(String(target.id));
    representedSourceDocumentIds.add(String(source.id));
    linkedRows += 1;
  }

  const snapshotResult = await rpc(rest, "accounting_apply_facto_outstanding_snapshot", {
    p_entity_id: entityId,
    p_batch_id: batch.id,
    p_as_of: asOf,
    p_receivable_ids: [...outstandingReceivableIds],
    p_payable_ids: [...outstandingPayableIds],
  });
  const [refreshedReceivables, refreshedPayables, trialRows] = await Promise.all([
    selectAllRows(rest, `accounting_receivables?select=source_document_id,reported_balance_clp,balance_clp&entity_id=eq.${entityId}`),
    selectAllRows(rest, `accounting_payables?select=source_document_id,reported_balance_clp,balance_clp&entity_id=eq.${entityId}`),
    rpc(rest, "accounting_trial_balance", { p_entity_id: entityId, p_from: "1900-01-01", p_to: asOf }),
  ]);
  const targetReceivablesClp = refreshedReceivables.reduce(
    (sum, row) => sum + numeric(row.reported_balance_clp ?? row.balance_clp),
    0,
  );
  const targetPayablesClp = refreshedPayables.reduce(
    (sum, row) => sum + numeric(row.reported_balance_clp ?? row.balance_clp),
    0,
  );
  const accounts = new Map(accountRows.map((row) => [String(row.classification), String(row.id)]));
  const receivablesAccountId = postingAccount(accounts, "receivables");
  const payablesAccountId = postingAccount(accounts, "payables");
  const trial = Array.isArray(trialRows) ? trialRows.map(asObject) : [];
  const receivablesTrial = trial.find((row) => String(row.account_id) === receivablesAccountId);
  const payablesTrial = trial.find((row) => String(row.account_id) === payablesAccountId);
  const currentReceivablesClp = numeric(receivablesTrial?.debits) - numeric(receivablesTrial?.credits);
  const currentPayablesClp = numeric(payablesTrial?.credits) - numeric(payablesTrial?.debits);
  const adjustment = buildFactoCurrentStateAdjustment({
    currentReceivablesClp,
    targetReceivablesClp,
    currentPayablesClp,
    targetPayablesClp,
  });
  let journalEntry: JsonRecord | null = null;
  if (adjustment.lines.length) {
    const moneyKey = (value: number) => Math.round(value * 100) / 100;
    journalEntry = await postAutomatedEntry(rest, profile, {
      entityId,
      periodId: periodForDate(periods, asOf),
      date: asOf,
      description: `Alineación de saldos actuales con foto de impagos Facto al ${asOf}`,
      reference: String(batch.file_name || batch.id),
      sourceType: "FACTO",
      sourceDocumentId: null,
      idempotencyKey: `facto-current-state:${batch.id}:${asOf}:ar-${moneyKey(currentReceivablesClp)}-${moneyKey(targetReceivablesClp)}:ap-${moneyKey(currentPayablesClp)}-${moneyKey(targetPayablesClp)}`,
      currency: "CLP",
      exchangeRate: 1,
      lines: adjustment.lines.map((line) => postingLine(
        accounts,
        line.classification,
        line.debit,
        line.credit,
        line.description,
      )),
    });
  }

  // La foto vigente queda representada por el asiento agregado de alineacion.
  // Solo cambia el estado documental despues de que el asiento termino bien;
  // no crea pagos ni evidencia bancaria.
  const accountedSourceDocumentIds = new Set([
    ...representedSourceDocumentIds,
    ...refreshedReceivables.map((row) => String(row.source_document_id || "")).filter(Boolean),
    ...refreshedPayables.map((row) => String(row.source_document_id || "")).filter(Boolean),
  ]);
  await Promise.all([...accountedSourceDocumentIds].map((sourceDocumentId) =>
    patchRows(rest, "accounting_source_documents", `id=eq.${sourceDocumentId}`, {
      status: "posted",
      updated_at: now,
    })
  ));

  await insertRows(rest, "accounting_audit_events", [{
    entity_id: entityId,
    actor_id: profile.id,
    action: "facto_outstanding_snapshot.applied",
    entity_type: "accounting_import_batch",
    entity_id_text: String(batch.id),
    new_value: {
      as_of: asOf,
      linked_rows: linkedRows,
      unmatched_rows: unmatchedRows,
      outstanding_receivables: outstandingReceivableIds.size,
      outstanding_payables: outstandingPayableIds.size,
      current_receivables_clp: currentReceivablesClp,
      target_receivables_clp: targetReceivablesClp,
      current_payables_clp: currentPayablesClp,
      target_payables_clp: targetPayablesClp,
      receivables_delta_clp: adjustment.receivablesDelta,
      payables_delta_clp: adjustment.payablesDelta,
      journal_entry_id: journalEntry?.id || null,
      snapshot_result: snapshotResult,
      bank_evidence_created: false,
    },
  }]);
  await rpc(rest, "accounting_refresh_controls", { p_entity_id: entityId });
  return {
    batchId: batch.id,
    asOf,
    linkedRows,
    unmatchedRows,
    outstandingReceivables: outstandingReceivableIds.size,
    outstandingPayables: outstandingPayableIds.size,
    currentReceivablesClp,
    targetReceivablesClp,
    currentPayablesClp,
    targetPayablesClp,
    receivablesDeltaClp: adjustment.receivablesDelta,
    payablesDeltaClp: adjustment.payablesDelta,
    journalEntryId: journalEntry?.id || null,
    snapshot: snapshotResult,
    bankEvidenceCreated: false,
  };
}

function daysBetween(left: string, right: string) {
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return Number.MAX_SAFE_INTEGER;
  return Math.round((leftTime - rightTime) / 86400000);
}

function dateWithinWindow(value: string, start: string, end: string, daysBefore: number, daysAfter: number) {
  const valueTime = Date.parse(`${value}T00:00:00Z`);
  const startTime = Date.parse(`${start}T00:00:00Z`) - daysBefore * 86400000;
  const endTime = Date.parse(`${end}T00:00:00Z`) + daysAfter * 86400000;
  return Number.isFinite(valueTime) && Number.isFinite(startTime) && Number.isFinite(endTime)
    && valueTime >= startTime && valueTime <= endTime;
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
    const entries = await selectRows(rest, `accounting_journal_entries?select=id,entry_date,entry_number,description,reference,source_type,accounting_journal_lines(account_id,line_number,debit_clp,credit_clp,currency,description)&entity_id=eq.${entityId}&status=in.(posted,reversed)&entry_date=gte.${from}&entry_date=lte.${to}&order=entry_date.asc,entry_number.asc&limit=5000`);
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
            origen: entry.source_type,
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

async function ensureFactoWorkbookDocument(
  rest: RestClient,
  entityId: string,
  batch: JsonRecord,
  importRow: JsonRecord,
  data: JsonRecord,
) {
  const direction = String(data.direction || "");
  const documentType = String(data.document_type || "");
  const documentNumber = String(data.document_number || "").trim();
  const totalClp = Math.max(0, numeric(data.total_clp));
  const issuedOn = String(data.issued_on || "");
  if (!documentNumber || !issuedOn || totalClp <= 0 || !["sale", "purchase"].includes(direction)) {
    throw new Error("El documento Facto complementario no contiene los datos mínimos para crear su respaldo contable.");
  }
  const fingerprint = String(importRow.fingerprint || importRow.id || crypto.randomUUID());
  const sourceKey = `facto-workbook:${direction}:${fingerprint}`;
  const now = new Date().toISOString();
  const [source] = await upsertRowsSelected(rest, "accounting_source_documents", [{
    entity_id: entityId,
    source_type: "FACTO",
    source_id: String(importRow.id || ""),
    source_key: sourceKey,
    document_type: documentType || `${direction === "sale" ? "sales" : "purchase"}_invoice`,
    external_id: `workbook:${fingerprint}`,
    folio: documentNumber,
    counterpart_tax_id: data.counterpart_tax_id || null,
    counterpart_name: data.counterpart_name || "Contraparte informada por Facto",
    issued_on: issuedOn,
    due_on: null,
    currency: "CLP",
    exchange_rate: 1,
    net_amount: Math.max(0, numeric(data.net_clp)),
    tax_amount: Math.max(0, numeric(data.tax_clp)),
    exempt_amount: Math.max(0, numeric(data.exempt_clp)),
    total_amount: totalClp,
    total_clp: totalClp,
    status: "validated",
    data_quality: "validated",
    raw_payload: {
      evidence: "Facto Excel complementario",
      import_batch_id: batch.id,
      import_row_id: importRow.id,
      file_name: batch.file_name,
      normalized_data: data,
    },
    observed_at: now,
    updated_at: now,
  }], "entity_id,source_type,source_key", "*");
  if (!source) throw new Error("No se pudo conservar el documento complementario de Facto.");

  const common = {
    entity_id: entityId,
    source_document_id: source.id,
    document_number: documentNumber,
    issued_on: issuedOn,
    due_on: null,
    currency: "CLP",
    exchange_rate: 1,
    original_amount: totalClp,
    original_amount_clp: totalClp,
    paid_amount_clp: 0,
    status: "pending",
    notes: `Creado desde respaldo Facto ${String(batch.file_name || "Excel")}; requiere conciliación bancaria.`,
    updated_at: now,
  };
  const table = direction === "sale" ? "accounting_receivables" : "accounting_payables";
  const counterpart = direction === "sale"
    ? { customer_tax_id: data.counterpart_tax_id || null, customer_name: data.counterpart_name || "Cliente informado por Facto" }
    : { supplier_tax_id: data.counterpart_tax_id || null, supplier_name: data.counterpart_name || "Proveedor informado por Facto" };
  const [target] = await upsertRowsSelected(rest, table, [{ ...common, ...counterpart }], "entity_id,source_document_id", "*");
  if (!target) throw new Error("No se pudo crear la cuenta corriente del documento complementario de Facto.");
  return { source, target };
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
      `accounting_checks?select=bank_name,check_number,source_business_key&entity_id=eq.${entityId}`,
    );
    const keys = new Set(existing.map((row) => String(row.source_business_key || "")));
    for (const row of preview.rows) {
      if (keys.has(physicalCheckBusinessKey(row.data))) {
        duplicateFingerprints.add(row.fingerprint);
      }
    }
  }
  return duplicateFingerprints;
}

function checkBusinessKey(bankName: unknown, checkNumber: unknown) {
  return `${normalizeText(bankName)}|${normalizeDocumentNumber(checkNumber)}`;
}

function physicalCheckBusinessKey(data: JsonRecord) {
  const bank = normalizeText(data.issuer_bank || data.bank_name);
  const number = normalizeDocumentNumber(data.check_number);
  const receivedOn = dateValue(data.received_on);
  const collectedOn = dateValue(data.due_on || data.facto_collected_on);
  const customerTaxId = normalizeTaxForMatch(data.customer_tax_id || data.issuer_tax_id);
  if (!bank || !number || !receivedOn) return "";
  return [bank, number, receivedOn, collectedOn || "pending", customerTaxId || "unknown"].join("|");
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
  const accountCode = source === "BANCO_ESTADO"
    ? "1.1.03"
    : source === "MERCADO_PAGO"
    ? "1.1.04"
    : currency === "USD"
    ? "1.1.05"
    : "1.1.02";
  const account = (await selectRows(rest,
    `accounting_accounts?select=id&entity_id=eq.${entityId}&code=eq.${accountCode}&allows_posting=eq.true&limit=1`,
  ))[0];
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

async function deleteRows(rest: RestClient, table: string, filter: string) {
  const response = await fetch(`${rest.url}/rest/v1/${table}?${filter}`, {
    method: "DELETE",
    headers: { ...serviceHeaders(rest), Prefer: "return=minimal" },
  });
  if (!response.ok) throw new HttpError(response.status, `Error limpiando ${table}: ${(await response.text()).slice(0, 400)}`);
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
