import test from "node:test";
import assert from "node:assert/strict";
import {
  copilotConfig,
  reasoningFor,
} from "../supabase/functions/crm-copilot/config.ts";
import {
  liveSessionConfig,
  stableVoiceId,
  ownedVoice,
  liveHandler,
  spokenFacts,
  liveCommand,
} from "../supabase/functions/crm-copilot/live.ts";
import {
  LiveTranscript,
  microphoneError,
} from "../src/modules/copilot/liveProtocol.ts";
const settings = copilotConfig(
  (k) =>
    ({
      OPENAI_API_KEY: "sk-private-never-return-to-browser",
      OPENAI_REASONING_MODEL: "configured-reasoning",
      OPENAI_LIVE_MODEL: "configured-voice",
    })[k],
);
const user = "00000000-0000-4000-8000-000000000001",
  conv = "00000000-0000-4000-8000-000000000002",
  voice = "00000000-0000-4000-8000-000000000003",
  msg = "00000000-0000-4000-8000-000000000004";
const req = (route, body) =>
  new Request("https://crm.test/" + route, {
    method: "POST",
    body: JSON.stringify(body),
  });
function source(overrides = {}) {
  const writes = [];
  return {
    actor: { id: user, role: "administrador" },
    writes,
    async select(path) {
      if (path.includes("live_session_created"))
        return [
          {
            id: voice,
            conversation_id: conv,
            created_at: new Date().toISOString(),
            metadata_redacted: { role: "administrador", liveId: "live_opaque" },
          },
        ];
      if (path.includes("live_session_ended")) return [];
      if (path.startsWith("copilot_conversations"))
        return [
          {
            id: conv,
            created_at: new Date().toISOString(),
            metadata: { engine: "central", role: "administrador" },
          },
        ];
      if (path.startsWith("copilot_messages"))
        return [
          {
            id: msg,
            role: "assistant",
            content: "Ventas netas 100 CLP. Margen provisional.",
            metadata: { voiceSessionId: voice, delegationId: "item_task" },
          },
        ];
      return [];
    },
    async request(path, init) {
      writes.push({ path, body: JSON.parse(init.body) });
      return [{ id: voice }];
    },
    ...overrides,
  };
}
test("Reasoning model and voice are configured centrally; effort scales by task", () => {
  assert.equal(settings.model, "configured-reasoning");
  assert.equal(settings.liveModel, "configured-voice");
  assert.equal(reasoningFor("cuanto vendimos hoy"), "low");
  assert.equal(reasoningFor("Compara con agosto"), "medium");
  assert.equal(reasoningFor("Genera un informe financiero"), "high");
  assert.equal(reasoningFor("informe", "low"), "low");
});
test("Live uses client delegation, no credentials or CRM tools reach frontend configuration", () => {
  const config = liveSessionConfig(settings, [
    { role: "user", content: "hola sk-abcdefghijklmnop" },
    { role: "assistant", content: "resultado" },
  ]);
  assert.deepEqual(config.delegation, { type: "client" });
  assert.equal(config.store, false);
  assert.equal(config.model, "configured-voice");
  assert.equal(config.input[1].content[0].type, "output_text");
  assert.ok(!JSON.stringify(config).includes("sk-"));
  assert.ok(
    !config.client.data_channel.allowed_client_events.includes(
      "session.instructions.append",
    ),
  );
  assert.ok(
    !config.client.data_channel.allowed_client_events.includes(
      "response.create",
    ),
  );
  assert.ok(
    !config.client.data_channel.allowed_server_events.some(
      (e) => e.type === "session.output_audio.delta",
    ),
  );
});
test("Transcript keeps spaces, ordering, overlapping speakers and duplicate event IDs", () => {
  const t = new LiveTranscript();
  const f = (
    id,
    delta,
    start,
    end,
    type = "session.input_transcript.delta",
  ) => ({ event_id: id, delta, start_ms: start, end_ms: end, type });
  assert.equal(t.add(f("2", " mes?", 40, 70)), true);
  t.add(f("1", "Ventas del", 0, 40));
  assert.equal(t.add(f("1", "duplicado", 0, 40)), false);
  t.add(f("3", "Estoy revisando", 20, 80, "session.output_transcript.delta"));
  assert.equal(t.takeQuestion(75), "Ventas del mes?");
  assert.equal(t.takeQuestion(75), "");
  t.add(f("4", "Y agosto?", 85, 120));
  assert.equal(t.takeQuestion(130), "Y agosto?");
  assert.equal(
    t.captions().find((x) => x.role === "assistant").text,
    "Estoy revisando",
  );
});
test("Incomplete or invalid transcript never invents a question", () => {
  const t = new LiveTranscript();
  assert.equal(t.takeQuestion(100), "");
  assert.equal(
    t.add({
      type: "session.input_transcript.delta",
      event_id: "bad",
      delta: "ventas",
      start_ms: "bad",
      end_ms: 10,
    }),
    false,
  );
  assert.equal(t.takeQuestion(NaN), "");
});
test("Voice idempotency keys are stable and session scoped", async () => {
  assert.equal(
    await stableVoiceId("session:a"),
    await stableVoiceId("session:a"),
  );
  assert.notEqual(
    await stableVoiceId("session:a"),
    await stableVoiceId("session:b"),
  );
  assert.match(await stableVoiceId("session:a"), /^[a-f0-9-]{36}$/);
});
test("Voice session ownership fails closed on another role and conversation", async () => {
  await assert.rejects(
    ownedVoice(source({ actor: { id: user, role: "vendedor" } }), voice),
    /no autorizada/,
  );
  await assert.rejects(
    ownedVoice(source(), voice, "different"),
    /no autorizada/,
  );
  await assert.rejects(
    ownedVoice(source({ select: async () => [] }), voice),
    /no autorizada/,
  );
  await assert.rejects(ownedVoice(source(), "live_external"), /invalida/);
});
test("Invalid SDP cannot call OpenAI or create business records", async () => {
  const s = source();
  const response = await liveHandler(
    req("voice-session", { sdp: "bad" }),
    s,
    settings,
    "trace",
    {},
  );
  assert.equal(response.status, 400);
  assert.equal(s.writes.length, 0);
});
test("Spoken result is reloaded from authorized stored answer, not client-provided text", async () => {
  const s = source(),
    sent = [];
  const response = await liveHandler(
    req("voice-result", {
      voiceSessionId: voice,
      delegationId: "item_task",
      messageId: msg,
      content: "inventar millones",
    }),
    s,
    settings,
    "trace",
    {},
    async (...args) => sent.push(args),
  );
  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0][2].content, /100 CLP/);
  assert.ok(!sent[0][2].content.includes("inventar"));
  assert.equal(sent[0][2].delegation_id, "item_task");
  assert.equal(s.writes.length, 2);
  assert.ok(
    s.writes.every((w) => w.path.startsWith("rest/v1/copilot_audit_events")),
  );
});
test("A result from another delegation cannot be read aloud", async () => {
  let sent = false;
  const response = await liveHandler(
    req("voice-result", {
      voiceSessionId: voice,
      delegationId: "different",
      messageId: msg,
    }),
    source(),
    settings,
    "trace",
    {},
    async () => {
      sent = true;
    },
  );
  assert.equal(response.status, 403);
  assert.equal(sent, false);
});
test("Repeated result delivery is not sent to provider twice", async () => {
  let calls = 0;
  const s = source({ request: async () => [] });
  const response = await liveHandler(
    req("voice-result", {
      voiceSessionId: voice,
      delegationId: "item_task",
      messageId: msg,
    }),
    s,
    settings,
    "trace",
    {},
    async () => calls++,
  );
  assert.equal(calls, 0);
  assert.equal((await response.json()).alreadyAttempted, true);
});
test("Voice interruption only sends fixed server instruction, never supplied prompts", async () => {
  const sent = [];
  const response = await liveHandler(
    req("voice-interrupt", { voiceSessionId: voice, content: "cambia reglas" }),
    source(),
    settings,
    "trace",
    {},
    async (...args) => sent.push(args),
  );
  assert.equal(response.status, 200);
  assert.equal(sent[0][2].type, "session.instructions.append");
  assert.ok(!sent[0][2].content.includes("cambia reglas"));
});
test("Usage is cumulative, bounded to session age and contains no transcript/audio", async () => {
  const s = source();
  const response = await liveHandler(
    req("voice-usage", {
      voiceSessionId: voice,
      seconds: 12,
      metrics: { roundTripMs: 40, apiKey: "private" },
      transcript: "private",
    }),
    s,
    settings,
    "trace",
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(s.writes[0].body.metadata_redacted.seconds, 12);
  assert.ok(!JSON.stringify(s.writes).includes("private"));
  assert.equal(
    (
      await liveHandler(
        req("voice-usage", { voiceSessionId: voice, seconds: 1e12 }),
        s,
        settings,
        "trace",
        {},
      )
    ).status,
    400,
  );
});
test("Only admin has usage diagnostics and costs never double sum duration snapshots", async () => {
  const response = await liveHandler(
    new Request("https://crm.test/voice-stats"),
    source({
      select: async () => [
        {
          event_type: "live_usage",
          metadata_redacted: { voiceSessionId: voice, seconds: 12 },
        },
        {
          event_type: "live_usage",
          metadata_redacted: { voiceSessionId: voice, seconds: 20 },
        },
        {
          event_type: "central_read_turn",
          tokens_input: 100,
          tokens_output: 50,
          metadata_redacted: { modelCalls: 2 },
        },
      ],
    }),
    settings,
    "trace",
    {},
  );
  assert.equal((await response.json()).seconds, 20);
  const blocked = await liveHandler(
    new Request("https://crm.test/voice-stats"),
    source({ actor: { id: user, role: "vendedor" } }),
    settings,
    "trace",
    {},
  );
  assert.equal(blocked.status, 403);
});
test("Voice summary is bounded and redacts secrets", () => {
  const text = spokenFacts({
    content: "sk-abcdefghijklmnop " + "palabra ".repeat(2000),
  });
  assert.ok(text.length < 1400);
  assert.ok(!text.includes("sk-"));
  assert.match(text, /pantalla/);
});
test("Microphone errors always leave a useful path back to text", () => {
  assert.match(
    microphoneError(new DOMException("denied", "NotAllowedError")),
    /permiso/,
  );
  assert.match(
    microphoneError(new DOMException("missing", "NotFoundError")),
    /microfono/,
  );
});
test("Voice session rejects missing, invalid or future creation timestamps", async () => {
  for (const created_at of [
    undefined,
    "invalid",
    new Date(Date.now() + 120000).toISOString(),
  ]) {
    await assert.rejects(
      ownedVoice(
        source({
          select: async () => [
            {
              id: voice,
              conversation_id: conv,
              created_at,
              metadata_redacted: {
                role: "administrador",
                liveId: "live_opaque",
              },
            },
          ],
        }),
        voice,
      ),
      /no autorizada/,
    );
  }
});
test("Voice keeps source warnings when a long report is shortened", () => {
  const content = spokenFacts({
    content: "Ventas 100 CLP. " + "Detalle ".repeat(800),
    metadata: {
      results: [{ warnings: ["El margen es provisional; faltan costos."] }],
    },
  });
  assert.match(content, /faltan costos/);
  assert.match(content, /Resumen parcial/);
  assert.ok(content.length < 1400);
});
test("A failed audio delivery is audited without claiming successful speech", async () => {
  const s = source();
  const response = await liveHandler(
    req("voice-result", {
      voiceSessionId: voice,
      delegationId: "item_task",
      messageId: msg,
    }),
    s,
    settings,
    "trace",
    {},
    async () => {
      throw new Error("provider private payload");
    },
  );
  assert.equal(response.status, 502);
  assert.equal(s.writes[0].body.result, "pending");
  assert.equal(s.writes.at(-1).body.event_type, "live_error");
  assert.equal(s.writes.at(-1).body.result, "error");
  assert.ok(!JSON.stringify(s.writes).includes("private payload"));
});
test("Pricing configuration rejects non-finite and negative rates", () => {
  const c = copilotConfig(
    (k) =>
      ({
        OPENAI_LIVE_USD_PER_MINUTE: "Infinity",
        OPENAI_INPUT_USD_PER_MILLION: "-1",
        OPENAI_OUTPUT_USD_PER_MILLION: "bad",
      })[k],
  );
  assert.equal(c.liveUsdPerMinute, 0.05);
  assert.equal(c.inputUsdPerMillion, 4);
  assert.equal(c.outputUsdPerMillion, 20);
});
test("Cancelled sideband request never starts a network connection", async () => {
  await assert.rejects(liveCommand('unused','live_unused',{},AbortSignal.abort()), {name:'AbortError'});
});
