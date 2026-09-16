import { useEffect, useRef, useState } from "react";
import {
  copilotVoiceRequest,
  streamCentralMessage,
  type CentralEvent,
} from "../../lib/copilotCentralApi";
import {
  LiveTranscript,
  microphoneError,
  type LiveFragment,
} from "./liveProtocol";

export type LiveState =
  | "disconnected"
  | "connecting"
  | "listening"
  | "thinking"
  | "searching"
  | "analyzing"
  | "speaking"
  | "error";
interface Session {
  voiceSessionId: string;
  conversationId: string;
  session: { id: string };
  transport: { sdp: string };
}
interface Callbacks {
  onEvent: (e: CentralEvent) => void;
  onQuestion: (text: string) => void;
  onBusy: (busy: boolean) => void;
  onError: (text: string) => void;
}

export function useCopilotLive(
  conversationId: string | undefined,
  callbacks: Callbacks,
) {
  const [active, setActive] = useState(false),
    [state, setState] = useState<LiveState>("disconnected"),
    [muted, setMuted] = useState(false),
    [captions, setCaptions] = useState<LiveFragment[]>([]),
    [error, setError] = useState(""),
    [audioBlocked, setAudioBlocked] = useState(false);
  const cb = useRef(callbacks);
  cb.current = callbacks;
  const currentConversation = useRef(conversationId);
  currentConversation.current = conversationId;
  const r = useRef<{
    pc?: RTCPeerConnection;
    dc?: RTCDataChannel;
    mic?: MediaStream;
    audio?: HTMLAudioElement;
    session?: Session;
    turn?: AbortController;
    startup?: AbortController;
    transcript: LiveTranscript;
    generation: number;
    turnVersion: number;
    running: boolean;
    ready: boolean;
    closing: boolean;
    muted: boolean;
    reconnects: number;
    usage: number;
    started: number;
    delegatedAt?: number;
    metrics: Record<string, number>;
    phase: LiveState;
    timers: Set<ReturnType<typeof setTimeout>>;
    delegations: Set<string>;
    audioContext?: AudioContext;
  }>({
    transcript: new LiveTranscript(),
    generation: 0,
    turnVersion: 0,
    running: false,
    ready: false,
    closing: false,
    muted: false,
    reconnects: 0,
    usage: 0,
    started: 0,
    metrics: {},
    phase: "listening",
    timers: new Set(),
    delegations: new Set(),
  });
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      r.current.timers.delete(timer);
      fn();
    }, ms);
    r.current.timers.add(timer);
    return timer;
  };
  function cleanupTransport() {
    const c = r.current;
    c.startup?.abort();
    c.turn?.abort();
    c.turnVersion++;
    c.ready = false;
    c.phase = "listening";
    for (const timer of c.timers) clearTimeout(timer);
    c.timers.clear();
    c.dc?.close();
    c.pc?.close();
    c.mic?.getTracks().forEach((t) => t.stop());
    if (c.audio) {
      c.audio.pause();
      c.audio.srcObject = null;
    }
    void c.audioContext?.close().catch(() => {});
    c.audioContext = undefined;
    c.pc = undefined;
    c.dc = undefined;
    c.mic = undefined;
    cb.current.onBusy(false);
  }
  async function reportUsage(finalized = false) {
    const c = r.current;
    if (!c.session) return;
    await copilotVoiceRequest("voice-usage", {
      voiceSessionId: c.session.voiceSessionId,
      seconds: c.usage,
      finalized,
      metrics: c.metrics,
    }).catch(() => {});
  }
  async function hangup(session?: Session) {
    if (session)
      await copilotVoiceRequest("voice-end", {
        voiceSessionId: session.voiceSessionId,
      }).catch(() => {});
  }
  function command(type: string) {
    const c = r.current;
    if (c.ready && c.dc?.readyState === "open")
      c.dc.send(JSON.stringify({ type, event_id: crypto.randomUUID() }));
  }
  async function stop() {
    const c = r.current;
    if (c.closing) return;
    c.running = false;
    c.closing = true;
    c.turn?.abort();
    c.startup?.abort();
    c.turnVersion++;
    c.mic?.getTracks().forEach((t) => t.stop());
    if (c.audio) c.audio.muted = true;
    cb.current.onBusy(false);
    setActive(false);
    setState("disconnected");
    // Keep the channel long enough to observe final usage, but release microphone immediately.
    if (c.ready && c.dc?.readyState === "open") {
      command("session.close");
      later(() => {
        const ended = c.session;
        void reportUsage(false).finally(() => hangup(ended));
        c.generation++;
        cleanupTransport();
        c.session = undefined;
        c.closing = false;
      }, 3500);
    } else {
      const session = c.session;
      c.generation++;
      cleanupTransport();
      c.session = undefined;
      c.closing = false;
      await hangup(session);
    }
  }
  async function delegate(event: Record<string, unknown>, generation: number) {
    const c = r.current,
      delegation = event.delegation as
        | { id?: string; target?: string }
        | undefined;
    if (
      !c.running ||
      delegation?.target !== "client" ||
      !delegation.id ||
      c.delegations.has(delegation.id)
    )
      return;
    c.delegations.add(delegation.id);
    c.turn?.abort();
    const version = ++c.turnVersion;
    const controller = new AbortController();
    c.turn = controller;
    const valid = () =>
      c.running &&
      c.generation === generation &&
      c.turnVersion === version &&
      !controller.signal.aborted;
    c.phase = "thinking";
    c.delegatedAt = performance.now();
    delete c.metrics.firstAudioMs;
    setState(c.phase);
    // Allow out-of-order caption fragments to arrive; silence never initiates a query.
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    if (!valid()) return;
    let question = c.transcript.takeQuestion(Number(event.offset_ms));
    if (!question) {
      c.phase = "listening";
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      if (!valid()) return;
      question = c.transcript.takeQuestion(Number(event.offset_ms));
    }
    if (!question) {
      setError(
        "No llego la transcripcion completa. Repite la pregunta o continua por texto.",
      );
      setState("listening");
      return;
    }
    const session = c.session!;
    const started = performance.now();
    cb.current.onQuestion(question);
    cb.current.onBusy(true);
    setError("");
    try {
      let result: CentralEvent | undefined;
      await streamCentralMessage(
        question,
        session.conversationId,
        controller.signal,
        (e) => {
          if (!valid()) return;
          cb.current.onEvent(e);
          if (e.type === "tool_start") c.phase = "searching";
          if (e.type === "composing" || e.type === "tool_end")
            c.phase = "analyzing";
          setState(c.phase);
          if (e.type === "complete") result = e;
        },
        { voiceSessionId: session.voiceSessionId, delegationId: delegation.id },
      );
      if (!valid() || !result?.messageId) return;
      c.metrics.delegationMs = performance.now() - started;
      await copilotVoiceRequest(
        "voice-result",
        {
          voiceSessionId: session.voiceSessionId,
          delegationId: delegation.id,
          messageId: result.messageId,
        },
        controller.signal,
      );
      if (valid()) {
        c.phase = "listening";
        setState(c.phase);
      }
    } catch (e) {
      if (valid()) {
        const msg = microphoneError(e);
        c.phase = "error";
        setError(msg);
        cb.current.onError(msg);
        setState("error");
      }
    } finally {
      if (valid()) cb.current.onBusy(false);
    }
  }
  function reconnect(generation: number) {
    const c = r.current;
    if (!c.running || c.generation !== generation) return;
    if (c.reconnects >= 2) {
      setError("Se perdio la conexion. Reconecta la voz o continua por texto.");
      setState("error");
      c.running = false;
      setActive(false);
      const old = c.session;
      cleanupTransport();
      c.session = undefined;
      void hangup(old);
      return;
    }
    c.reconnects++;
    const old = c.session;
    // Telemetry must never block reconnection on an unavailable network.
    const reconnectGeneration = ++c.generation;
    void reportUsage(false);
    cleanupTransport();
    c.session = undefined;
    void hangup(old);
    if (c.running && c.generation === reconnectGeneration) void start(true);
  }
  async function start(reconnecting = false) {
    const c = r.current;
    if (c.running && !reconnecting) return;
    const previous = c.session;
    c.generation++;
    c.session = undefined;
    if (previous) void hangup(previous);
    cleanupTransport();
    c.running = true;
    c.closing = false;
    c.ready = false;
    c.transcript = new LiveTranscript();
    c.delegations.clear();
    c.usage = 0;
    c.delegatedAt = undefined;
    c.started = performance.now();
    c.metrics = {};
    if (!reconnecting) c.reconnects = 0;
    const generation = ++c.generation;
    const valid = () => c.running && c.generation === generation;
    const startup = new AbortController();
    c.startup = startup;
    setActive(true);
    setState("connecting");
    setCaptions([]);
    setError("");
    setAudioBlocked(false);
    setMuted(c.muted);
    try {
      if (
        !window.isSecureContext ||
        !navigator.mediaDevices?.getUserMedia ||
        !window.RTCPeerConnection
      )
        throw new Error(
          "Este navegador no permite voz segura. Usa Chrome o Edge en HTTPS, o continua por texto.",
        );
      const audio = new Audio();
      audio.autoplay = true;
      c.audio = audio;
      const context = new AudioContext();
      c.audioContext = context;
      void context.resume().catch(() => {
        if (valid()) setAudioBlocked(true);
      });
      const pc = new RTCPeerConnection();
      c.pc = pc;
      pc.ontrack = (e) => {
        if (!valid()) return;
        audio.srcObject = new MediaStream([e.track]);
        void audio.play().catch(() => {
          if (valid()) setAudioBlocked(true);
        });
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        context
          .createMediaStreamSource(audio.srcObject as MediaStream)
          .connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        let lastSound = 0;
        const meter = () => {
          if (!valid()) return;
          analyser.getByteTimeDomainData(samples);
          const rms =
            Math.sqrt(
              samples.reduce((s, v) => s + (v - 128) ** 2, 0) / samples.length,
            ) / 128;
          if (rms > 0.015) {
            lastSound = performance.now();
            if (
              c.metrics.firstAudioMs === undefined &&
              c.delegatedAt !== undefined
            )
              c.metrics.firstAudioMs = performance.now() - c.delegatedAt;
            setState("speaking");
          } else if (performance.now() - lastSound > 500)
            setState((s) => (s === "speaking" ? c.phase : s));
          later(meter, 100);
        };
        meter();
      };
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (!valid()) {
        mic.getTracks().forEach((t) => t.stop());
        return;
      }
      c.mic = mic;
      for (const track of mic.getAudioTracks()) {
        track.enabled = !c.muted;
        pc.addTrack(track, mic);
        track.onended = () => {
          if (valid()) {
            setError(
              "El microfono se desconecto. Revisa el dispositivo o Bluetooth y reconecta la voz.",
            );
            void stop();
          }
        };
      }
      const dc = pc.createDataChannel("oai-events");
      c.dc = dc;
      dc.onmessage = ({ data }) => {
        if (c.generation !== generation) return;
        let e: Record<string, unknown>;
        try {
          e = JSON.parse(data);
        } catch {
          return;
        }
        if (e.type === "session.started") {
          c.ready = true;
          c.metrics.connectMs = performance.now() - c.started;
          setState("listening");
          if (c.muted) command("session.input_audio.mute");
        }
        if (e.type === "session.closed") {
          const usage = e.usage as { seconds?: number };
          c.usage = Math.max(c.usage, Number(usage?.seconds) || 0);
          const ended = c.session;
          void reportUsage(true).finally(() => hangup(ended));
          c.running = false;
          c.generation++;
          cleanupTransport();
          c.session = undefined;
          c.closing = false;
          setActive(false);
          setState("disconnected");
        }
        if (e.type === "session.usage.updated") {
          c.usage = Math.max(
            c.usage,
            Number((e.usage as { seconds?: number })?.seconds) || 0,
          );
        }
        if (c.transcript.add(e)) setCaptions(c.transcript.captions());
        if (e.type === "session.delegation.created")
          void delegate(e, generation);
        if (e.type === "error") {
          setError(
            "La voz no pudo completar una operacion. Puedes continuar por texto.",
          );
          setState("error");
        }
      };
      dc.onclose = () => {
        if (valid() && !c.closing) void reconnect(generation);
      };
      pc.onconnectionstatechange = () => {
        if (!valid() || c.closing) return;
        if (pc.connectionState === "failed") void reconnect(generation);
        if (pc.connectionState === "disconnected")
          later(() => {
            if (pc.connectionState === "disconnected")
              void reconnect(generation);
          }, 5000);
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (pc.iceGatheringState !== "complete")
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            pc.removeEventListener("icegatheringstatechange", check);
            reject(
              new Error("No se pudo negociar el audio. Revisa la conexion."),
            );
          }, 10000);
          const check = () => {
            if (pc.iceGatheringState === "complete") {
              clearTimeout(timeout);
              pc.removeEventListener("icegatheringstatechange", check);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", check);
          check();
        });
      if (!valid()) return;
      const session = await copilotVoiceRequest<Session>(
        "voice-session",
        {
          sdp: pc.localDescription?.sdp,
          conversationId: currentConversation.current,
        },
        startup.signal,
      );
      if (!valid()) {
        void hangup(session);
        return;
      }
      c.session = session;
      currentConversation.current = session.conversationId;
      cb.current.onEvent({
        type: "conversation",
        conversationId: session.conversationId,
      });
      await pc.setRemoteDescription({
        type: "answer",
        sdp: session.transport.sdp,
      });
      later(() => {
        if (valid() && !c.ready) {
          setError(
            "La sesion no pudo iniciar el audio. Revisa la red y vuelve a conectar.",
          );
          void stop();
        }
      }, 15000);
      const observe = async () => {
        if (!valid()) return;
        const stats = await pc.getStats().catch(() => undefined);
        stats?.forEach((s) => {
          if (
            s.type === "candidate-pair" &&
            s.state === "succeeded" &&
            typeof s.currentRoundTripTime === "number"
          )
            c.metrics.roundTripMs = s.currentRoundTripTime * 1000;
          if (s.type === "inbound-rtp" && s.kind === "audio") {
            if (typeof s.jitter === "number")
              c.metrics.jitterMs = s.jitter * 1000;
            if (typeof s.packetsLost === "number")
              c.metrics.packetsLost = s.packetsLost;
          }
        });
        await reportUsage();
        if (valid()) later(() => void observe(), 30000);
      };
      later(() => void observe(), 30000);
    } catch (e) {
      if (valid()) {
        setError(microphoneError(e));
        setState("error");
        setActive(false);
        c.running = false;
        const old = c.session;
        cleanupTransport();
        c.session = undefined;
        void hangup(old);
      }
    }
  }
  function toggleMute() {
    const c = r.current;
    c.muted = !c.muted;
    c.mic?.getAudioTracks().forEach((t) => (t.enabled = !c.muted));
    setMuted(c.muted);
    command(
      c.muted ? "session.input_audio.mute" : "session.input_audio.unmute",
    );
  }
  async function interrupt() {
    const c = r.current;
    const audio = c.audio,
      generation = c.generation;
    if (audio) audio.muted = true;
    c.turn?.abort();
    c.turnVersion++;
    cb.current.onBusy(false);
    c.phase = "listening";
    setState("listening");
    if (c.session)
      await copilotVoiceRequest("voice-interrupt", {
        voiceSessionId: c.session.voiceSessionId,
      }).catch((e) => setError(microphoneError(e)));
    if (
      audio &&
      c.audio === audio &&
      c.generation === generation &&
      c.running &&
      !c.closing
    )
      audio.muted = false;
  }
  useEffect(() => {
    const c = r.current;
    const offline = () => {
      if (c.running) {
        c.turn?.abort();
        setState("disconnected");
        setError(
          "Sin conexion. Puedes seguir por texto cuando vuelva internet.",
        );
      }
    };
    const online = () => {
      if (r.current.running) void reconnect(r.current.generation);
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      c.running = false;
      c.generation++;
      const session = c.session;
      void reportUsage(false);
      cleanupTransport();
      void hangup(session);
    };
    // Transport lifetime is mount-scoped; callbacks read the current refs, not render props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return {
    active,
    state,
    muted,
    captions,
    error,
    audioBlocked,
    start: () => start(),
    stop,
    toggleMute,
    interrupt,
    resumeAudio: () => {
      void r.current.audioContext?.resume();
      void r.current.audio
        ?.play()
        .then(() => setAudioBlocked(false))
        .catch(() => setAudioBlocked(true));
    },
  };
}
