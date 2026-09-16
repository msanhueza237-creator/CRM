export interface LiveFragment {
  id: string;
  role: "user" | "assistant";
  text: string;
  start: number;
  end: number;
}

// Fragments are not turns. Only a provider delegation starts a CRM request.
export class LiveTranscript {
  fragments: LiveFragment[] = [];
  private seen = new Set<string>();
  private consumed = -1;
  add(event: Record<string, unknown>) {
    if (
      ![
        "session.input_transcript.delta",
        "session.output_transcript.delta",
      ].includes(String(event.type)) ||
      typeof event.delta !== "string"
    )
      return false;
    const id = String(event.event_id || "");
    const start = Number(event.start_ms),
      end = Number(event.end_ms);
    if (
      !id ||
      this.seen.has(id) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start
    )
      return false;
    this.seen.add(id);
    this.fragments.push({
      id,
      role:
        event.type === "session.input_transcript.delta" ? "user" : "assistant",
      text: event.delta,
      start,
      end,
    });
    this.fragments.sort((a, b) => a.start - b.start);
    // Retain captions locally only for this session, with bounded memory.
    if (this.fragments.length > 3000)
      this.fragments.splice(0, this.fragments.length - 3000);
    if (this.seen.size > 6000)
      this.seen = new Set(this.fragments.map((f) => f.id));
    return true;
  }
  takeQuestion(offset: number) {
    if (!Number.isFinite(offset) || offset <= this.consumed) return "";
    const fragments = this.fragments.filter(
      (f) => f.role === "user" && f.end > this.consumed && f.start <= offset,
    );
    if (!fragments.length) return "";
    this.consumed = Math.max(offset, ...fragments.map((f) => f.end));
    return fragments
      .map((f) => f.text)
      .join("")
      .trim()
      .slice(0, 6000);
  }
  captions() {
    const groups: LiveFragment[] = [];
    for (const f of this.fragments) {
      const prior = [...groups].reverse().find((g) => g.role === f.role);
      if (prior && f.start - prior.end < 1800) {
        prior.text += f.text;
        prior.end = Math.max(prior.end, f.end);
      } else groups.push({ ...f });
    }
    return groups.slice(-12);
  }
}

export function microphoneError(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "El microfono no tiene permiso. Autoriza el microfono de este sitio o continua por texto.";
  if (name === "NotFoundError")
    return "No se encontro un microfono. Conecta uno o continua por texto.";
  if (name === "NotReadableError")
    return "El microfono esta ocupado por otra aplicacion. Cierra esa llamada e intenta nuevamente.";
  if (name === "TimeoutError") return "La conexion de voz tardo demasiado. Vuelve a conectar o continua por texto.";
  if (name === "TypeError") return "No se pudo establecer la conexion de voz. Revisa internet o continua por texto.";
  return error instanceof Error
    ? error.message
    : "La conexion de voz fallo. Puedes continuar por texto.";
}
