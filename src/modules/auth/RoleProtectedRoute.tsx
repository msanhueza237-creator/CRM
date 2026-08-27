import { Navigate } from "react-router-dom";
import { useAuth, type AppRole } from "./AuthContext";

export function RoleProtectedRoute({ roles, children }: { roles: AppRole[]; children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) return <Navigate to="/dashboard" replace />;
  return children;
}
