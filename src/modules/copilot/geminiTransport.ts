import captureUrl from "./geminiCapture.worklet.js?url";
import { GeminiProtocol, decodePcm16, pcm16, geminiSocketUrl, type GeminiSession } from "./geminiProtocol";
type Row = Record<string, unknown>;

export class GeminiTransport {
  private ws?: WebSocket;
  private capture?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private silence?: GainNode;
  private playing = new Set<AudioBufferSourceNode>();
  private nextAudio = 0;
  private closed = false;
  private ready = false;
  private muted = false;
  private suppressAudio = false;
  private started = performance.now();
  private protocol: GeminiProtocol;
  private rejectStart?: (error: Error) => void;
  private startTimeout?: ReturnType<typeof setTimeout>;
  constructor(private context: AudioContext, private emit: (event: Row) => void) {
    this.protocol = new GeminiProtocol(
      e => { if (e.type === "session.input_transcript.delta") this.suppressAudio = false; this.emit(e); },
      data => this.play(data), () => this.clearAudio(), e => this.send(e),
    );
  }
  private send(event: Row) {
    if (!this.closed && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }
  async start(session: GeminiSession, mic: MediaStream, signal: AbortSignal) {
    const abort = () => this.close();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) this.close();
    try {
      await this.context.audioWorklet.addModule(captureUrl);
      if (this.closed) throw new DOMException("Cancelado", "AbortError");
      this.capture = new AudioWorkletNode(this.context, "gemini-capture");
      this.source = this.context.createMediaStreamSource(mic);
      this.silence = this.context.createGain();
      this.silence.gain.value = 0;
      this.source.connect(this.capture).connect(this.silence).connect(this.context.destination);
      this.capture.port.onmessage = event => {
        if (!this.ready || this.closed || this.muted) return;
        if ((this.ws?.bufferedAmount || 0) > 256000) {
          this.emit({ type: "voice.reconnect" });
          return;
        }
        this.send({ realtimeInput: { audio: { data: pcm16(event.data), mimeType: `audio/pcm;rate=${this.context.sampleRate}` } } });
      };
      await new Promise<void>((resolve, reject) => {
        this.rejectStart = reject;
        this.startTimeout = setTimeout(() => {
          reject(new Error("Gemini no inicio el audio. Revisa la conexion o elige OpenAI Live."));
          this.close();
        }, 20000);
        const ws = new WebSocket(geminiSocketUrl(session.credential));
        this.ws = ws;
        ws.onopen = () => this.send({ setup: { model: `models/${session.model}` } });
        let messages = Promise.resolve();
        ws.onmessage = event => {
          messages = messages.then(async () => {
            if (this.closed) return;
            const raw = typeof event.data === "string" ? event.data : await (event.data as Blob).text();
            if (this.closed) return;
            const message = JSON.parse(raw);
            if (message.setupComplete) {
              clearTimeout(this.startTimeout);
              if (session.history.length) this.send({ clientContent: { turns: session.history, turnComplete: false } });
              this.ready = true;
              this.rejectStart = undefined;
              resolve();
            }
            this.protocol.receive(message, performance.now() - this.started);
          }).catch(() => { this.emit({ type: "error" }); this.close(); });
        };
        ws.onerror = () => {
          clearTimeout(this.startTimeout);
          if (!this.ready) reject(new Error("No se pudo conectar con Gemini Live. Puedes elegir OpenAI Live."));
        };
        ws.onclose = event => {
          clearTimeout(this.startTimeout);
          if (this.closed) return;
          if (!this.ready) reject(new Error(event.code === 1008 ? "Google rechazo la sesion. Revisa permisos, cuota y modelo de Gemini Live." : "Gemini cerro la conexion antes de iniciar audio."));
          else this.emit({ type: "voice.reconnect" });
        };
      });
    } finally { signal.removeEventListener("abort", abort); }
  }
  private play(data: string) {
    if (this.closed || this.suppressAudio) return;
    const samples = decodePcm16(data);
    if (!samples.length) return;
    const buffer = this.context.createBuffer(1, samples.length, 24000);
    buffer.getChannelData(0).set(samples);
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.context.destination);
    this.playing.add(node);
    node.onended = () => {
      node.disconnect(); this.playing.delete(node);
      if (!this.playing.size && !this.closed) this.emit({ type: "voice.audio_idle" });
    };
    const when = Math.max(this.context.currentTime + 0.02, this.nextAudio);
    this.nextAudio = when + buffer.duration;
    node.start(when);
    this.emit({ type: "voice.speaking" });
    if (this.context.state === "suspended") this.emit({ type: "voice.audio_blocked" });
  }
  clearAudio() {
    for (const node of this.playing) { node.onended = null; try { node.stop(); } catch { /* Already ended. */ } node.disconnect(); }
    this.playing.clear(); this.nextAudio = 0;
  }
  mute(muted: boolean) {
    this.muted = muted;
    if (muted && this.ready) this.send({ realtimeInput: { audioStreamEnd: true } });
  }
  result(id: string, text: string, failed = false) { return this.protocol.result(id, text, failed); }
  cancelPending() { this.protocol.cancel(); }
  interrupt() {
    this.clearAudio(); this.suppressAudio = true; this.protocol.cancel();
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text: "Detente. Espera mi siguiente pregunta." }] }], turnComplete: false } });
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.ready = false;
    clearTimeout(this.startTimeout);
    this.rejectStart?.(new DOMException("Cancelado", "AbortError"));
    this.rejectStart = undefined;
    this.clearAudio();
    this.capture?.disconnect(); this.source?.disconnect(); this.silence?.disconnect();
    if (this.capture) { this.capture.port.onmessage = null; this.capture.port.close(); }
    this.ws?.close();
  }
}
