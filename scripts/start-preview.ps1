param(
    [string]$AccessFile = '',
    [int]$Port = 48120,
    [string]$LibraryRoots = '',
    [string]$ExtractionConfig = '',
    [string]$Cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
)
$ErrorActionPreference = 'Stop'
$ViewerRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeRoot = Join-Path $ViewerRoot '.local'
$DefaultAccessFile = Join-Path $RuntimeRoot 'viewer-access.json'
if (-not $AccessFile -and (Test-Path -LiteralPath $DefaultAccessFile)) { $AccessFile = $DefaultAccessFile }
if (-not $AccessFile) { throw 'Run scripts/configure-replay.ps1 first, or pass -AccessFile.' }
$AuthPath = (Resolve-Path -LiteralPath $AccessFile).Path
if (-not (Test-Path -LiteralPath (Join-Path $ViewerRoot 'dist/index.html'))) { throw 'Run npm run build first.' }
if (-not (Test-Path -LiteralPath $Cloudflared)) { throw 'Cloudflared was not found.' }
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw "Port $Port is already in use." }
New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
$PythonPath = (Get-Command python).Source
$ServerPath = Join-Path $PSScriptRoot 'serve.py'
$ServerArguments = @('-u', ('"' + $ServerPath + '"'), '--access-file', ('"' + $AuthPath + '"'), '--port', $Port)
if ($LibraryRoots) { $ServerArguments += @('--library-roots', ('"' + (Resolve-Path -LiteralPath $LibraryRoots).Path + '"')) }
if (-not $ExtractionConfig -and (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'extraction.json'))) { $ExtractionConfig = Join-Path $RuntimeRoot 'extraction.json' }
if ($ExtractionConfig) { $ServerArguments += @('--extraction-config', ('"' + (Resolve-Path -LiteralPath $ExtractionConfig).Path + '"')) }
$ViewerProcess = Start-Process -FilePath $PythonPath -ArgumentList $ServerArguments -WorkingDirectory $ViewerRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $RuntimeRoot 'server.log') -RedirectStandardError (Join-Path $RuntimeRoot 'server.err.log') -PassThru
try {
    $Ready = $false
    for ($Attempt = 0; $Attempt -lt 30; $Attempt++) {
        if ($ViewerProcess.HasExited) { throw 'The preview server exited. See .local/server.err.log.' }
        try { $Response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -SkipHttpErrorCheck -TimeoutSec 2; if ([int]$Response.StatusCode -eq 401) { $Ready = $true; break } } catch {}
        Start-Sleep -Milliseconds 300
    }
    if (-not $Ready) { throw 'The authenticated preview server did not become ready.' }
    $TunnelProcess = Start-Process -FilePath $Cloudflared -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$Port", '--no-autoupdate') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $RuntimeRoot 'tunnel.log') -RedirectStandardError (Join-Path $RuntimeRoot 'tunnel.err.log') -PassThru
    $State = @{ port = $Port; server_pid = $ViewerProcess.Id; tunnel_pid = $TunnelProcess.Id; started = (Get-Date).ToString('o'); url = '' }
    for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
        if ($TunnelProcess.HasExited) { throw 'Cloudflared exited. See .local/tunnel.err.log.' }
        $Log = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'tunnel.err.log') -Raw -ErrorAction SilentlyContinue
        if ($Log -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $State.url = $Matches[0]; break }
        Start-Sleep -Milliseconds 500
    }
    $State | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'preview.json') -Encoding utf8
    if (-not $State.url) { throw 'The tunnel URL is not ready. Check .local/tunnel.err.log.' }
    Write-Output "Local preview: http://127.0.0.1:$Port"
    Write-Output "External preview: $($State.url)"
    Write-Output 'Sign in with the viewer credentials created by configure-replay.ps1.'
} catch {
    if ($TunnelProcess -and -not $TunnelProcess.HasExited) { Stop-Process -Id $TunnelProcess.Id }
    if (-not $ViewerProcess.HasExited) { Stop-Process -Id $ViewerProcess.Id }
    throw
}
