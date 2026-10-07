import { useEffect, useRef, useState } from "react";
import { FileText, Paperclip, X } from "lucide-react";
import { MESSAGE_FILE_ACCEPT, MESSAGE_FILE_LIMIT, validateMessageFile } from "../../../supabase/functions/_shared/direct-message";

function AttachmentPreview({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  useEffect(() => { if (!file.type.startsWith("image/")) return; const next = URL.createObjectURL(file); setUrl(next); return () => URL.revokeObjectURL(next); }, [file]);
  return url ? <img src={url} alt={file.name} /> : <FileText size={24} aria-hidden="true" />;
}
export function MessageAttachments({ files, onChange, disabled, maximum = 5 }: { files: File[]; onChange: (files: File[]) => void; disabled: boolean; maximum?: number }) {
  const input = useRef<HTMLInputElement>(null); const [error, setError] = useState("");
  return <div className="message-attachments">
    <input ref={input} type="file" hidden accept={MESSAGE_FILE_ACCEPT} multiple={maximum > 1} disabled={disabled} aria-label="Archivos adjuntos"
      onChange={event => { try {
        const next = [...files, ...Array.from(event.target.files || [])];
        if (next.length > maximum) throw new Error(`Maximo ${maximum} adjunto${maximum > 1 ? "s" : ""} por mensaje.`);
        for (const file of next) validateMessageFile(file);
        if (next.reduce((sum, file) => sum + file.size, 0) > MESSAGE_FILE_LIMIT) throw new Error("Maximo 10 MB en total.");
        onChange(next); setError("");
      } catch (err) { setError((err as Error).message); } event.target.value = ""; }} />
    <div className="message-file-tools"><button type="button" className="ghost-button" title="Adjuntar documento o imagen" aria-label="Adjuntar documento o imagen" disabled={disabled || files.length >= maximum} onClick={() => input.current?.click()}><Paperclip size={18} /></button>
      <small>PDF, Word, Excel, JPG o PNG · 10 MB en total · imagen: 5 MB</small></div>
    {error && <p className="wa-alert" role="alert">{error}</p>}
    {files.length > 0 && <ul className="message-files">{files.map((file, index) => <li key={`${index}:${file.name}`}><AttachmentPreview file={file} /><span>{file.name}<small>{(file.size / 1024).toLocaleString("es-CL", { maximumFractionDigits: 0 })} KB</small></span><button type="button" className="ghost-button" aria-label={`Quitar ${file.name}`} title={`Quitar ${file.name}`} disabled={disabled} onClick={() => onChange(files.filter((_, i) => i !== index))}><X size={16} /></button></li>)}</ul>}
  </div>;
}
