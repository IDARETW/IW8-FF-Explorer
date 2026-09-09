$ErrorActionPreference = 'Stop'
$ViewerRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$StatePath = Join-Path $ViewerRoot '.local/preview.json'
if (-not (Test-Path -LiteralPath $StatePath)) { Write-Output 'No preview state exists.'; exit }
$State = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
foreach ($Role in @('server', 'tunnel')) {
    $ProcessId = $State."$($Role)_pid"
    $ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $ProcessInfo) { continue }
    $Expected = if ($Role -eq 'server') { $ProcessInfo.CommandLine -like ('*' + (Join-Path $ViewerRoot 'scripts\serve.py') + '*') -and $ProcessInfo.CommandLine -like "*--port $($State.port)*" } else { $ProcessInfo.Name -eq 'cloudflared.exe' -and $ProcessInfo.CommandLine -like "*http://127.0.0.1:$($State.port)*" }
    if (-not $Expected) { throw "The recorded $Role PID belongs to a different process. It was not stopped." }
    Stop-Process -Id $ProcessId
}
Remove-Item -LiteralPath $StatePath
Write-Output 'Preview server and tunnel stopped.'
