import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const API_KEY_ID = "22222222-2222-4222-8222-222222222222";

function withoutPgCrypto(sql) {
  // PGlite already exposes gen_random_uuid(), but does not bundle the
  // extension control file. Production Supabase executes the original SQL.
  return sql.replace(/create extension if not exists\s+"?pgcrypto"?\s*;/gi, "");
}

async function loadSql() {
  const [schema, agentApiKeys, preflight, prospecting, verify] = await Promise.all([
    fs.readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8"),
    fs.readFile(new URL("../supabase/agent_api_keys.sql", import.meta.url), "utf8"),
    fs.readFile(new URL("../supabase/prospecting_preflight.sql", import.meta.url), "utf8"),
    fs.readFile(new URL("../supabase/prospecting.sql", import.meta.url), "utf8"),
    fs.readFile(new URL("../supabase/prospecting_verify.sql", import.meta.url), "utf8"),
  ]);
  return {
    schema: withoutPgCrypto(schema),
    agentApiKeys: withoutPgCrypto(agentApiKeys),
    preflight,
    prospecting: withoutPgCrypto(prospecting),
    verify,
  };
}

async function createDatabase(sql) {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(`
    create schema auth;
    create role authenticated;
    create role anon;
    create role service_role;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.uid', true), '')::uuid
    $$;
    create function auth.role() returns text language sql stable as $$
      select coalesce(nullif(current_setting('app.role', true), ''), 'authenticated')
    $$;
  `);
  await db.exec(sql.schema);
  return db;
}

function candidate({
  id,
  name,
  url,
  phone,
  provider = "brave_search",
  observedAt = new Date().toISOString(),
}) {
  const providerRecordId = provider === "google_places" ? `place-${id}` : url;
  const evidence = [
    { field: "name", value: name },
    { field: "location.comuna_code", value: "13101" },
    { field: "website", value: url },
    ...(phone ? [{ field: "phone", value: phone }] : []),
  ].map((item) => ({
    provider,
    source_url: url,
    provider_record_id: providerRecordId,
    observed_at: observedAt,
    confidence: 1,
    ...item,
  }));
  const location = {
    country_code: "CL",
    region_code: "13",
    region_name: "Metropolitana de Santiago",
    comuna_code: "13101",
    comuna_name: "Santiago",
  };
  return {
    candidate_id: id,
    name,
    provider_ids: { [provider]: providerRecordId },
    phone,
    website: url,
    location,
    locations: [location],
    evidence,
  };
}

async function configureAdmin(db) {
  await db.query("insert into auth.users(id) values ($1)", [USER_ID]);
  await db.query(
    "insert into profiles(id, full_name, role) values ($1, 'Admin local', 'administrador')",
    [USER_ID],
  );
  await db.query(
    "select set_config('app.uid', $1, false), set_config('app.role', 'authenticated', false)",
    [USER_ID],
  );
}

async function insertCampaign(db, name, source, candidateLimit = 1) {
  return (await db.query(
    `insert into prospecting_campaigns(
       name, keywords, sources, region_codes, comuna_codes,
       candidate_limit, status, created_by
     ) values (
       $1,
       array['hvac'],
       array[$2] || case when $2 = 'brave_search' then array['official_website'] else '{}'::text[] end,
       array['13'],
       array['13101'],
       $3,
       'active',
       $4
     )
     returning id`,
    [name, source, candidateLimit, USER_ID],
  )).rows[0].id;
}

async function enqueueAndClaim(db, campaignId, workerId) {
  await db.query("select enqueue_prospecting_run($1, $2)", [campaignId, USER_ID]);
  return (await db.query(
    "select claim_prospecting_run($1, $2, 120) result",
    [API_KEY_ID, workerId],
  )).rows[0].result;
}

async function upsertCandidates(db, claim, candidates) {
  return (await db.query(
    "select upsert_prospect_candidates($1, $2, $3, $4, $5::jsonb) result",
    [
      claim.run.id,
      API_KEY_ID,
      claim.run.claimed_by_worker,
      claim.lease_token,
      JSON.stringify(candidates),
    ],
  )).rows[0].result;
}

async function completeAtLimit(db, claim) {
  return db.query(
    "select complete_prospecting_run($1, $2, $3, $4, 'completed', $5::jsonb)",
    [
      claim.run.id,
      API_KEY_ID,
      claim.run.claimed_by_worker,
      claim.lease_token,
      JSON.stringify({ limit_reached: true }),
    ],
  );
}

async function testMigrationAndNormalization(sql) {
  const db = await createDatabase(sql);
  try {
    await db.exec(sql.preflight);
    await db.exec(sql.agentApiKeys);
    await db.exec(sql.prospecting);
    await db.exec(sql.prospecting);
    await db.exec(sql.verify);
    const catalog = (await db.query(`
      select count(*)::integer regions,
             (select count(*)::integer from geo_comunas) comunas
      from geo_regions
    `)).rows[0];
    assert.deepEqual(catalog, { regions: 16, comunas: 346 });

    const normalized = (await db.query(`
      select normalize_prospect_name('Clima Sur Ltda.') name,
             normalize_prospect_phone('9 8765 4321') phone,
             normalize_prospect_rut('12.345.678-5') rut,
             normalize_prospect_domain('https://www.ventas.climaandes.cl/ruta') domain,
             normalize_prospect_domain('https://foo.co.cl/ruta') domain_co_cl,
             normalize_prospect_address('Avda. Apoquindo 1, Depto 2') address
    `)).rows[0];
    assert.deepEqual(normalized, {
      name: "CLIMA SUR",
      phone: "+56987654321",
      rut: "12345678-5",
      domain: "climaandes.cl",
      domain_co_cl: "foo.co.cl",
      address: "AV APOQUINDO 1 DPTO 2",
    });

    await assert.rejects(
      db.query(`
        insert into prospecting_campaigns(name, keywords)
        values ('Keyword demasiado larga', array[repeat('x', 201)])
      `),
      /prospecting_campaign_keywords_contract_check/i,
    );
    await assert.rejects(
      db.query(`
        insert into prospecting_campaigns(name, keywords)
        select 'Demasiadas keywords', array_agg('keyword-' || value order by value)
        from generate_series(1, 51) value
      `),
      /prospecting_campaign_keywords_contract_check/i,
    );
    await assert.rejects(
      db.query(`
        insert into prospecting_campaigns(name, keywords)
        values ('Keywords duplicadas', array['HVAC', 'hvac'])
      `),
      /prospecting_campaign_keywords_contract_check/i,
    );

    // Simula una tabla de revision anterior sin el CHECK nuevo. El RPC debe
    // rechazarla aun asi y la reaplicacion de la migracion debe convergerla.
    await configureAdmin(db);
    await db.exec(`
      alter table prospecting_campaigns
        drop constraint prospecting_campaign_keywords_contract_check;
    `);
    const legacyInvalidCampaign = (await db.query(`
      insert into prospecting_campaigns(
        name, keywords, sources, region_codes, comuna_codes, status, created_by
      )
      select 'Keywords legacy invalidas',
             array_agg(case
               when value = 1 then ' HVAC '
               when value = 2 then 'hvac'
               else 'keyword-' || value
             end order by value),
             array['google_places'], array['13'], array['13101'], 'active', $1
      from generate_series(1, 55) value
      returning id
    `, [USER_ID])).rows[0].id;
    await assert.rejects(
      db.query("select enqueue_prospecting_run($1, $2)", [legacyInvalidCampaign, USER_ID]),
      /Campaign keywords must contain 1 to 50 unique trimmed values/i,
    );

    // Simula una revision temprana parcialmente aplicada y verifica que una
    // nueva ejecucion del SQL converge, no sólo una base limpia.
    await db.exec(`
      alter table prospecting_campaigns drop column target_types cascade;
      alter table prospecting_campaign_candidates drop column candidate_snapshot cascade;
      alter table prospect_source_records drop column retention_until cascade;
      alter table company_locations drop column source_prospect_location_id cascade;
    `);
    await db.exec(sql.prospecting);
    const restored = (await db.query(`
      select count(*)::integer restored
      from information_schema.columns
      where table_schema = 'public'
        and (table_name, column_name) in (
          ('prospecting_campaigns', 'target_types'),
          ('prospecting_campaign_candidates', 'candidate_snapshot'),
          ('prospect_source_records', 'retention_until'),
          ('company_locations', 'source_prospect_location_id')
        )
    `)).rows[0].restored;
    assert.equal(restored, 4);
    const convergedKeywords = (await db.query(`
      select keywords, prospecting_keywords_valid(keywords) valid
      from prospecting_campaigns where id = $1
    `, [legacyInvalidCampaign])).rows[0];
    assert.equal(convergedKeywords.valid, true);
    assert.equal(convergedKeywords.keywords.length, 50);
    assert.equal(convergedKeywords.keywords[0], "HVAC");
    assert.equal(
      new Set(convergedKeywords.keywords.map((keyword) => keyword.toLowerCase())).size,
      convergedKeywords.keywords.length,
    );
  } finally {
    await db.close();
  }
}

async function testRunContract(sql) {
  const db = await createDatabase(sql);
  try {
    await db.exec(sql.prospecting);
    await configureAdmin(db);

    await assert.rejects(
      db.query(`
        insert into prospecting_campaigns(
          name, keywords, sources, region_codes, comuna_codes, target_types, created_by
        ) values ($1, array['hvac'], array['brave_search'], array['13'], array['13101'], array['invalido'], $2)
      `, ["x".repeat(201), USER_ID]),
      /prospecting_campaign/i,
    );

    await assert.rejects(
      db.query(`
        insert into prospecting_campaigns(
          name, keywords, sources, region_codes, comuna_codes, target_types, created_by
        ) values (
          'Brave sin respaldo', array['hvac'], array['brave_search'],
          array['13'], array['13101'], array['otro'], $1
        )
      `, [USER_ID]),
      /brave_requires_official/i,
    );

    const campaignId = await insertCampaign(db, "Historial", "brave_search");
    const first = await enqueueAndClaim(db, campaignId, "worker-a");
    const oversized = candidate({
      id: "oversized",
      name: "Demasiada evidencia",
      url: "https://oversized.cl",
      phone: "9 8765 4321",
    });
    oversized.evidence = Array.from({ length: 101 }, (_, index) => ({
      ...oversized.evidence[index % oversized.evidence.length],
      field: `field-${index}`,
    }));
    await assert.rejects(
      upsertCandidates(db, first, [oversized]),
      /evidence must contain between 1 and 100/i,
    );
    const cap = await upsertCandidates(db, first, [
      candidate({ id: "a", name: "Clima Uno", url: "https://uno-clima.cl", phone: "9 8765 4321" }),
      candidate({ id: "b", name: "Clima Dos", url: "https://dos-clima.cl", phone: "2 2345 6789" }),
    ]);
    assert.equal(cap.accepted, 1);
    assert.equal(cap.rejected_limit, 1);
    assert.equal(cap.limit_reached, true);
    await completeAtLimit(db, first);

    const second = await enqueueAndClaim(db, campaignId, "worker-b");
    await upsertCandidates(db, second, [
      candidate({ id: "a-2", name: "Clima Uno", url: "https://uno-clima.cl", phone: "2 2345 6789" }),
    ]);
    await completeAtLimit(db, second);

    const history = (await db.query(`
      select count(distinct run_id)::integer runs
      from prospect_source_records
      where provider = 'brave_search' and provider_record_id = 'https://uno-clima.cl'
    `)).rows[0];
    assert.equal(history.runs, 2);
    const phones = (await db.query(`
      select candidate_snapshot->>'phone' phone
      from prospecting_campaign_candidates
      order by first_seen_at, id
    `)).rows.map((row) => row.phone);
    assert.deepEqual(new Set(phones), new Set(["9 8765 4321", "2 2345 6789"]));

    const firstCandidateId = (await db.query(
      "select id from prospecting_campaign_candidates where run_id = $1",
      [first.run.id],
    )).rows[0].id;
    const approval = (await db.query(
      "select review_prospect_candidate($1, 'approve', null, null) result",
      [firstCandidateId],
    )).rows[0].result;
    assert.ok(approval.company_id);
    const secondCandidateId = (await db.query(
      "select id from prospecting_campaign_candidates where run_id = $1",
      [second.run.id],
    )).rows[0].id;
    const unrelatedCompanyId = (await db.query(
      "insert into companies(name) values ('Empresa no relacionada') returning id",
    )).rows[0].id;
    await assert.rejects(
      db.query(
        "select review_prospect_candidate($1, 'link', $2, null)",
        [secondCandidateId, unrelatedCompanyId],
      ),
      /already linked to a different company/i,
    );
    const linked = (await db.query(
      "select review_prospect_candidate($1, 'approve', null, null) result",
      [secondCandidateId],
    )).rows[0].result;
    assert.equal(linked.company_id, approval.company_id);

    const branchCampaign = (await db.query(`
      insert into prospecting_campaigns(
        name, keywords, sources, region_codes, comuna_codes,
        candidate_limit, status, created_by
      ) values (
        'Sucursales', array['hvac'], array['brave_search','google_places','official_website'],
        array['13'], array['13101','13114'], 2, 'active', $1
      ) returning id
    `, [USER_ID])).rows[0].id;
    const branchClaim = await enqueueAndClaim(db, branchCampaign, "worker-branches");
    const withBranch = (id, url, permanentBranch) => {
      const value = candidate({
        id,
        name: `Clima Branch ${id}`,
        url,
        phone: permanentBranch ? "9 7654 3210" : "2 2234 5678",
      });
      value.locations.push({
        country_code: "CL",
        region_code: "13",
        region_name: "Metropolitana de Santiago",
        comuna_code: "13114",
        comuna_name: "Las Condes",
      });
      value.evidence = value.evidence.map((item) =>
        item.field === "location.comuna_code"
          ? { ...item, field: "locations[0].comuna_code" }
          : item,
      );
      value.evidence.push({
        provider: permanentBranch ? "brave_search" : "google_places",
        source_url: permanentBranch ? url : "https://maps.google.com/branch",
        provider_record_id: permanentBranch ? url : `place-branch-${id}`,
        field: "locations[1].comuna_code",
        value: "13114",
        observed_at: new Date().toISOString(),
        confidence: 1,
      });
      return value;
    };
    await upsertCandidates(db, branchClaim, [
      withBranch("permanent", "https://branch-permanent.cl", true),
      withBranch("temporary", "https://branch-temporary.cl", false),
    ]);
    await completeAtLimit(db, branchClaim);
    const branchCandidates = (await db.query(`
      select id, external_candidate_id
      from prospecting_campaign_candidates
      where run_id = $1
    `, [branchClaim.run.id])).rows;
    for (const row of branchCandidates) {
      const result = (await db.query(
        "select review_prospect_candidate($1, 'approve', null, null) result",
        [row.id],
      )).rows[0].result;
      const locations = (await db.query(
        "select count(*)::integer count from company_locations where company_id = $1",
        [result.company_id],
      )).rows[0].count;
      assert.equal(locations, row.external_candidate_id === "permanent" ? 2 : 1);
    }

    const legacyCompanyId = (await db.query(`
      insert into companies(name, region_code, comuna_code, city, region)
      values ('Clima Legacy', '13', '13101', 'Santiago', 'Metropolitana de Santiago')
      returning id
    `)).rows[0].id;
    await db.query(`
      insert into company_locations(
        company_id, kind, region_code, comuna_code, address, is_primary
      ) values ($1, 'headquarters', '13', '13101', null, true)
    `, [legacyCompanyId]);
    const legacyCampaign = await insertCampaign(db, "Sede existente", "brave_search");
    const legacyClaim = await enqueueAndClaim(db, legacyCampaign, "worker-legacy-location");
    await upsertCandidates(db, legacyClaim, [candidate({
      id: "legacy-location",
      name: "Clima Legacy",
      url: "https://clima-legacy.cl",
      phone: "9 6234 5678",
    })]);
    await completeAtLimit(db, legacyClaim);
    const legacyCandidateId = (await db.query(`
      select id from prospecting_campaign_candidates where run_id = $1
    `, [legacyClaim.run.id])).rows[0].id;
    const legacyReview = (await db.query(
      "select review_prospect_candidate($1, 'approve', null, null) result",
      [legacyCandidateId],
    )).rows[0].result;
    assert.equal(legacyReview.company_id, legacyCompanyId);
    const legacyLocations = (await db.query(`
      select count(*)::integer count,
             count(source_prospect_location_id)::integer linked
      from company_locations where company_id = $1
    `, [legacyCompanyId])).rows[0];
    assert.deepEqual(legacyLocations, { count: 1, linked: 1 });

    const googleCampaign = (await db.query(`
      insert into prospecting_campaigns(
        name, keywords, sources, region_codes, comuna_codes,
        candidate_limit, status, created_by
      ) values (
        'Google temporal', array['hvac'], array['google_places','official_website'],
        array['13'], array['13101'], 3, 'active', $1
      ) returning id
    `, [USER_ID])).rows[0].id;
    const googleClaim = await enqueueAndClaim(db, googleCampaign, "worker-google");
    const oldObservation = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const emailOnly = candidate({
      id: "email-only",
      name: "Google con email aislado",
      url: "https://google-email-only.cl",
      phone: "9 6123 4567",
      provider: "google_places",
      observedAt: oldObservation,
    });
    emailOnly.email = "contacto@google-email-only.cl";
    emailOnly.evidence.push({
      provider: "official_website",
      source_url: "https://google-email-only.cl/contacto",
      provider_record_id: "https://google-email-only.cl/contacto",
      field: "email",
      value: emailOnly.email,
      observed_at: new Date().toISOString(),
      confidence: 1,
    });
    await upsertCandidates(db, googleClaim, [
      candidate({
        id: "google",
        name: "Google Only",
        url: "https://google-only.cl",
        phone: "9 6543 2109",
        provider: "google_places",
        observedAt: oldObservation,
      }),
      candidate({
        id: "repeat",
        name: "Google Reobservado",
        url: "https://google-repeat.cl",
        phone: "2 2123 4567",
        provider: "google_places",
        observedAt: oldObservation,
      }),
      emailOnly,
    ]);
    await completeAtLimit(db, googleClaim);
    const recentGoogleClaim = await enqueueAndClaim(db, googleCampaign, "worker-google-recent");
    await upsertCandidates(db, recentGoogleClaim, [candidate({
      id: "repeat",
      name: "Google Reobservado",
      url: "https://google-repeat.cl",
      phone: "2 2123 4567",
      provider: "google_places",
    })]);
    const googleCandidateId = (await db.query(`
      select id from prospecting_campaign_candidates
      where run_id = $1 and external_candidate_id = 'google'
    `, [googleClaim.run.id])).rows[0].id;
    const emailOnlyCandidateId = (await db.query(`
      select id from prospecting_campaign_candidates
      where run_id = $1 and external_candidate_id = 'email-only'
    `, [googleClaim.run.id])).rows[0].id;
    await assert.rejects(
      db.query("select review_prospect_candidate($1, 'approve', null, null)", [googleCandidateId]),
      /permanent/i,
    );
    const purge = (await db.query(
      "select purge_expired_prospect_source_records() result",
    )).rows[0].result;
    assert.ok(purge.entities_deleted >= 1);
    assert.equal((await db.query(
      "select count(*)::integer count from prospecting_campaign_candidates where id = $1",
      [googleCandidateId],
    )).rows[0].count, 0);
    assert.equal((await db.query(
      "select count(*)::integer count from prospecting_campaign_candidates where id = $1",
      [emailOnlyCandidateId],
    )).rows[0].count, 0);
    assert.equal((await db.query(`
      select count(*)::integer count
      from prospecting_campaign_candidates
      where run_id = $1 and external_candidate_id = 'repeat'
    `, [recentGoogleClaim.run.id])).rows[0].count, 1);
    await completeAtLimit(db, recentGoogleClaim);

    const recoveryCampaign = await insertCampaign(db, "Recovery", "brave_search");
    const oldClaim = await enqueueAndClaim(db, recoveryCampaign, "worker-old");
    await db.query(
      "update prospecting_tasks set status = 'running', attempts = max_attempts where run_id = $1",
      [oldClaim.run.id],
    );
    await db.query(
      "update prospecting_runs set lease_expires_at = now() - interval '1 second' where id = $1",
      [oldClaim.run.id],
    );
    const reclaimed = (await db.query(
      "select claim_prospecting_run($1, 'worker-new', 120) result",
      [API_KEY_ID],
    )).rows[0].result;
    assert.equal(reclaimed.tasks.length, 1);
    assert.equal(reclaimed.tasks[0].status, "failed");
    assert.equal(reclaimed.tasks[0].attempts, reclaimed.tasks[0].max_attempts);

    await db.query(
      "update prospecting_runs set lease_expires_at = now() - interval '1 second' where id = $1",
      [reclaimed.run.id],
    );
    await assert.rejects(
      db.query(
        "select complete_prospecting_run($1, $2, $3, $4, 'partial', '{}'::jsonb)",
        [reclaimed.run.id, API_KEY_ID, reclaimed.run.claimed_by_worker, reclaimed.lease_token],
      ),
      /Invalid run lease/i,
    );
    await assert.rejects(
      db.query(
        "select fail_prospecting_run($1, $2, $3, $4, 'late worker')",
        [reclaimed.run.id, API_KEY_ID, reclaimed.run.claimed_by_worker, reclaimed.lease_token],
      ),
      /Invalid run lease/i,
    );
    assert.equal((await db.query(
      "select status from prospecting_runs where id = $1",
      [reclaimed.run.id],
    )).rows[0].status, "running");
  } finally {
    await db.close();
  }
}

async function testSafetyRegressions(sql) {
  const db = await createDatabase(sql);
  try {
    await db.exec(sql.prospecting);
    await configureAdmin(db);

    const cappedCampaign = await insertCampaign(db, "Cap y replay", "brave_search", 1);
    const cappedClaim = await enqueueAndClaim(db, cappedCampaign, "worker-cap-replay");
    const firstObservation = candidate({
      id: "cap-company",
      name: "Clima Cap",
      url: "https://clima-cap.cl",
      phone: "9 7000 0001",
    });
    assert.equal((await upsertCandidates(db, cappedClaim, [firstObservation])).accepted, 1);

    const enrichedObservation = candidate({
      id: "cap-company-official",
      name: "Clima Cap",
      url: "https://clima-cap.cl",
      phone: "9 7000 0001",
      provider: "official_website",
    });
    const enrichedAck = await upsertCandidates(db, cappedClaim, [enrichedObservation]);
    assert.deepEqual(
      { accepted: enrichedAck.accepted, rejected: enrichedAck.rejected_limit },
      { accepted: 1, rejected: 0 },
    );
    assert.equal((await db.query(`
      select count(distinct provider)::integer providers
      from prospect_source_records where run_id = $1
    `, [cappedClaim.run.id])).rows[0].providers, 2);

    const completionPayload = JSON.stringify({ limit_reached: true });
    const firstCompletion = (await db.query(
      "select complete_prospecting_run($1, $2, $3, $4, 'completed', $5::jsonb) result",
      [
        cappedClaim.run.id,
        API_KEY_ID,
        cappedClaim.run.claimed_by_worker,
        cappedClaim.lease_token,
        completionPayload,
      ],
    )).rows[0].result;
    const eventsBeforeReplay = (await db.query(`
      select count(*)::integer count from prospecting_events
      where run_id = $1 and stage = 'completed'
    `, [cappedClaim.run.id])).rows[0].count;
    const replayedCompletion = (await db.query(
      "select complete_prospecting_run($1, $2, $3, $4, 'completed', $5::jsonb) result",
      [
        cappedClaim.run.id,
        API_KEY_ID,
        cappedClaim.run.claimed_by_worker,
        cappedClaim.lease_token,
        completionPayload,
      ],
    )).rows[0].result;
    assert.equal(replayedCompletion.status, firstCompletion.status);
    assert.equal((await db.query(`
      select count(*)::integer count from prospecting_events
      where run_id = $1 and stage = 'completed'
    `, [cappedClaim.run.id])).rows[0].count, eventsBeforeReplay);

    const validationCampaign = (await db.query(`
      insert into prospecting_campaigns(
        name, keywords, sources, region_codes, comuna_codes,
        candidate_limit, status, created_by
      ) values (
        'Validacion defensiva', array['hvac'], array['google_places','brave_search','official_website'],
        array['13'], array['13101','13114'], 20, 'active', $1
      ) returning id
    `, [USER_ID])).rows[0].id;
    const validationClaim = await enqueueAndClaim(db, validationCampaign, "worker-validation");
    const infiniteEvidence = candidate({
      id: "infinite",
      name: "Tiempo infinito",
      url: "https://tiempo-infinito.cl",
      phone: "9 7000 0002",
    });
    infiniteEvidence.evidence = infiniteEvidence.evidence.map((item) => ({ ...item, observed_at: "infinity" }));
    await assert.rejects(
      upsertCandidates(db, validationClaim, [infiniteEvidence]),
      /invalid or untraceable/i,
    );

    const ambiguousBranches = candidate({
      id: "ambiguous-branches",
      name: "Sucursales ambiguas",
      url: "https://sucursales-ambiguas.cl",
      phone: "9 7000 0003",
    });
    ambiguousBranches.locations.push({
      country_code: "CL",
      region_code: "13",
      region_name: "Metropolitana de Santiago",
      comuna_code: "13114",
      comuna_name: "Las Condes",
    });
    ambiguousBranches.evidence.push({
      ...ambiguousBranches.evidence.find((item) => item.field === "location.comuna_code"),
      field: "location.comuna_code",
      value: "13114",
    });
    await assert.rejects(
      upsertCandidates(db, validationClaim, [ambiguousBranches]),
      /Every location requires matching commune evidence/i,
    );

    const entityA = (await db.query(`
      insert into prospect_entities(name, name_normalized, rut, rut_normalized)
      values ('Entidad RUT A', 'ENTIDAD RUT A', '12.345.678-5', '12345678-5')
      returning id
    `)).rows[0].id;
    const entityB = (await db.query(`
      insert into prospect_entities(name, name_normalized, website, domain_normalized)
      values ('Entidad dominio B', 'ENTIDAD DOMINIO B', 'https://identidad-b.cl', 'identidad-b.cl')
      returning id
    `)).rows[0].id;
    await db.query(`
      insert into prospect_locations(entity_id, kind, region_code, comuna_code, is_primary)
      values ($1, 'headquarters', '13', '13101', true),
             ($2, 'headquarters', '13', '13114', true)
    `, [entityA, entityB]);

    const conflictingEntity = candidate({
      id: "conflicting-entity",
      name: "Conflicto exacto entidades",
      url: "https://identidad-b.cl",
      phone: "9 7000 0004",
    });
    conflictingEntity.rut = "12.345.678-5";
    conflictingEntity.evidence.push({
      ...conflictingEntity.evidence[0],
      field: "rut",
      value: conflictingEntity.rut,
    });
    await upsertCandidates(db, validationClaim, [conflictingEntity]);
    const quarantined = (await db.query(`
      select relation.id candidate_id, relation.entity_id, relation.review_status,
             relation.candidate_snapshot,
             entity.rut_normalized, entity.domain_normalized, entity.phone_normalized
      from prospecting_campaign_candidates relation
      join prospect_entities entity on entity.id = relation.entity_id
      where relation.run_id = $1 and relation.external_candidate_id = 'conflicting-entity'
    `, [validationClaim.run.id])).rows[0];
    assert.notEqual(quarantined.entity_id, entityA);
    assert.notEqual(quarantined.entity_id, entityB);
    assert.equal(quarantined.review_status, "possible_duplicate");
    assert.equal(quarantined.rut_normalized, null);
    assert.equal(quarantined.domain_normalized, null);
    assert.ok(quarantined.candidate_snapshot.review_flags.includes("conflicting_exact_identifiers"));
    assert.equal((await db.query(
      "select website from prospect_entities where id = $1",
      [entityA],
    )).rows[0].website, null);

    await assert.rejects(
      db.query("select review_prospect_candidate($1, 'approve', null, null)", [quarantined.candidate_id]),
      /explicit link or rejection/i,
    );
    const companyA = (await db.query(`
      insert into companies(name, rut) values ('Empresa RUT A', '12.345.678-5') returning id
    `)).rows[0].id;
    await db.query(
      "select review_prospect_candidate($1, 'link', $2, 'Identidad resuelta manualmente')",
      [quarantined.candidate_id, companyA],
    );
    const companyAAfterLink = (await db.query(
      "select website, phone from companies where id = $1",
      [companyA],
    )).rows[0];
    assert.deepEqual(companyAAfterLink, { website: null, phone: null });

    const companyC = (await db.query(`
      insert into companies(name, rut) values ('Empresa RUT C', '76.123.456-0') returning id
    `)).rows[0].id;
    const companyD = (await db.query(`
      insert into companies(name, website) values ('Empresa dominio D', 'https://identidad-d.cl') returning id
    `)).rows[0].id;
    const companyConflict = candidate({
      id: "conflicting-companies",
      name: "Conflicto exacto empresas",
      url: "https://identidad-d.cl",
      phone: "9 7000 0005",
    });
    companyConflict.rut = "76.123.456-0";
    companyConflict.evidence.push({
      ...companyConflict.evidence[0],
      field: "rut",
      value: companyConflict.rut,
    });
    await upsertCandidates(db, validationClaim, [companyConflict]);
    const companyShell = (await db.query(`
      select relation.id candidate_id, relation.candidate_snapshot,
             entity.rut_normalized, entity.domain_normalized
      from prospecting_campaign_candidates relation
      join prospect_entities entity on entity.id = relation.entity_id
      where relation.run_id = $1 and relation.external_candidate_id = 'conflicting-companies'
    `, [validationClaim.run.id])).rows[0];
    assert.equal(companyShell.rut_normalized, null);
    assert.equal(companyShell.domain_normalized, null);
    assert.ok(companyShell.candidate_snapshot.review_flags.includes("conflicting_exact_company_identifiers"));
    await assert.rejects(
      db.query("select review_prospect_candidate($1, 'approve', null, null)", [companyShell.candidate_id]),
      /explicit link or rejection/i,
    );
    await db.query(
      "select review_prospect_candidate($1, 'link', $2, null)",
      [companyShell.candidate_id, companyC],
    );
    assert.deepEqual((await db.query(
      "select website, phone from companies where id = $1",
      [companyC],
    )).rows[0], { website: null, phone: null });
    assert.ok(companyD);

    // Una coincidencia inferior no puede absorber un identificador superior
    // contradictorio: RUT > proveedor > dominio > telefono > nombre+sede.
    const rutHierarchyEntity = (await db.query(`
      insert into prospect_entities(
        name, name_normalized, rut, rut_normalized, website, domain_normalized,
        phone, phone_normalized
      ) values (
        'Entidad jerarquia RUT', 'ENTIDAD JERARQUIA RUT', '11.111.111-1', '11111111-1',
        'https://jerarquia-rut.cl', 'jerarquia-rut.cl', '9 8111 1111', '+56981111111'
      ) returning id
    `)).rows[0].id;
    const rutHierarchyCandidate = candidate({
      id: "hierarchy-rut",
      name: "Candidato RUT contradictorio",
      url: "https://jerarquia-rut.cl",
      phone: "9 8111 1111",
    });
    rutHierarchyCandidate.rut = "22.222.222-2";
    rutHierarchyCandidate.evidence.push({
      ...rutHierarchyCandidate.evidence[0],
      field: "rut",
      value: rutHierarchyCandidate.rut,
    });
    await upsertCandidates(db, validationClaim, [rutHierarchyCandidate]);
    const rutHierarchyShell = (await db.query(`
      select relation.id candidate_id, relation.entity_id, relation.review_status,
             relation.candidate_snapshot, entity.rut_normalized, entity.domain_normalized,
             entity.phone_normalized
      from prospecting_campaign_candidates relation
      join prospect_entities entity on entity.id = relation.entity_id
      where relation.run_id = $1 and relation.external_candidate_id = 'hierarchy-rut'
    `, [validationClaim.run.id])).rows[0];
    assert.notEqual(rutHierarchyShell.entity_id, rutHierarchyEntity);
    assert.equal(rutHierarchyShell.review_status, "possible_duplicate");
    assert.deepEqual(
      [rutHierarchyShell.rut_normalized, rutHierarchyShell.domain_normalized, rutHierarchyShell.phone_normalized],
      [null, null, null],
    );
    assert.ok(rutHierarchyShell.candidate_snapshot.review_flags.includes("conflicting_exact_identifiers"));
    assert.equal((await db.query(`
      select count(*)::integer count from prospect_source_records
      where entity_id = $1 and metadata->>'candidate_id' = 'hierarchy-rut'
    `, [rutHierarchyEntity])).rows[0].count, 0);
    assert.equal((await db.query(
      "select count(*)::integer count from prospect_locations where entity_id = $1",
      [rutHierarchyEntity],
    )).rows[0].count, 0);

    const providerHierarchyEntity = (await db.query(`
      insert into prospect_entities(name, name_normalized, website, domain_normalized)
      values ('Entidad jerarquia proveedor', 'ENTIDAD JERARQUIA PROVEEDOR',
              'https://jerarquia-proveedor.cl', 'jerarquia-proveedor.cl')
      returning id
    `)).rows[0].id;
    await db.query(`
      insert into prospect_source_records(
        entity_id, provider, provider_record_id, field_name, field_value,
        observed_at, retention_until
      ) values ($1, 'google_places', 'place-old', 'provider_id', 'place-old', now(), now() + interval '30 days')
    `, [providerHierarchyEntity]);
    const providerHierarchyCandidate = candidate({
      id: "hierarchy-provider",
      name: "Candidato proveedor contradictorio",
      url: "https://jerarquia-proveedor.cl",
      phone: "9 8222 2222",
      provider: "google_places",
    });
    await upsertCandidates(db, validationClaim, [providerHierarchyCandidate]);
    const providerHierarchyShell = (await db.query(`
      select relation.entity_id, relation.review_status, relation.candidate_snapshot,
             entity.domain_normalized
      from prospecting_campaign_candidates relation
      join prospect_entities entity on entity.id = relation.entity_id
      where relation.run_id = $1 and relation.external_candidate_id = 'hierarchy-provider'
    `, [validationClaim.run.id])).rows[0];
    assert.notEqual(providerHierarchyShell.entity_id, providerHierarchyEntity);
    assert.equal(providerHierarchyShell.review_status, "possible_duplicate");
    assert.equal(providerHierarchyShell.domain_normalized, null);
    assert.ok(providerHierarchyShell.candidate_snapshot.review_flags.includes("conflicting_exact_identifiers"));
    assert.equal((await db.query(`
      select count(*)::integer count from prospect_source_records
      where entity_id = $1 and metadata->>'candidate_id' = 'hierarchy-provider'
    `, [providerHierarchyEntity])).rows[0].count, 0);

    const sameLevelProviderEntity = (await db.query(`
      insert into prospect_entities(name, name_normalized)
      values ('Entidad proveedores mismo nivel', 'ENTIDAD PROVEEDORES MISMO NIVEL')
      returning id
    `)).rows[0].id;
    await db.query(`
      insert into prospect_source_records(
        entity_id, provider, provider_record_id, field_name, field_value,
        observed_at, retention_until
      ) values
        ($1, 'google_places', 'place-shared', 'provider_id', 'place-shared', now(), now() + interval '30 days'),
        ($1, 'official_website', 'https://sitio-anterior.cl', 'provider_id',
             'https://sitio-anterior.cl', now(), null)
    `, [sameLevelProviderEntity]);
    const sameLevelProviderCandidate = candidate({
      id: "hierarchy-provider-same-level",
      name: "Candidato proveedores mismo nivel",
      url: "https://sitio-nuevo.cl",
      phone: "9 8255 2255",
      provider: "google_places",
    });
    sameLevelProviderCandidate.provider_ids.google_places = "place-shared";
    sameLevelProviderCandidate.provider_ids.official_website = "https://sitio-nuevo.cl";
    sameLevelProviderCandidate.evidence.push(
      ...sameLevelProviderCandidate.evidence.map((item) => ({
        ...item,
        provider: "official_website",
        source_url: "https://sitio-nuevo.cl",
        provider_record_id: "https://sitio-nuevo.cl",
      })),
    );
    await upsertCandidates(db, validationClaim, [sameLevelProviderCandidate]);
    const sameLevelProviderShell = (await db.query(`
      select relation.id candidate_id, relation.entity_id, relation.review_status,
             relation.candidate_snapshot, entity.rut_normalized,
             entity.domain_normalized, entity.phone_normalized
      from prospecting_campaign_candidates relation
      join prospect_entities entity on entity.id = relation.entity_id
      where relation.run_id = $1
        and relation.external_candidate_id = 'hierarchy-provider-same-level'
    `, [validationClaim.run.id])).rows[0];
    assert.notEqual(sameLevelProviderShell.entity_id, sameLevelProviderEntity);
    assert.equal(sameLevelProviderShell.review_status, "possible_duplicate");
    assert.deepEqual(
      [sameLevelProviderShell.rut_normalized, sameLevelProviderShell.domain_normalized,
       sameLevelProviderShell.phone_normalized],
      [null, null, null],
    );
    assert.ok(sameLevelProviderShell.candidate_snapshot.review_flags.includes("conflicting_exact_identifiers"));
    assert.equal((await db.query(`
      select count(*)::integer count from prospect_source_records
      where entity_id = $1 and metadata->>'candidate_id' = 'hierarchy-provider-same-level'
    `, [sameLevelProviderEntity])).rows[0].count, 0);
    assert.equal((await db.query(
      "select count(*)::integer count from prospect_locations where entity_id = $1",
      [sameLevelProviderEntity],
    )).rows[0].count, 0);
    await assert.rejects(
      db.query("select review_prospect_candidate($1, 'approve', null, null)", [sameLevelProviderShell.candidate_id]),
      /explicit link or rejection/i,
    );

    const domainHierarchyEntity = (await db.query(`
      insert into prospect_entities(
        name, name_normalized, website, domain_normalized, phone, phone_normalized
      ) values (
        'Entidad jerarquia dominio', 'ENTIDAD JERARQUIA DOMINIO',
        'https://dominio-anterior.cl', 'dominio-anterior.cl', '9 8333 3333', '+56983333333'
      ) returning id
    `)).rows[0].id;
    const domainHierarchyCandidate = candidate({
      id: "hierarchy-domain",
      name: "Candidato dominio contradictorio",
      url: "https://dominio-nuevo.cl",
      phone: "9 8333 3333",
    });
    await upsertCandidates(db, validationClaim, [domainHierarchyCandidate]);
    const domainHierarchyShell = (await db.query(`
      select relation.entity_id, relation.review_status, relation.candidate_snapshot,
             entity.domain_normalized, entity.phone_normalized
      from prospecting_campaign_candidates relation
      join prospect_entities entity on entity.id = relation.entity_id
      where relation.run_id = $1 and relation.external_candidate_id = 'hierarchy-domain'
    `, [validationClaim.run.id])).rows[0];
    assert.notEqual(domainHierarchyShell.entity_id, domainHierarchyEntity);
    assert.equal(domainHierarchyShell.review_status, "possible_duplicate");
    assert.deepEqual([domainHierarchyShell.domain_normalized, domainHierarchyShell.phone_normalized], [null, null]);
    assert.ok(domainHierarchyShell.candidate_snapshot.review_flags.includes("conflicting_exact_identifiers"));
    assert.equal((await db.query(`
      select count(*)::integer count from prospect_source_records
      where entity_id = $1 and metadata->>'candidate_id' = 'hierarchy-domain'
    `, [domainHierarchyEntity])).rows[0].count, 0);

    const hierarchyCompany = (await db.query(`
      insert into companies(name, rut, phone)
      values ('Empresa jerarquia historica', '33.333.333-3', '9 8444 4444')
      returning id
    `)).rows[0].id;
    const hierarchyCompanyCandidate = candidate({
      id: "hierarchy-company",
      name: "Candidato empresa contradictoria",
      url: "https://empresa-jerarquia-nueva.cl",
      phone: "9 8444 4444",
    });
    hierarchyCompanyCandidate.rut = "44.444.444-4";
    hierarchyCompanyCandidate.evidence.push({
      ...hierarchyCompanyCandidate.evidence[0],
      field: "rut",
      value: hierarchyCompanyCandidate.rut,
    });
    await upsertCandidates(db, validationClaim, [hierarchyCompanyCandidate]);
    const hierarchyCompanyShell = (await db.query(`
      select relation.id candidate_id, relation.entity_id, relation.review_status,
             relation.possible_duplicate_company_id, relation.candidate_snapshot,
             entity.rut_normalized, entity.phone_normalized
      from prospecting_campaign_candidates relation
      join prospect_entities entity on entity.id = relation.entity_id
      where relation.run_id = $1 and relation.external_candidate_id = 'hierarchy-company'
    `, [validationClaim.run.id])).rows[0];
    assert.equal(hierarchyCompanyShell.review_status, "possible_duplicate");
    assert.equal(hierarchyCompanyShell.possible_duplicate_company_id, hierarchyCompany);
    assert.deepEqual([hierarchyCompanyShell.rut_normalized, hierarchyCompanyShell.phone_normalized], [null, null]);
    assert.ok(hierarchyCompanyShell.candidate_snapshot.review_flags.includes("conflicting_exact_company_identifiers"));
    await assert.rejects(
      db.query("select review_prospect_candidate($1, 'approve', null, null)", [hierarchyCompanyShell.candidate_id]),
      /explicit link or rejection/i,
    );

    const partialCampaign = (await db.query(`
      insert into prospecting_campaigns(
        name, keywords, sources, region_codes, comuna_codes,
        candidate_limit, status, created_by
      ) values (
        'Importacion parcial', array['hvac'], array['google_places','official_website'],
        array['13'], array['13101','13114'], 1, 'active', $1
      ) returning id
    `, [USER_ID])).rows[0].id;
    const partialClaim = await enqueueAndClaim(db, partialCampaign, "worker-partial-location");
    const partialCandidate = candidate({
      id: "partial-location",
      name: "Clima sede permanente secundaria",
      url: "https://sede-secundaria.cl",
      phone: "9 7000 0006",
      provider: "google_places",
    });
    partialCandidate.locations.push({
      country_code: "CL",
      region_code: "13",
      region_name: "Metropolitana de Santiago",
      comuna_code: "13114",
      comuna_name: "Las Condes",
    });
    partialCandidate.evidence = partialCandidate.evidence.map((item) =>
      item.field === "location.comuna_code"
        ? { ...item, field: "locations[0].comuna_code" }
        : item,
    );
    const officialBase = {
      provider: "official_website",
      source_url: "https://sede-secundaria.cl/contacto",
      provider_record_id: "https://sede-secundaria.cl",
      observed_at: new Date().toISOString(),
      confidence: 1,
    };
    partialCandidate.evidence.push(
      { ...officialBase, field: "name", value: partialCandidate.name },
      { ...officialBase, field: "phone", value: partialCandidate.phone },
      { ...officialBase, field: "website", value: partialCandidate.website },
      { ...officialBase, field: "locations[1].region_code", value: "13" },
      { ...officialBase, field: "locations[1].comuna_code", value: "13114" },
    );
    partialCandidate.import_eligible = true;
    partialCandidate.importable_location_indexes = [1];
    await upsertCandidates(db, partialClaim, [partialCandidate]);
    const partialCandidateId = (await db.query(`
      select id from prospecting_campaign_candidates
      where run_id = $1 and external_candidate_id = 'partial-location'
    `, [partialClaim.run.id])).rows[0].id;
    const partialApproval = (await db.query(
      "select review_prospect_candidate($1, 'approve', null, null) result",
      [partialCandidateId],
    )).rows[0].result;
    assert.deepEqual((await db.query(`
      select count(*)::integer count, min(comuna_code) comuna_code
      from company_locations where company_id = $1
    `, [partialApproval.company_id])).rows[0], { count: 1, comuna_code: "13114" });

    const runACampaign = (await db.query(`
      insert into prospecting_campaigns(
        name, keywords, sources, region_codes, comuna_codes,
        candidate_limit, status, created_by
      ) values (
        'Retencion Run A', array['hvac'], array['google_places','official_website'],
        array['13'], array['13101'], 1, 'active', $1
      ) returning id
    `, [USER_ID])).rows[0].id;
    const runAClaim = await enqueueAndClaim(db, runACampaign, "worker-retention-a");
    const oldObservation = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const runA = candidate({
      id: "retention-a",
      name: "Clima Run A",
      url: "https://dominio-compartido-retencion.cl",
      phone: "9 7000 0007",
      provider: "google_places",
      observedAt: oldObservation,
    });
    const runAOfficial = {
      provider: "official_website",
      source_url: "https://dominio-compartido-retencion.cl/contacto-a",
      provider_record_id: "https://dominio-compartido-retencion.cl",
      observed_at: new Date().toISOString(),
      confidence: 1,
    };
    runA.evidence.push(
      { ...runAOfficial, field: "name", value: runA.name },
      { ...runAOfficial, field: "phone", value: runA.phone },
      { ...runAOfficial, field: "website", value: runA.website },
      { ...runAOfficial, field: "location.region_code", value: "13" },
      { ...runAOfficial, field: "location.comuna_code", value: "13101" },
    );
    await upsertCandidates(db, runAClaim, [runA]);
    await completeAtLimit(db, runAClaim);

    const runBCampaign = (await db.query(`
      insert into prospecting_campaigns(
        name, keywords, sources, region_codes, comuna_codes,
        candidate_limit, status, created_by
      ) values (
        'Retencion Run B', array['hvac'], array['brave_search','official_website'],
        array['13'], array['13114'], 1, 'active', $1
      ) returning id
    `, [USER_ID])).rows[0].id;
    const runBClaim = await enqueueAndClaim(db, runBCampaign, "worker-retention-b");
    const runB = candidate({
      id: "retention-b",
      name: "Clima Run B con nombre global mucho mas largo",
      url: "https://dominio-compartido-retencion.cl",
      phone: "9 7000 0008",
      provider: "official_website",
    });
    const lasCondesLocation = {
      country_code: "CL",
      region_code: "13",
      region_name: "Metropolitana de Santiago",
      comuna_code: "13114",
      comuna_name: "Las Condes",
    };
    runB.location = lasCondesLocation;
    runB.locations = [lasCondesLocation];
    runB.evidence = runB.evidence.map((item) => {
      if (item.field === "location.comuna_code") return { ...item, value: "13114" };
      if (item.field === "location.comuna_name") return { ...item, value: "Las Condes" };
      return item;
    });
    await upsertCandidates(db, runBClaim, [runB]);
    await completeAtLimit(db, runBClaim);

    await db.query("select purge_expired_prospect_source_records()");
    const runAAfterPurge = (await db.query(`
      select candidate_snapshot
      from prospecting_campaign_candidates
      where run_id = $1 and external_candidate_id = 'retention-a'
    `, [runAClaim.run.id])).rows[0].candidate_snapshot;
    assert.equal(runAAfterPurge.name, "Clima Run A");
    assert.equal(runAAfterPurge.phone, "9 7000 0007");
    assert.deepEqual(runAAfterPurge.locations.map((location) => location.comuna_code), ["13101"]);
    assert.equal(runAAfterPurge.provider_ids.google_places, undefined);
    assert.equal(runAAfterPurge.provider_ids.official_website, "https://dominio-compartido-retencion.cl");

    const wholeRegionCampaign = (await db.query(`
      insert into prospecting_campaigns(
        name, keywords, sources, region_codes, comuna_codes,
        candidate_limit, status, created_by
      ) values (
        'Region completa', array['hvac'], array['google_places'],
        array['13'], '{}'::text[], 10, 'active', $1
      ) returning id
    `, [USER_ID])).rows[0].id;
    const wholeRegionRun = (await db.query(
      "select enqueue_prospecting_run($1, $2) result",
      [wholeRegionCampaign, USER_ID],
    )).rows[0].result;
    const expectedComunas = (await db.query(`
      select count(*)::integer count from geo_comunas where region_code = '13' and active
    `)).rows[0].count;
    assert.equal(wholeRegionRun.total_tasks, expectedComunas);
  } finally {
    await db.close();
  }
}

const sql = await loadSql();
await testMigrationAndNormalization(sql);
await testRunContract(sql);
await testSafetyRegressions(sql);
console.log("prospecting contract: ok");
