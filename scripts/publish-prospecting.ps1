param(
  [string]$CommitMessage = "feat(prospecting): add controlled prospecting and historical base",
  [switch]$Push
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repo

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git no esta instalado." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "Node/npm no esta instalado." }
if ((git branch --show-current) -ne "main") { throw "Este script solo publica desde la rama main." }

Write-Host "1/5 Instalando dependencias reproducibles..."
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci fallo." }

Write-Host "2/5 Ejecutando pruebas y compilacion..."
npm run test:prospecting
if ($LASTEXITCODE -ne 0) { throw "Las pruebas de prospeccion fallaron." }
npm run build
if ($LASTEXITCODE -ne 0) { throw "La compilacion fallo." }
npm run lint
if ($LASTEXITCODE -ne 0) { throw "ESLint encontro errores." }

Write-Host "3/5 Agregando solo archivos publicables..."
$paths = @(
  ".env.example",
  "package.json",
  "package-lock.json",
  "eslint.config.js",
  "src/App.tsx",
  "src/lib/supabase.ts",
  "src/modules/auth/AuthContext.tsx",
  "src/modules/companies/CompanyStore.tsx",
  "src/modules/layout/AppLayout.tsx",
  "src/modules/prospecting",
  "src/styles.css",
  "src/types/crm.ts",
  "supabase/functions/crm-agent/index.ts",
  "supabase/prospecting.sql",
  "supabase/prospecting_enrichment.sql",
  "supabase/prospecting_preflight.sql",
  "supabase/prospecting_verify.sql",
  "docs/prospecting-api.md",
  "docs/deploy-prospecting-production.md",
  "scripts/test-prospecting-contract.mjs",
  "scripts/publish-prospecting.ps1"
)
git add -- $paths

$forbidden = git diff --cached --name-only | Where-Object {
  $_ -match '(^|/)(\.env\.local|backups|\.agents)(/|$)' -or $_ -match '\.(zip|bak)$'
}
if ($forbidden) {
  git restore --staged -- $forbidden
  throw "Se intento incluir un archivo local o respaldo: $($forbidden -join ', ')"
}

if (-not (git diff --cached --name-only)) { throw "No hay cambios publicables para crear el commit." }
Write-Host "4/5 Archivos preparados:"
git diff --cached --stat

git commit -m $CommitMessage
if ($LASTEXITCODE -ne 0) { throw "No fue posible crear el commit." }

if ($Push) {
  Write-Host "5/5 Subiendo a origin/main..."
  git push origin main
  if ($LASTEXITCODE -ne 0) { throw "El push fallo. El commit permanece local y se puede reintentar." }
  Write-Host "Cambios subidos. Dokploy puede reconstruir el CRM desde origin/main."
} else {
  Write-Host "5/5 Commit local creado. Revisa y luego ejecuta: git push origin main"
}
