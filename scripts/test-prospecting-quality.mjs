import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateQuality, candidateCounts, candidateReviewBucket, commercialChannel, isCommercialCandidate } from "../src/modules/prospecting/prospectingQuality.ts";
import { readAllRecords } from "../src/lib/readAllRecords.ts";
import { buildCommercialBrief, CLIMACTIVA_PROSPECTING_OBJECTIVE, DEFAULT_PROSPECTING_KEYWORDS } from "../src/modules/prospecting/prospectingCommercialProfile.ts";
import { readFile } from "node:fs/promises";
import { enrichmentPauseMessage, readEnrichmentPause } from "../src/modules/prospecting/prospectingEnrichment.ts";

test("legacy quota pauses explain unlimited candidate analysis, not a next-day wait", () => {
  const run = { id: "run", enrichmentStatus: "paused", enrichmentPause: readEnrichmentPause({
    reason_code: "DAILY_LIMIT", daily_used: 20, daily_limit: 20, auto_resume: true, resume_after: "2026-09-14T03:00:00Z",
  }) };
  const message = enrichmentPauseMessage(run);
  assert.match(message, /tope diario ya no aplica/); assert.doesNotMatch(message, /20 de 20|00:00/);
  assert.match(message, /automatica/);
  assert.equal(enrichmentPauseMessage({ ...run, enrichmentStatus: "running" }), "");
  assert.equal(readEnrichmentPause({ reason_code: "DAILY_LIMIT", resume_after: "invalid", auto_resume: true }).autoResume, false);
  assert.equal(readEnrichmentPause({}), undefined);
  const historical = enrichmentPauseMessage({ ...run, enrichmentPause: undefined }, [{ runId: "run", enrichmentError: "Investigacion pausada: DAILY_LIMIT" }]);
  assert.match(historical, /reanudar los pendientes sin repetir/);
  assert.equal(enrichmentPauseMessage({ ...run, enrichmentPause: undefined }, [{ runId: "other", enrichmentError: "Investigacion pausada: DAILY_LIMIT" }]), "");
  assert.equal(enrichmentPauseMessage({ ...run, enrichmentPause: readEnrichmentPause({reason_code:"MANUAL"}) }), "");
  assert.match(enrichmentPauseMessage({ ...run, enrichmentPause: readEnrichmentPause({reason_code:"INSUFFICIENT_BALANCE"}) }), /no se realizan recargas automaticas/);
  assert.match(enrichmentPauseMessage({ ...run, enrichmentPause: readEnrichmentPause({reason_code:"RATE_LIMIT"}) }), /temporalmente/);
});

const candidate = () => ({ name: "Clima Andes", phone: "+56721234567", email: "ventas@climaandes.com", website: "https://climaandes.com",
  discoveryStatus: "validated", enrichmentSummary: { validation_version: "public-web-v4" }, importEligible: true, reviewFlags: [], businessLine: "Tienda y distribuidor de aire acondicionado",
  locations: [{ regionCode: "06", comunaCode: "06101", address: "Av. Republica 100" }],
  evidence: [{ field: "name", value: "Clima Andes" }, { field: "phone", value: "+56721234567" }, { field: "description", value: "Tienda y distribuidor de aire acondicionado" }, {field:"location.address",value:"Av. Republica 100"}].map(e => ({ ...e, source: "official_website", url: "https://climaandes.com/contacto" })),
});

test("historical validations and directory contacts cannot enter the contactable list", () => {
  for (const enrichmentSummary of [{}, { validation_version: "public-web-v3" }])
    assert.equal(candidateQuality({ ...candidate(), enrichmentSummary }), "pending");
  const directory = "Ferreterias Chile es el directorio mas completo de ferreterias en Chile";
  assert.equal(candidateQuality({ ...candidate(), businessLine: directory }), "outside");
  for (const field of ["name", "phone", "description"]) {
    const evidence = candidate().evidence.map(e => e.field === field ? { ...e, url: "https://directorio.cl/empresa" } : e);
    assert.equal(candidateQuality({ ...candidate(), evidence }), "pending");
  }
  const otherSector = "Tienda y servicio de reparacion de computadores y celulares";
  const evidence = candidate().evidence.map(e => e.field === "description" ? { ...e, value: otherSector } : e);
  assert.equal(candidateQuality({ ...candidate(), businessLine: otherSector, evidence }), "pending");
});

test("contactable list requires identity, activity, territory and business contact evidence", () => {
  assert.equal(candidateQuality(candidate()), "contactable");
  for (const changes of [{ phone: "", email: "" }, { evidence: [] }, { locations: [] }, { businessLine: "" }, { discoveryStatus: "pending" }, { importEligible: false }])
    assert.equal(candidateQuality({ ...candidate(), ...changes }), "pending");
  for (const changes of [{ phone: "+5492915666646" }, { website: "https://extremominero.com.ar" }, { reviewFlags: ["official_identity_conflict"] }, { reviewFlags: ["outside_target_types"] }])
    assert.equal(candidateQuality({ ...candidate(), ...changes }), "outside");
});

test("the review counters partition all 11 discoveries and never count approved rows as waiting", () => {
  const rows = [
    ...Array.from({length:3},()=>({...candidate(),reviewStatus:"pending"})),
    ...Array.from({length:5},()=>({...candidate(),reviewStatus:"pending",importEligible:false})),
    {...candidate(),reviewStatus:"pending",phone:"+5492915666646"},
    {...candidate(),reviewStatus:"approved"}, {...candidate(),reviewStatus:"linked"},
  ];
  assert.deepEqual(candidateCounts(rows),{total:11,contactable:3,pending:5,outside:1,reviewed:2,rejected:0});
  assert.equal(rows.filter(c=>candidateReviewBucket(c)==="contactable").length,3);
});

test("all evidence pages are read, even beyond the default 1000-row API cap", async () => {
  const rows = Array.from({ length: 1803 }, (_, i) => ({ id: String(i) })), calls = [];
  const result = await readAllRecords(async (from, to) => {
    calls.push([from, to]); return { data: rows.slice(from, to + 1), count: rows.length, error: null };
  });
  assert.equal(result.length, 1803); assert.equal(calls.length, 4);
  await assert.rejects(readAllRecords(async () => ({ data: [], count: 1, error: null })), /completar/);
});

test("candidate tab includes only qualified companies while findings retain all research", async () => {
  const rows = [
    ...Array.from({length:3},()=>({...candidate(),reviewStatus:"pending"})),
    ...Array.from({length:2},()=>({...candidate(),reviewStatus:"pending",importEligible:false})),
    ...Array.from({length:6},()=>({...candidate(),reviewStatus:"rejected"})),
  ];
  assert.deepEqual(candidateCounts(rows),{total:11,contactable:3,pending:2,outside:0,reviewed:0,rejected:6});
  const page = await readFile(new URL("../src/modules/prospecting/ProspectingPage.tsx", import.meta.url), "utf8");
  assert.ok(page.includes('Candidatos <span className="tab-count">{contactableCandidates.length}</span>'));
  assert.ok(page.includes('Hallazgos <span className="tab-count">{campaignCandidates.length}</span>'));
  assert.equal(rows.filter(isCommercialCandidate).length,3);
  assert.match(page,/tab === "candidates" \? contactableCandidates : campaignCandidates/);
});

test("Climactiva requires HVAC resale premises or service execution, never a generic shop or end user", () => {
  const cases = [
    ["Tienda especializada en equipos de aire acondicionado",true,"retail"],
    ["Tienda especializada en equipos de aire acondicionado",false,null],
    ["Distribuidor online de equipos de climatizacion",true,null],
    ["Empresa de instalacion y mantencion de climatizacion residencial",false,"services"],
    ["Contratistas de refrigeracion industrial",true,"services"],
    ["Empresa de servicios de aire acondicionado residencial",true,"services"],
    ["Nuestras instalaciones cuentan con aire acondicionado",true,null],
    ["Optica y venta de lentes",true,null],
    ["Centro comercial con aire acondicionado",true,null],
    ["Venta de neumaticos y reparacion de aire acondicionado automotriz",true,null],
    ["No realizamos instalacion de aire acondicionado",true,null],
    ["Tienda de ropa y calzado",true,null],
  ];
  for(const [activity,address,expected] of cases) assert.equal(commercialChannel(activity,address),expected,activity);
  const noAddressProof={...candidate(),evidence:candidate().evidence.filter(e=>e.field!=="location.address")};
  assert.equal(candidateQuality(noAddressProof),"pending");
  const otherCompanyAddress={...candidate(),evidence:candidate().evidence.map(e=>e.field==="location.address"?{...e,url:"https://otra.cl"}:e)};
  assert.equal(candidateQuality(otherCompanyAddress),"pending");
  for(const name of ["GMO","Ripley Rancagua","Cenco Rancagua","Rancagua Outlet Mall","Neumamundo"])
    assert.equal(isCommercialCandidate({...candidate(),name,businessLine:"otro",importEligible:false}),false,name);
});

test("Climactiva defaults cover shops, services and all three segments without truncation", async () => {
  assert.equal(DEFAULT_PROSPECTING_KEYWORDS.length, 11);
  assert.equal(new Set(DEFAULT_PROSPECTING_KEYWORDS).size, 11);
  assert.ok(DEFAULT_PROSPECTING_KEYWORDS.every(k => k.length <= 200));
  assert.ok(DEFAULT_PROSPECTING_KEYWORDS.every(k => /climatizacion|refrigeracion|aire acondicionado/.test(k)), "Every default phrase must include the HVAC sector");
  const keywords = DEFAULT_PROSPECTING_KEYWORDS.join(" ");
  for (const term of ["tiendas", "locales comerciales", "distribuidores", "servicios", "mantencion", "mantenimiento", "reparacion", "instalacion", "residencial", "comercial", "industrial", "grandes proyectos"])
    assert.ok(keywords.includes(term), term);
  assert.match(CLIMACTIVA_PROSPECTING_OBJECTIVE, /no necesitan tener tienda/);
  assert.match(CLIMACTIVA_PROSPECTING_OBJECTIVE, /exclusivamente del rubro/);
  const page = await readFile(new URL("../src/modules/prospecting/ProspectingPage.tsx", import.meta.url), "utf8");
  assert.ok(!page.includes("DEFAULT_PROSPECTING_KEYWORDS.slice"));
  assert.match(page, /initialCampaign\?\.keywords \?\? \[\.\.\.DEFAULT_PROSPECTING_KEYWORDS\]/);
  assert.match(page, /initialCampaign\?\.targetTypes \?\? \[\.\.\.DEFAULT_PROSPECTING_TARGET_TYPES\]/);
  const apply = page.slice(page.indexOf("function applyClimactivaProfile()"), page.indexOf("function submit(event:"));
  assert.match(apply, /setDescription\(CLIMACTIVA_PROSPECTING_OBJECTIVE\)/);
  for (const untouched of ["setSelection", "setSources", "setResultsPerTask", "setMaxCandidates", "onSave", "startRun"])
    assert.ok(!apply.includes(untouched), `Profile must not change ${untouched}`);
});

test("visit brief uses matching official activity, not guessed project scale or CRM summary", () => {
  const activity = "Empresa de mantencion e instalacion de climatizacion residencial y refrigeracion comercial e industrial";
  const company = { ...candidate(), businessLine: activity, companySummary: "Mayor distribuidor nacional con 30 proyectos",
    evidence: [{ source: "official_website", field: "description", value: activity, url: "https://climaandes.com/servicios" }] };
  const brief = buildCommercialBrief(company);
  assert.deepEqual(brief.approaches, ["Suministro para servicios y proyectos"]);
  assert.deepEqual(brief.segments, ["Residencial", "Comercial", "Industrial"]);
  assert.equal(brief.activity[0].url, "https://climaandes.com/servicios");
  for (const changes of [{ source: "deepseek_web" }, { url: "https://directorio.cl" }, { value: "Texto de otra empresa" }]) {
    const rejected = buildCommercialBrief({ ...company, evidence: [{ ...company.evidence[0], ...changes }] });
    assert.deepEqual(rejected.approaches, []); assert.deepEqual(rejected.segments, []);
  }
  const shop = "Tienda y distribuidor con local comercial de equipos de aire acondicionado";
  const retail = buildCommercialBrief({ ...company, businessLine: shop, evidence: [{ ...company.evidence[0], value: shop }] });
  assert.deepEqual(retail.approaches, ["Distribución y reventa de productos"]);
  assert.deepEqual(retail.segments, [], "A commercial shop does not establish commercial HVAC project experience");
  const excluded = "Instalacion de aire acondicionado para comercios. No realizamos proyectos industriales ni venta de equipos.";
  const limited = buildCommercialBrief({ ...company, businessLine: excluded, evidence: [{ ...company.evidence[0], value: excluded }] });
  assert.deepEqual(limited.approaches, ["Suministro para servicios y proyectos"]);
  assert.deepEqual(limited.segments, ["Comercial"]);
});
