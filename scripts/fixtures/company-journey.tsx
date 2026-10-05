import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CompanyJourney } from "../../src/modules/companies/CompanyJourney";
import { AuthProvider } from "../../src/modules/auth/AuthContext";
import { loadFixtureHistory } from "./company-journey-data";
import "../../src/styles.css";
import "../../src/modules/companies/company-insights.css";
localStorage.setItem("climactiva_demo_session", "true");
function Fixture() {
  const [action, setAction] = useState("");
  return <main style={{ padding: 20, maxWidth: 1100, margin: "auto" }}><h1>Empresa de prueba</h1><p>Datos ficticios de verificacion</p>
    <CompanyJourney companyId="11111111-1111-4111-8111-111111111111" revision={0} onRegisterQuote={() => setAction("quote")} loadHistory={loadFixtureHistory} />
    <output aria-label="Resultado de prueba">{action}</output></main>;
}
createRoot(document.getElementById("root")!).render(<AuthProvider><Fixture /></AuthProvider>);
