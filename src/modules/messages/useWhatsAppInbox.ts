import { useCallback, useEffect, useRef, useState } from "react";
import { getWhatsAppInbox, inboxChanged, type InboxFilter, type WhatsAppInbox } from "../../lib/whatsappInboxApi";

export function useWhatsAppInbox(enabled = true, search = "", filter: InboxFilter = "all", offset = 0, limit = 30) {
  const [data, setData] = useState<WhatsAppInbox | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(enabled);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!enabled) { setData(null); setLoading(false); return; }
    let active = true;
    const load = async () => {
      const serial = ++generation.current; setLoading(true);
      try {
        const result = await getWhatsAppInbox(search, filter, offset, limit);
        if (active && serial === generation.current) { setData(result); setError(""); }
      } catch (err) { if (active && serial === generation.current) setError(err instanceof Error ? err.message : "No se pudo cargar la bandeja."); }
      finally { if (active && serial === generation.current) setLoading(false); }
    };
    void load();
    const visibleLoad = () => { if (!document.hidden) void load(); };
    const timer = window.setInterval(visibleLoad, 30000);
    window.addEventListener(inboxChanged, visibleLoad);
    window.addEventListener("focus", visibleLoad);
    document.addEventListener("visibilitychange", visibleLoad);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener(inboxChanged, visibleLoad); window.removeEventListener("focus", visibleLoad); document.removeEventListener("visibilitychange", visibleLoad); };
  }, [enabled, search, filter, offset, limit, revision]);
  return { data, error, loading, refresh };
}
