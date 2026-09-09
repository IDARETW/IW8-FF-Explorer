[CmdletBinding()]
param([ValidateRange(1024, 65535)][int]$Port = 48120)

$ErrorActionPreference = 'Stop'
$ViewerRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeRoot = Join-Path $ViewerRoot '.local'
foreach ($Name in 'viewer-access.json', 'library-roots.json', 'extraction.json') {
    if (-not (Test-Path -LiteralPath (Join-Path $RuntimeRoot $Name) -PathType Leaf)) {
        throw "Missing .local/$Name. Run scripts/configure-replay.ps1 first."
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $ViewerRoot 'dist/index.html') -PathType Leaf)) { throw 'Build the viewer first: npm ci; npm run build' }
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw "Port $Port is already in use." }

$Python = (Get-Command python -ErrorAction Stop).Source
& $Python (Join-Path $PSScriptRoot 'serve.py') `
    --access-file (Join-Path $RuntimeRoot 'viewer-access.json') `
    --library-roots (Join-Path $RuntimeRoot 'library-roots.json') `
    --extraction-config (Join-Path $RuntimeRoot 'extraction.json') `
    --port $Port
