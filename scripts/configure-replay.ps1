[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ReplayRoot,
    [Parameter(Mandatory = $true)][string]$Acts,
    [string]$Username = 'viewer',
    [Security.SecureString]$Password,
    [string]$Cache = ''
)

$ErrorActionPreference = 'Stop'
$ViewerRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeRoot = Join-Path $ViewerRoot '.local'

if ($Username -notmatch '^[A-Za-z0-9_.-]{1,64}$') { throw 'Username must be 1-64 letters, numbers, dots, dashes, or underscores.' }
$ReplayPath = (Resolve-Path -LiteralPath $ReplayRoot).Path
$ActsPath = (Resolve-Path -LiteralPath $Acts).Path
if (-not (Test-Path -LiteralPath $ActsPath -PathType Leaf)) { throw 'ACTS must point to acts.exe from the MW2019 Replay-capable ACTS fork.' }

$GameExe = Get-ChildItem -LiteralPath $ReplayPath -Filter 'game_dx12_ship_replay.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $GameExe) { throw 'The selected folder does not contain game_dx12_ship_replay.exe. Select the root of a 1.20 Replay installation.' }
$GameRoot = $GameExe.DirectoryName
$Oodle = Join-Path $GameRoot 'oo2core_7_win64.dll'
$Zone = Join-Path $GameRoot 'zone'
if (-not (Test-Path -LiteralPath $Oodle -PathType Leaf)) { throw "Missing Replay Oodle library: $Oodle" }
if (-not (Test-Path -LiteralPath $Zone -PathType Container)) { throw "Missing Replay zone directory: $Zone" }
$Fastfiles = @(Get-ChildItem -LiteralPath $Zone -Filter '*.ff' -File -Recurse -ErrorAction SilentlyContinue)
if (-not $Fastfiles.Count) { throw "No .ff files were found below $Zone" }

if (-not $Password) { $Password = Read-Host -AsSecureString 'Create a viewer password' }
$PasswordBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
try {
    $PasswordText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($PasswordBstr)
    if ([string]::IsNullOrWhiteSpace($PasswordText)) { throw 'Viewer password cannot be empty.' }
    $Realm = 'MW2019 Replay Fastfile Viewer'
    $Bytes = [Text.Encoding]::UTF8.GetBytes("$Username`:$Realm`:$PasswordText")
    $Hash = [Security.Cryptography.MD5]::HashData($Bytes)
    $DigestHa1 = ([BitConverter]::ToString($Hash) -replace '-', '').ToLowerInvariant()
} finally {
    if ($PasswordBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($PasswordBstr) }
}

if (-not $Cache) { $Cache = Join-Path $env:LOCALAPPDATA 'MW19ReplayFastfileViewer\cache' }
New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
$Config = [ordered]@{
    acts = $ActsPath
    game_exe = $GameExe.FullName
    oodle = $Oodle
    xpak_dir = $Zone
    cache = [IO.Path]::GetFullPath($Cache)
    timeout_seconds = 3600
    reserve_bytes = 2147483648
    max_output_bytes = 68719476736
}
$Roots = @(
    [ordered]@{ id = 'replay_zone'; label = 'MW2019 1.20 Replay fastfiles'; path = $Zone }
)
[ordered]@{ username = $Username; digest_ha1 = $DigestHa1 } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'viewer-access.json') -Encoding utf8
$Config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'extraction.json') -Encoding utf8
$Roots | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'library-roots.json') -Encoding utf8

Write-Output "Connected: $($GameExe.FullName)"
Write-Output "Indexed fastfiles: $($Fastfiles.Count)"
Write-Output "Local cache: $($Config.cache)"
Write-Output 'Run scripts/start-local.ps1 to browse and extract fastfiles on this PC.'
