#Requires -Version 7
# Starts a local dolt sql-server for MCP-CAD development.
# Usage: .\scripts\run_dolt.ps1 [-DataDir <path>] [-Database <name>]
#
# Defaults match the config.yaml persistence block defaults:
#   DataDir  = ./state/dolt
#   Database = semantic_braai
#   Host     = 127.0.0.1
#   Port     = 3306

param(
    [string]$DataDir   = "./state/dolt",
    [string]$Database  = "semantic_braai",
    # NOTE: PowerShell has a reserved $Host variable; use $BindHost instead.
    [string]$BindHost  = "127.0.0.1",
    [int]   $Port      = 3306
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command dolt -ErrorAction SilentlyContinue)) {
    Write-Error "ERROR: dolt not found. Install from https://github.com/dolthub/dolt/releases"
    exit 1
}

$DbDir = Join-Path $DataDir $Database

# Initialise the database directory if it doesn't exist yet.
if (-not (Test-Path $DbDir)) {
    Write-Host "Initialising Dolt database at $DbDir ..."
    New-Item -ItemType Directory -Force -Path $DbDir | Out-Null
    Push-Location $DbDir
    dolt init
    Pop-Location
}

Write-Host "Starting dolt sql-server on ${BindHost}:${Port} (data: $DataDir) ..."
# NOTE: --user/--password were removed in Dolt 1.x. The default root user has
# no password; configure auth via CREATE USER/GRANT after first connect if you
# need it. For local dev tests, root@127.0.0.1 with empty password is fine.
& dolt sql-server `
    --host=$BindHost `
    --port=$Port `
    --data-dir=$DataDir
