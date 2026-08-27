import { Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./modules/auth/ProtectedRoute";
import { RoleProtectedRoute } from "./modules/auth/RoleProtectedRoute";
import { LoginPage } from "./modules/auth/LoginPage";
import { AppLayout } from "./modules/layout/AppLayout";
import { AdminPage } from "./modules/admin/AdminPage";
import { CampaignsPage } from "./modules/campaigns/CampaignsPage";
import { CompaniesPage } from "./modules/companies/CompaniesPage";
import { CompanyDetailPage } from "./modules/companies/CompanyDetailPage";
import { CompanyFormPage } from "./modules/companies/CompanyFormPage";
import { CopilotPage } from "./modules/copilot/CopilotPage";
import { DashboardPage } from "./modules/dashboard/DashboardPage";
import { TemplatesPage } from "./modules/templates/TemplatesPage";
import { ProspectingPage } from "./modules/prospecting/ProspectingPage";
import { AgentsPage } from "./modules/agents/AgentsPage";
import { AgentDashboardPage } from "./modules/agents/AgentDashboardPage";
import { ReportsPage } from "./modules/reports/ReportsPage";
import { ContentCenterPage } from "./modules/content/ContentCenterPage";
import { ForeignTradeCenterPage } from "./modules/foreign-trade/ForeignTradeCenterPage";
import { AccountingCenterPage } from "./modules/accounting/AccountingCenterPage";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/empresas" element={<CompaniesPage />} />
        <Route path="/empresas/nueva" element={<CompanyFormPage />} />
        <Route path="/empresas/:companyId" element={<CompanyDetailPage />} />
        <Route path="/empresas/:companyId/editar" element={<CompanyFormPage />} />
        <Route path="/campanas" element={<CampaignsPage />} />
        <Route path="/contenido" element={<ContentCenterPage />} />
        <Route path="/comercio-exterior" element={<RoleProtectedRoute roles={["administrador"]}><ForeignTradeCenterPage /></RoleProtectedRoute>} />
        <Route path="/finanzas-contabilidad" element={<RoleProtectedRoute roles={["administrador", "finanzas"]}><AccountingCenterPage /></RoleProtectedRoute>} />
        <Route path="/copiloto" element={<CopilotPage />} />
        <Route path="/informes" element={<ReportsPage />} />
        <Route path="/prospeccion" element={<ProspectingPage />} />
        <Route path="/plantillas" element={<TemplatesPage />} />
        <Route path="/administracion" element={<AdminPage />} />
        <Route path="/agentes" element={<AgentsPage />} />
        <Route path="/agentes/:agentType/dashboard" element={<AgentDashboardPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
