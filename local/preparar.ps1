# Prepara el entorno local (una sola vez, o cada vez que quieras datos limpios):
#   1. Descarga PostgREST si falta (único paso que necesita internet).
#   2. Crea la base skondit_local en el PostgreSQL de la PC, con esquema y datos de prueba.
# Uso:  powershell -ExecutionPolicy Bypass -File local\preparar.ps1
$ErrorActionPreference = 'Stop'
$aqui  = Split-Path -Parent $MyInvocation.MyCommand.Path
$pgBin = if ($env:PG_BIN) { $env:PG_BIN } else { 'D:\PostgreSQL\16\bin' }
$psql  = Join-Path $pgBin 'psql.exe'
$con   = @('-U', 'postgres', '-h', '127.0.0.1', '-X', '-q', '-v', 'ON_ERROR_STOP=1')

$postgrest = Join-Path $aqui 'bin\postgrest.exe'
if (-not (Test-Path $postgrest)) {
  New-Item -ItemType Directory -Force (Join-Path $aqui 'bin') | Out-Null
  $zip = Join-Path $aqui 'bin\postgrest.zip'
  Write-Host 'Descargando PostgREST v16.5...'
  Invoke-WebRequest 'https://github.com/PostgREST/postgrest/releases/download/v16.5/postgrest-v16.5-windows-x86-64.zip' -OutFile $zip
  Expand-Archive $zip (Join-Path $aqui 'bin') -Force
  Remove-Item $zip
}

$existe = & $psql @con -At -c "select 1 from pg_database where datname = 'skondit_local'"
if ($existe -ne '1') { & $psql @con -c 'create database skondit_local' }
& $psql @con -d skondit_local -f (Join-Path $aqui 'schema.sql')
& $psql @con -d skondit_local -f (Join-Path $aqui 'indices.sql')
& $psql @con -d skondit_local -f (Join-Path $aqui 'seed.sql')
Write-Host 'Listo. Arranca todo con: powershell -ExecutionPolicy Bypass -File local\iniciar.ps1'
