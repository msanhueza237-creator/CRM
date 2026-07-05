param (
    [Parameter(Mandatory=$false, Position=0)]
    [string]$Message
)

if ([string]::IsNullOrWhiteSpace($Message)) {
    $Message = Read-Host "`n📝 Por favor, ingresa el mensaje del commit"
}

if ([string]::IsNullOrWhiteSpace($Message)) {
    Write-Host "`n❌ Error: El mensaje de commit no puede estar vacío." -ForegroundColor Red
    Exit 1
}

Write-Host ""
Write-Host "🚀 Iniciando workflow de commit..." -ForegroundColor Cyan

Write-Host "`n📦 Ejecutando: git add ." -ForegroundColor Gray
git add .
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n❌ Error ejecutando git add ." -ForegroundColor Red
    Exit $LASTEXITCODE
}

Write-Host "`n💾 Ejecutando: git commit -m `"$Message`"" -ForegroundColor Gray
git commit -m $Message
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n❌ Error ejecutando git commit." -ForegroundColor Red
    Exit $LASTEXITCODE
}

Write-Host "`n📤 Ejecutando: git push" -ForegroundColor Gray
git push
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n❌ Error ejecutando git push." -ForegroundColor Red
    Exit $LASTEXITCODE
}

Write-Host ""
Write-Host "✨ ¡Código subido con éxito al repositorio!" -ForegroundColor Green
Write-Host ""
