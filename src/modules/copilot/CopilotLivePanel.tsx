import {
  Mic,
  MicOff,
  PhoneOff,
  MessageSquare,
  Volume2,
  Square,
  RefreshCw,
  AudioLines,
} from "lucide-react";
import { useCopilotLive } from "./useCopilotLive";
import { useEffect, useRef } from "react";
const states = {
  disconnected: "Desconectado",
  connecting: "Conectando",
  listening: "Escuchando",
  thinking: "Pensando",
  searching: "Consultando CRM",
  analyzing: "Analizando",
  speaking: "Hablando",
  error: "Voz no disponible",
};
export function CopilotLivePanel({
  live,
  onText,
}: {
  live: ReturnType<typeof useCopilotLive>;
  onText: () => void;
}) {
  const captions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (captions.current)
      captions.current.scrollTop = captions.current.scrollHeight;
  }, [live.captions]);
  return (
    <section className="cc-live" aria-label="Conversacion de voz">
      <div className="cc-live-top">
        <div className={`cc-live-level is-${live.state}`} aria-hidden="true">
          <AudioLines size={28} />
        </div>
        <div>
          <strong role="status">
            {live.muted ? "Microfono silenciado" : states[live.state]}
          </strong>
          <small>
            {live.active ? "Sesion de voz activa" : "Microfono apagado"}
          </small>
        </div>
        <button
          className="cc-icon"
          title="Volver a texto"
          aria-label="Volver a texto"
          onClick={onText}
        >
          <MessageSquare size={21} />
        </button>
      </div>
      {live.error && (
        <p className="cc-live-error" role="alert">
          {live.error}
        </p>
      )}
      <div
        className="cc-live-captions"
        ref={captions}
        aria-label="Transcripcion de voz"
        role="log"
        aria-live="off"
      >
        {live.captions.slice(-4).map((c) => (
          <p key={c.id}>
            <strong>{c.role === "user" ? "Tu" : "Copiloto"}</strong>
            {c.text}
          </p>
        ))}
      </div>
      <div className="cc-live-actions">
        {live.active ? (
          <>
            <button
              className="cc-icon"
              aria-label={
                live.muted ? "Activar microfono" : "Silenciar microfono"
              }
              title={live.muted ? "Activar microfono" : "Silenciar microfono"}
              aria-pressed={live.muted}
              onClick={live.toggleMute}
            >
              {live.muted ? <MicOff /> : <Mic />}
            </button>
            <button
              className="cc-icon"
              aria-label="Interrumpir respuesta"
              title="Interrumpir respuesta"
              onClick={() => void live.interrupt()}
            >
              <Square size={21} />
            </button>
            <button
              className="cc-icon cc-live-end"
              aria-label="Finalizar voz"
              title="Finalizar voz"
              onClick={() => void live.stop()}
            >
              <PhoneOff />
            </button>
          </>
        ) : (
          <button
            className="cc-icon"
            title="Conectar voz"
            aria-label="Conectar voz"
            onClick={() => void live.start()}
          >
            <RefreshCw />
          </button>
        )}
        {live.audioBlocked && (
          <button
            className="cc-icon"
            title="Activar audio"
            aria-label="Activar audio"
            onClick={live.resumeAudio}
          >
            <Volume2 />
          </button>
        )}
      </div>
    </section>
  );
}
