<#
.SYNOPSIS
  Builds the camera app and uploads it to the control-room server, ready for the Updates page.

.DESCRIPTION
  Run from the project root after any change to the camera app:

      .\tools\publish-build.ps1               # build + upload (asks for your admin login)
      .\tools\publish-build.ps1 -SkipBuild    # upload the last build again

  Then open the dashboard > Updates and press "Update all outdated".
  The server address comes from cameras.json ("server"); override with -Server.
#>
param(
    [switch]$SkipBuild,
    [string]$Server,
    [string]$User,
    [string]$Password,
    [string]$Config = (Join-Path $PSScriptRoot '..\cameras.json')
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$apk  = Join-Path $root 'app\build\app\outputs\flutter-apk\app-release.apk'

if (-not $Server) {
    if (-not (Test-Path $Config)) { throw 'Pass -Server http://host:3000 or create cameras.json.' }
    $Server = (Get-Content $Config -Raw | ConvertFrom-Json).server
}
$Server = $Server.TrimEnd('/')

if (-not $SkipBuild) {
    Write-Host '== Building the app (release) ...' -ForegroundColor Cyan
    Push-Location (Join-Path $root 'app')
    try {
        flutter build apk --release
        if ($LASTEXITCODE -ne 0) { throw 'flutter build failed' }
    } finally { Pop-Location }
}
if (-not (Test-Path $apk)) { throw "APK not found: $apk" }

if (-not $User) { $User = Read-Host 'Admin username' }
if (-not $Password) {
    $sec = Read-Host 'Admin password' -AsSecureString
    $Password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$body = @{ username = $User; password = $Password } | ConvertTo-Json
try {
    Invoke-RestMethod -Uri "$Server/api/login" -Method Post -ContentType 'application/json' -Body $body -WebSession $session | Out-Null
} catch { throw "Login failed: $($_.Exception.Message)" }

Write-Host ("Uploading {0:N1} MB to {1} ..." -f ((Get-Item $apk).Length / 1MB), $Server) -ForegroundColor Cyan
$r = Invoke-RestMethod -Uri "$Server/api/admin/update/apk" -Method Put -InFile $apk -ContentType 'application/octet-stream' -WebSession $session -TimeoutSec 900
Write-Host ("Published build {0}. Open the dashboard > Updates and press 'Update all outdated'." -f $r.build.Substring(0, 12)) -ForegroundColor Green
