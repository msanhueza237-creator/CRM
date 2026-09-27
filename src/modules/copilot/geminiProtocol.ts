type Row = Record<string, unknown>;
const object = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const list = (v: unknown): Row[] => Array.isArray(v) ? v.map(object) : [];

export interface GeminiSession {
  voiceSessionId: string;
  conversationId: string;
  protocol: "gemini";
  credential: string;
  model: string;
  maxSeconds: number;
  history: Array<{ role: string; parts: Array<{ text: string }> }>;
}
export function geminiSocketUrl(credential: string) {
  if (!/^auth_tokens\/[A-Za-z0-9._~-]+$/.test(credential)) throw new Error("Sesion temporal de Gemini invalida.");
  return "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=" + encodeURIComponent(credential);
}
export function pcm16(samples: Float32Array): string {
  const buffer = new Uint8Array(samples.length * 2), view = new DataView(buffer.buffer);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function decodePcm16(data: string): Float32Array {
  if (data.length > 1048576) throw new Error("Bloque de audio demasiado grande.");
  const binary = atob(data);
  if (binary.length % 2) throw new Error("Audio PCM incompleto.");
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer), samples = new Float32Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

// Maps provider call IDs to the existing CRM delegation contract. No business tools live here.
export class GeminiProtocol {
  calls = new Map<string, { id: string; original: string }>();
  seen = new Set<string>();
  constructor(private emit: (event: Row) => void, private audio: (data: string) => void, private clear: () => void, private send: (event: Row) => void) {}
  receive(message: unknown, offset: number) {
    const m = object(message), content = object(m.serverContent);
    if (m.setupComplete) this.emit({ type: "session.started" });
    if (content.interrupted) {
      this.clear();
      this.emit({ type: "voice.interrupted" });
    }
    for (const [field, type] of [["inputTranscription", "session.input_transcript.delta"], ["outputTranscription", "session.output_transcript.delta"]]) {
      const text = object(content[field]).text;
      if (typeof text === "string" && text) this.emit({ type, event_id: crypto.randomUUID(), delta: text, start_ms: offset, end_ms: offset + 1 });
    }
    for (const part of list(object(content.modelTurn).parts)) {
      const inline = object(part.inlineData);
      if (typeof inline.data === "string" && /^audio\/pcm(?:;|$)/.test(String(inline.mimeType))) this.audio(inline.data);
    }
    if (content.turnComplete) this.emit({ type: "voice.turn_complete" });
    for (const original of Array.isArray(object(m.toolCallCancellation).ids) ? object(m.toolCallCancellation).ids as string[] : []) {
      const call = this.calls.get(original);
      if (call) { this.calls.delete(original); this.emit({ type: "voice.cancelled", delegationId: call.id }); }
    }
    for (const call of list(object(m.toolCall).functionCalls)) {
      if (typeof call.id !== "string" || !call.id || call.id.length > 512 || this.seen.has(call.id)) continue;
      if (this.seen.size >= 500) { this.emit({ type: "voice.reconnect" }); break; }
      this.seen.add(call.id);
      const question = object(call.args).question;
      if (call.name !== "ask_manager" || typeof question !== "string" || !question.trim() || question.length > 6000 || this.calls.size) {
        this.send({ toolResponse: { functionResponses: [{ id: call.id, name: String(call.name || "ask_manager"), response: { error: "Solicitud no disponible. Haz una sola consulta al Gerente por turno." } }] } });
        continue;
      }
      const id = crypto.randomUUID();
      this.calls.set(call.id, { id, original: call.id });
      this.emit({ type: "session.delegation.created", delegation: { id, target: "client", question: question.trim() }, offset_ms: offset + 1 });
    }
    if (m.usageMetadata) this.emit({ type: "voice.usage", tokens: m.usageMetadata });
    if (m.goAway) this.emit({ type: "voice.reconnect" });
    if (m.error) this.emit({ type: "error" });
  }
  result(id: string, text: string, failed = false) {
    const call = [...this.calls.values()].find(c => c.id === id);
    if (!call) return false;
    this.calls.delete(call.original);
    this.send({ toolResponse: { functionResponses: [{ id: call.original, name: "ask_manager", response: failed ? { error: text } : { result: text } }] } });
    return true;
  }
  cancel() {
    const calls = [...this.calls.values()];
    for (const call of calls) this.result(call.id, "Consulta interrumpida. Espera la nueva pregunta; no inventes resultados.", true);
  }
}
