<#
.SYNOPSIS
  Builds the camera app once and installs it on every camera plugged in over USB.

.DESCRIPTION
  Each camera gets its own id / server / token from cameras.json (written to the app as config.json),
  so ONE build serves every camera. Run it from the project root:

      .\tools\update-cameras.ps1                       # build + update every connected camera
      .\tools\update-cameras.ps1 -SkipBuild            # reuse the last build (faster)
      .\tools\update-cameras.ps1 -Id BWC-06-RIY        # a camera not in cameras.json yet (one camera plugged in);
                                                       # it is added to cameras.json for next time
      .\tools\update-cameras.ps1 -Serial KS1625...     # only that camera

  Cameras can also be updated over Wi-Fi: connect them first with "adb connect <ip>:5555" and
  they are listed here like USB ones.
#>
param(
    [switch]$SkipBuild,
    [string]$Id,
    [string]$Serial,
    [string]$Config = (Join-Path $PSScriptRoot '..\cameras.json')
)

# adb writes normal progress to stderr; PowerShell must not treat that as an error (results are checked explicitly)
$ErrorActionPreference = 'Continue'
$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appDir = Join-Path $root 'app'
$pkg    = 'com.swg.swg_bwc'
$apk    = Join-Path $appDir 'build\app\outputs\flutter-apk\app-release.apk'

# ---- adb ------------------------------------------------------------------
$adb = $null
foreach ($c in @("$env:ANDROID_HOME\platform-tools\adb.exe", "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe")) {
    if ($c -and (Test-Path $c)) { $adb = $c; break }
}
if (-not $adb) { $cmd = Get-Command adb -ErrorAction SilentlyContinue; if ($cmd) { $adb = $cmd.Source } }
if (-not $adb) { throw 'adb not found. Install the Android SDK platform-tools.' }

# ---- settings -------------------------------------------------------------
if (-not (Test-Path $Config)) {
    throw "cameras.json not found at $Config. Copy cameras.example.json to cameras.json and edit it."
}
$cfg = Get-Content $Config -Raw | ConvertFrom-Json
if (-not $cfg.cameras) { $cfg | Add-Member -NotePropertyName cameras -NotePropertyValue ([pscustomobject]@{}) }

# ---- build ----------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Host '== Building the app (release) ...' -ForegroundColor Cyan
    Push-Location $appDir
    try {
        flutter build apk --release
        if ($LASTEXITCODE -ne 0) { throw 'flutter build failed' }
    } finally { Pop-Location }
}
if (-not (Test-Path $apk)) { throw "APK not found: $apk (run without -SkipBuild)" }
Write-Host ("APK: {0:N1} MB" -f ((Get-Item $apk).Length / 1MB))

# ---- devices --------------------------------------------------------------
$devices = @(& $adb devices | Select-Object -Skip 1 | ForEach-Object {
        if ($_ -match '^(\S+)\s+device$') { $Matches[1] }
    })
if ($Serial) { $devices = @($devices | Where-Object { $_ -eq $Serial }) }
if ($devices.Count -eq 0) { throw 'No camera connected (check the USB cable and that USB debugging is on).' }

$perms = @('android.permission.CAMERA', 'android.permission.RECORD_AUDIO',
    'android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.POST_NOTIFICATIONS')

$results = @()
foreach ($d in $devices) {
    $camId = $null
    if ($Id -and $devices.Count -eq 1) {
        $camId = $Id
        $cfg.cameras | Add-Member -NotePropertyName $d -NotePropertyValue $Id -Force
    } elseif ($cfg.cameras.PSObject.Properties[$d]) {
        $camId = $cfg.cameras.$d
    }
    if (-not $camId) {
        Write-Host "!! $d is not in cameras.json. Run: .\tools\update-cameras.ps1 -Id <BWC-xx-RIY> -Serial $d" -ForegroundColor Yellow
        $results += [pscustomobject]@{ Serial = $d; Camera = '-'; Result = 'SKIPPED (unknown camera)' }
        continue
    }

    Write-Host "== $camId ($d)" -ForegroundColor Cyan
    try {
        $out = (& $adb -s $d install -r $apk 2>&1 | Out-String)
        if ($out -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match') {
            Write-Host '   different signing key: reinstalling (the camera keeps its server settings)' -ForegroundColor Yellow
            & $adb -s $d uninstall $pkg | Out-Null
            $out = (& $adb -s $d install $apk 2>&1 | Out-String)
        }
        if ($out -notmatch 'Success') { throw "install failed: $($out.Trim())" }

        foreach ($p in $perms) { & $adb -s $d shell pm grant $pkg $p 2>&1 | Out-Null }

        # per-camera settings the app reads at start
        $json = @{ id = $camId; server = $cfg.server; token = $cfg.token } | ConvertTo-Json -Compress
        $tmp = Join-Path $env:TEMP "bwc-config-$d.json"
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        $dir = "/sdcard/Android/data/$pkg/files"
        & $adb -s $d shell mkdir -p $dir | Out-Null
        & $adb -s $d push $tmp "$dir/config.json" 2>&1 | Out-Null
        Remove-Item $tmp -Force

        & $adb -s $d shell am force-stop $pkg | Out-Null
        & $adb -s $d shell am start -n "$pkg/.MainActivity" | Out-Null
        $ver = ((& $adb -s $d shell dumpsys package $pkg | Select-String 'versionName=') | Select-Object -First 1).ToString().Trim()
        Write-Host "   updated, started. $ver" -ForegroundColor Green
        $results += [pscustomobject]@{ Serial = $d; Camera = $camId; Result = 'UPDATED' }
    } catch {
        Write-Host "   FAILED: $_" -ForegroundColor Red
        $results += [pscustomobject]@{ Serial = $d; Camera = $camId; Result = "FAILED: $_" }
    }
}

# remember cameras added with -Id
$cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $Config -Encoding UTF8

Write-Host ''
$results | Format-Table -AutoSize
