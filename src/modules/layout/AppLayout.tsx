import { NavLink, Outlet } from "react-router-dom";
import {
  Building2,
  BarChart3,
  Bot,
  FileText,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  Palette,
  Radar,
  Settings,
  Snowflake,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/empresas", label: "Empresas", icon: Building2 },
  { to: "/prospeccion", label: "Prospeccion", icon: Radar },
  { to: "/agentes", label: "Agentes", icon: Bot },
  { to: "/campanas", label: "Campanas", icon: Megaphone },
  { to: "/contenido", label: "Centro de Contenido", icon: Palette },
  { to: "/copiloto", label: "Copiloto", icon: Bot },
  { to: "/informes", label: "Informes", icon: BarChart3 },
  { to: "/plantillas", label: "Plantillas", icon: FileText },
  { to: "/administracion", label: "Administracion", icon: Settings },
];

export function AppLayout() {
  const { user, signOut, isDemoMode } = useAuth();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Snowflake size={28} />
          <div>
            <strong>Clima Activa</strong>
            <span>CRM Comercial</span>
          </div>
        </div>

        <nav aria-label="Navegacion principal">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              title={item.label}
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <button className="ghost-button sidebar-signout" type="button" onClick={() => void signOut()}>
          <LogOut size={18} />
          Salir
        </button>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-title">
            <Menu size={22} />
            <div>
              <strong>Pipeline comercial</strong>
              <span>Distribuidores, tiendas e instaladores grandes</span>
            </div>
          </div>
          <div className="topbar-user">
            {isDemoMode ? <span className="mode-pill">Demo</span> : null}
            <span>{user?.name}</span>
            <button className="ghost-button topbar-signout" type="button" onClick={() => void signOut()} aria-label="Salir">
              <LogOut size={18} />
            </button>
          </div>
        </header>

        <main className="content-shell">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
