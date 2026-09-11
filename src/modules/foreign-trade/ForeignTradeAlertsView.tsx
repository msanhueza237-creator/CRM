import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { readAllRecords } from "../../lib/readAllRecords";
type Alert = { id: string; operation_id: string | null; title: string; detail: string; severity: string; created_at: string };
export function ForeignTradeAlertsView() {
  const [rows, setRows] = useState<Alert[]>([]), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    if (!supabase) { setError("Conexión no disponible."); setLoading(false); return; }
    void readAllRecords<Alert>((from, to) => supabase!.from("foreign_trade_alerts").select("id,operation_id,title,detail,severity,created_at", { count: "exact" }).eq("status", "open").order("created_at", { ascending: false }).order("id").range(from, to))
      .then(data => { if (active) setRows(data); }).catch(error => { if (active) setError(error.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <section className="foreign-trade-view-stack"><h2>Alertas abiertas · {loading ? "Cargando" : rows.length}</h2>{error && <p role="alert">{error}</p>}{!loading && !error && !rows.length && <p>Sin alertas abiertas.</p>}{rows.map(row => <article key={row.id}><h3>{row.title}</h3><p>{row.detail}</p><small>{row.severity} · {row.created_at.slice(0, 10)}</small>{row.operation_id && <Link to={`/comercio-exterior?view=operations&operation=${row.operation_id}`}>Abrir operación</Link>}</article>)}</section>;
}
