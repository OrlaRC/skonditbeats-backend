# Levanta el entorno local completo, sin Supabase ni internet:
#   PostgREST (:54322) + Supabase local (:54321) + API (:3000)
# y, si hay un celular por USB, redirige sus puertos a la PC.
# Uso:  powershell -ExecutionPolicy Bypass -File local\iniciar.ps1
#       (Ctrl+C detiene la API; PostgREST y el gateway se cierran con ella)
$ErrorActionPreference = 'Stop'
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$api  = Split-Path -Parent $aqui
$postgrest = Join-Path $aqui 'bin\postgrest.exe'
if (-not (Test-Path $postgrest)) { throw 'Falta PostgREST: corre primero local\preparar.ps1' }

# PostgREST carga libpq.dll del PATH. Si otra instalación (p. ej. C:\xampp\php) tiene
# una libpq.dll distinta antes en el PATH, PostgREST se cierra al arrancar con
# 0xC0000139 (punto de entrada no encontrado). Se antepone la de PostgreSQL 16.
$pgBin = if ($env:PG_BIN) { $env:PG_BIN } else { 'D:\PostgreSQL\16\bin' }
$env:PATH = "$pgBin;$env:PATH"

$p1 = Start-Process $postgrest -ArgumentList (Join-Path $aqui 'postgrest.conf') -PassThru -WindowStyle Hidden
$p2 = Start-Process node -ArgumentList (Join-Path $aqui 'gateway.mjs') -PassThru -WindowStyle Hidden

$adb = 'D:\AndroidSDK\platform-tools\adb.exe'
if (Test-Path $adb) {
  & $adb reverse tcp:3000 tcp:3000 2>$null | Out-Null
  & $adb reverse tcp:54321 tcp:54321 2>$null | Out-Null
}

try {
  Set-Location $api
  node --env-file=local/local.env node_modules/tsx/dist/cli.cjs src/server.ts
} finally {
  Stop-Process -Id $p1.Id, $p2.Id -ErrorAction SilentlyContinue
}
