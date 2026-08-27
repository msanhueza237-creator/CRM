import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
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
  Ship,
  Snowflake,
  WalletCards,
} from "lucide-react";
import { useAuth, type AppRole } from "../auth/AuthContext";

const navItems: Array<{ to: string; label: string; icon: typeof LayoutDashboard; roles?: AppRole[] }> = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/empresas", label: "Empresas", icon: Building2 },
  { to: "/prospeccion", label: "Prospeccion", icon: Radar },
  { to: "/agentes", label: "Agentes", icon: Bot },
  { to: "/campanas", label: "Campanas", icon: Megaphone },
  { to: "/contenido", label: "Centro de Contenido", icon: Palette },
  { to: "/comercio-exterior", label: "Comercio Exterior", icon: Ship, roles: ["administrador"] },
  { to: "/finanzas-contabilidad", label: "Finanzas", icon: WalletCards, roles: ["administrador", "finanzas"] },
  { to: "/copiloto", label: "Copiloto", icon: Bot },
  { to: "/informes", label: "Informes", icon: BarChart3 },
  { to: "/plantillas", label: "Plantillas", icon: FileText },
  { to: "/administracion", label: "Administracion", icon: Settings },
];

export function AppLayout() {
  const { user, signOut, isDemoMode } = useAuth();
  const { pathname } = useLocation();
  const navigationRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!window.matchMedia("(max-width: 1080px)").matches) return;
    navigationRef.current?.querySelector<HTMLAnchorElement>("a.active")?.scrollIntoView({
      behavior: "auto",
      block: "nearest",
      inline: "center",
    });
  }, [pathname]);

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

        <nav ref={navigationRef} aria-label="Navegacion principal">
          {navItems.filter((item) => !item.roles || (user && item.roles.includes(user.role))).map((item) => (
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
