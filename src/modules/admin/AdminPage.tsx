import { Database, ShieldCheck, Users } from "lucide-react";
import { isSupabaseConfigured } from "../../lib/supabase";

export function AdminPage() {
  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <p>Configuracion y seguridad</p>
          <h1>Administracion</h1>
        </div>
      </div>

      <div className="admin-grid">
        <article className="panel admin-card">
          <Users size={24} />
          <h2>Usuarios y roles</h2>
          <p>Roles base: administrador, vendedor y visualizador. Listo para sincronizar con profiles en Supabase.</p>
        </article>
        <article className="panel admin-card">
          <ShieldCheck size={24} />
          <h2>Seguridad</h2>
          <p>Rutas protegidas, validacion de sesion y preparacion para politicas RLS por organizacion.</p>
        </article>
        <article className="panel admin-card">
          <Database size={24} />
          <h2>Supabase</h2>
          <p>{isSupabaseConfigured ? "Variables de Supabase configuradas." : "Modo demo: agrega VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY."}</p>
        </article>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <h2>Integraciones futuras</h2>
        </div>
        <div className="integration-list">
          {["Gmail", "WhatsApp Business API", "Importacion CSV/Excel"].map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
        <p className="muted integration-note">
          Estas integraciones quedan planificadas para una etapa posterior. Por ahora no se activan envios ni importaciones automaticas.
        </p>
      </div>
    </section>
  );
}
