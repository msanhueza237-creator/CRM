import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";

interface AppUser {
  id: string;
  email: string;
  name: string;
  role: "administrador" | "vendedor" | "visualizador";
}

interface AuthContextValue {
  user: AppUser | null;
  loading: boolean;
  isDemoMode: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const demoUser: AppUser = {
  id: "demo-admin",
  email: "admin@climactiva.local",
  name: "Administrador Clima Activa",
  role: "administrador",
};

function mapSession(session: Session | null): AppUser | null {
  if (!session?.user) return null;

  return {
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.user_metadata?.full_name ?? "Usuario Clima Activa",
    role: session.user.user_metadata?.role ?? "vendedor",
  };
}

async function mapSessionWithProfile(session: Session | null): Promise<AppUser | null> {
  const fallback = mapSession(session);
  if (!fallback || !supabase) return fallback;

  const { data, error } = await supabase
    .from("profiles")
    .select("full_name, role")
    .eq("id", fallback.id)
    .maybeSingle();
  if (error || !data) return fallback;

  const role = ["administrador", "vendedor", "visualizador"].includes(String(data.role))
    ? (String(data.role) as AppUser["role"])
    : fallback.role;
  return {
    ...fallback,
    name: String(data.full_name ?? fallback.name),
    role,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(() => {
    if (isSupabaseConfigured) return null;
    return localStorage.getItem("climactiva_demo_session") === "true" ? demoUser : null;
  });
  const [loading, setLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;

    supabase.auth.getSession().then(async ({ data }) => {
      setUser(await mapSessionWithProfile(data.session));
      setLoading(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      void mapSessionWithProfile(session).then((mappedUser) => {
        setUser(mappedUser);
        setLoading(false);
      });
    });

    return () => data.subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      isDemoMode: !isSupabaseConfigured,
      signIn: async (email: string, password: string) => {
        if (!isSupabaseConfigured || !supabase) {
          if (!email || !password) throw new Error("Ingresa email y contrasena.");
          localStorage.setItem("climactiva_demo_session", "true");
          setUser({ ...demoUser, email });
          return;
        }

        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      },
      signOut: async () => {
        if (!isSupabaseConfigured || !supabase) {
          localStorage.removeItem("climactiva_demo_session");
          setUser(null);
          return;
        }

        await supabase.auth.signOut();
      },
    }),
    [loading, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth debe usarse dentro de AuthProvider.");
  return context;
}
