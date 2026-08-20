import { useCallback, useEffect, useState } from "react";
import { getContentBootstrap, getContentProducts } from "../../lib/contentCenterApi";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import type {
  ContentBootstrap,
  ContentHistoryEvent,
  ContentProduct,
  ContentPublication,
} from "../../types/content";

interface MetricRow {
  id: string;
  publication_id: string;
  observed_at: string;
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  clicks: number | null;
  engagement_rate: number | null;
}

export function useContentCenter() {
  const [bootstrap, setBootstrap] = useState<ContentBootstrap | null>(null);
  const [products, setProducts] = useState<ContentProduct[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [publications, setPublications] = useState<ContentPublication[]>([]);
  const [history, setHistory] = useState<ContentHistoryEvent[]>([]);
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setError("Conecta Supabase para usar el Centro de Contenido.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const initial = await getContentBootstrap();
      const [library, publicationResult, historyResult, metricResult] = await Promise.all([
        getContentProducts({ limit: 500 }),
        supabase.from("content_publications").select("*").order("created_at", { ascending: false }).limit(1000),
        supabase.from("content_history").select("*").order("created_at", { ascending: false }).limit(300),
        supabase.from("content_metrics").select("*").order("observed_at", { ascending: false }).limit(1000),
      ]);
      const firstError = publicationResult.error || historyResult.error || metricResult.error;
      if (firstError) throw firstError;
      setBootstrap(initial);
      setProducts(library.products);
      setCategories(library.categories);
      setPublications((publicationResult.data ?? []) as ContentPublication[]);
      setHistory((historyResult.data ?? []) as ContentHistoryEvent[]);
      setMetrics((metricResult.data ?? []) as MetricRow[]);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "No se pudo cargar el Centro de Contenido.";
      setError(message.includes("content_") || message.includes("404")
        ? "Falta instalar la migracion y la Edge Function del Centro de Contenido."
        : message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    bootstrap,
    categories,
    error,
    history,
    loading,
    metrics,
    products,
    publications,
    refresh: load,
  };
}

export type ContentCenterData = ReturnType<typeof useContentCenter>;
