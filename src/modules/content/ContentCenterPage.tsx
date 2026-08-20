import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  BarChart3,
  Bot,
  CalendarDays,
  FileText,
  History,
  LayoutDashboard,
  Library,
  LoaderCircle,
  Megaphone,
  Palette,
  RefreshCw,
  Settings,
  Sparkles,
} from "lucide-react";
import { ContentCalendar } from "./ContentCalendar";
import { ContentGenerator } from "./ContentGenerator";
import { ContentLibrary } from "./ContentLibrary";
import { ContentHistory, ContentPublications, ContentStatistics } from "./ContentOperations";
import { ContentOverview } from "./ContentOverview";
import { BrandPersonality, ContentAutopilot, ContentConfiguration, ContentTemplates } from "./ContentSettings";
import { useContentCenter } from "./useContentCenter";

const views = [
  { id: "dashboard", label: "Resumen", icon: LayoutDashboard },
  { id: "library", label: "Biblioteca", icon: Library },
  { id: "generator", label: "Generador IA", icon: Sparkles },
  { id: "calendar", label: "Calendario", icon: CalendarDays },
  { id: "publications", label: "Publicaciones", icon: Megaphone },
  { id: "templates", label: "Plantillas", icon: FileText },
  { id: "brand", label: "Personalidad", icon: Palette },
  { id: "autopilot", label: "Piloto automático", icon: Bot },
  { id: "history", label: "Historial", icon: History },
  { id: "statistics", label: "Estadísticas", icon: BarChart3 },
  { id: "settings", label: "Configuración", icon: Settings },
] as const;

type ViewId = (typeof views)[number]["id"];

export function ContentCenterPage() {
  const data = useContentCenter();
  const [params, setParams] = useSearchParams();
  const requestedView = params.get("view") as ViewId | null;
  const activeView = views.some((item) => item.id === requestedView) ? requestedView! : "dashboard";
  const [selectedProductId, setSelectedProductId] = useState(params.get("product") || "");

  const navigate = useCallback((view: string, productId?: string) => {
    const next = new URLSearchParams();
    next.set("view", view);
    if (productId) next.set("product", productId);
    setParams(next);
    if (productId) setSelectedProductId(productId);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [setParams]);

  return (
    <section className="page-stack content-center-page">
      <div className="page-heading">
        <div><p>Marketing multicanal</p><h1>Centro de Contenido</h1></div>
        <button className="ghost-button" type="button" disabled={data.loading} onClick={() => void data.refresh()}><RefreshCw className={data.loading ? "spin" : ""} size={17} /> Actualizar</button>
      </div>

      <nav className="content-module-tabs" aria-label="Secciones del Centro de Contenido">
        {views.map((view) => <button className={activeView === view.id ? "active" : ""} type="button" key={view.id} onClick={() => navigate(view.id)}><view.icon size={17} /><span>{view.label}</span></button>)}
      </nav>

      {data.loading && !data.bootstrap ? <div className="panel content-loading"><LoaderCircle className="spin" size={28} /><strong>Preparando el Centro de Contenido</strong><span>Revisando conexiones y normalizando la biblioteca oficial.</span></div> : null}
      {data.error ? <div className="panel content-fatal-error"><Settings size={28} /><div><strong>No se pudo iniciar el módulo</strong><p>{data.error}</p></div><button className="ghost-button" type="button" onClick={() => void data.refresh()}><RefreshCw size={17} /> Reintentar</button></div> : null}

      {!data.error && data.bootstrap ? (
        <>
          {activeView === "dashboard" ? <ContentOverview data={data} onNavigate={navigate} /> : null}
          {activeView === "library" ? <ContentLibrary data={data} onGenerate={(productId) => navigate("generator", productId)} /> : null}
          {activeView === "generator" ? <ContentGenerator data={data} selectedProductId={selectedProductId} onProductChange={setSelectedProductId} /> : null}
          {activeView === "calendar" ? <ContentCalendar data={data} /> : null}
          {activeView === "publications" ? <ContentPublications data={data} /> : null}
          {activeView === "templates" ? <ContentTemplates data={data} /> : null}
          {activeView === "brand" ? <BrandPersonality data={data} /> : null}
          {activeView === "autopilot" ? <ContentAutopilot data={data} /> : null}
          {activeView === "history" ? <ContentHistory data={data} /> : null}
          {activeView === "statistics" ? <ContentStatistics data={data} /> : null}
          {activeView === "settings" ? <ContentConfiguration data={data} /> : null}
        </>
      ) : null}
    </section>
  );
}
