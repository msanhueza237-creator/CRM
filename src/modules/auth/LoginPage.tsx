import { FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { LockKeyhole, Snowflake } from "lucide-react";
import { useAuth } from "./AuthContext";

export function LoginPage() {
  const { signIn, user, isDemoMode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("admin@climactiva.local");
  const [password, setPassword] = useState("demo1234");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to="/dashboard" replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      await signIn(email, password);
      const nextPath = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? "/dashboard";
      navigate(nextPath, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar sesion.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-brand">
        <div className="brand-mark">
          <Snowflake size={30} />
        </div>
        <p>CRM comercial</p>
        <h1>Clima Activa</h1>
        <span>Prospeccion, seguimiento y campanas para distribuidores, tiendas e instaladores.</span>
      </section>

      <form className="login-card" onSubmit={handleSubmit}>
        <div>
          <LockKeyhole size={24} />
          <h2>Iniciar sesion</h2>
          <p>{isDemoMode ? "Modo demo local activo hasta configurar Supabase." : "Usa tu cuenta autorizada."}</p>
        </div>

        <label>
          Email
          <input value={email} type="email" onChange={(event) => setEmail(event.target.value)} />
        </label>

        <label>
          Contrasena
          <input value={password} type="password" onChange={(event) => setPassword(event.target.value)} />
        </label>

        {error ? <p className="form-error">{error}</p> : null}

        <button type="submit" className="primary-button" disabled={submitting}>
          {submitting ? "Validando..." : "Entrar al CRM"}
        </button>
      </form>
    </main>
  );
}
