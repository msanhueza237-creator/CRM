import { useEffect, useRef, useState } from "react";

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type VoiceWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

// The adapter only handles audio. Transcribed questions use the same authorized text endpoint.
export function useCopilotVoice(
  onText: (text: string) => void,
  onError: (error: string) => void,
) {
  const [listening, setListening] = useState(false),
    [speaking, setSpeaking] = useState(false);
  const recognition = useRef<Recognition>(),
    callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };
  const ctor =
    (window as VoiceWindow).SpeechRecognition ||
    (window as VoiceWindow).webkitSpeechRecognition;
  const stop = () => {
    recognition.current?.abort();
    window.speechSynthesis?.cancel();
    setListening(false);
    setSpeaking(false);
  };
  useEffect(
    () => () => {
      if (recognition.current) {
        recognition.current.onresult = null;
        recognition.current.onerror = null;
        recognition.current.onend = null;
        recognition.current.abort();
      }
      window.speechSynthesis?.cancel();
    },
    [],
  );
  const listen = () => {
    stop();
    if (!ctor) {
      callbacks.current.onError(
        "Este navegador no dispone de dictado. Puedes escribir la consulta.",
      );
      return;
    }
    const r = new ctor();
    recognition.current = r;
    r.lang = "es-CL";
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (event) =>
      callbacks.current.onText(
        Array.from(event.results)
          .map((v) => v[0]?.transcript || "")
          .join(" ")
          .slice(0, 6000),
      );
    r.onerror = (event) => {
      setListening(false);
      if (event.error !== "aborted")
        callbacks.current.onError(
          event.error === "not-allowed"
            ? "El microfono no tiene permiso. Revisalo en la configuracion de este sitio."
            : "No se pudo completar el dictado. Intenta de nuevo o escribe la consulta.",
        );
    };
    r.onend = () => setListening(false);
    try {
      r.start();
      setListening(true);
    } catch {
      callbacks.current.onError("No se pudo iniciar el microfono.");
    }
  };
  const speak = (text: string) => {
    stop();
    if (!window.speechSynthesis) {
      callbacks.current.onError("Este navegador no dispone de lectura de voz.");
      return;
    }
    const clean = text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[#*`|]/g, " ");
    const chunks = clean.match(/[^.!?\n]+[.!?\n]?/g) || [clean];
    setSpeaking(true);
    const queue = chunks
      .flatMap((s) => s.match(/.{1,240}(?:\s|$)|.{1,240}/g) || [])
      .slice(0, 100);
    queue.forEach((chunk, i) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = "es-CL";
      utterance.onend = () => {
        if (i === queue.length - 1) setSpeaking(false);
      };
      utterance.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utterance);
    });
    if (!queue.length) setSpeaking(false);
  };
  return {
    listening,
    speaking,
    canListen: !!ctor,
    canSpeak: !!window.speechSynthesis,
    listen,
    speak,
    stop,
  };
}
