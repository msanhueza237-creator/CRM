import { NavLink, Outlet } from "react-router-dom";
import {
  Building2,
  FileText,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  Settings,
  Snowflake,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/empresas", label: "Empresas", icon: Building2 },
  { to: "/campanas", label: "Campanas", icon: Megaphone },
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

        <nav>
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : undefined)}>
              <item.icon size={19} />
              {item.label}
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
          </div>
        </header>

        <main className="content-shell">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
