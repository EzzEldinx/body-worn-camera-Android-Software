<#
.SYNOPSIS
  Builds the camera app once and installs it on every camera plugged in (USB, docking station or Wi-Fi), in parallel.

.DESCRIPTION
  Each camera gets its own id / server / token from cameras.json (written to the app as config.json),
  so ONE build serves every camera. Run it from the project root:

      .\tools\update-cameras.ps1                       # build + update every connected camera at once
      .\tools\update-cameras.ps1 -SkipBuild            # reuse the last build (faster)
      .\tools\update-cameras.ps1 -Id BWC-06-RIY        # a camera not in cameras.json yet (one camera plugged in);
                                                       # it is added to cameras.json for next time
      .\tools\update-cameras.ps1 -Serial KS1625...     # only that camera
      .\tools\update-cameras.ps1 -Provision            # one-time per camera: allow SILENT remote updates (see below)
      .\tools\update-cameras.ps1 -List                 # just list what is connected

  -Provision makes the app the device owner of the camera (adb "dpm set-device-owner"). After that, updates sent
  from the dashboard (Updates page) install silently. Android only allows this on a camera without accounts.
  Without it, a remote update still works but the camera shows an "Install" confirmation to tap.
  -Unprovision undoes it (device owner + Home app) on the connected camera.

  Cameras over Wi-Fi: "adb connect <ip>:5555" first; they are listed like USB ones.
#>
param(
    [switch]$SkipBuild,
    [switch]$Provision,
    [switch]$List,
    [switch]$Unprovision,
    [string]$Id,
    [string]$Serial,
    [int]$Parallel = 10,
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

# ---- devices --------------------------------------------------------------
$devices = @(& $adb devices | Select-Object -Skip 1 | ForEach-Object {
        if ($_ -match '^(\S+)\s+device$') { $Matches[1] }
    })
if ($Serial) { $devices = @($devices | Where-Object { $_ -eq $Serial }) }
if ($List) {
    Write-Host ("{0} camera(s) connected:" -f $devices.Count)
    $devices | ForEach-Object { Write-Host "  $_" }
    return
}
if ($devices.Count -eq 0) { throw 'No camera connected (check the USB cable / dock and that USB debugging is on).' }

# -Unprovision: undo -Provision (device owner + Home app) on the connected camera(s); nothing is installed
if ($Unprovision) {
    foreach ($d in $devices) {
        $o = (& $adb -s $d shell content call --uri content://com.swg.swg_bwc.control --method unprovision 2>&1 | Out-String)
        Write-Host ("{0}: {1}" -f $d, ($o -replace '\s+', ' ').Trim())
    }
    return
}

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
Write-Host ("APK: {0:N1} MB, {1} camera(s)" -f ((Get-Item $apk).Length / 1MB), $devices.Count)

# ---- which camera gets which id ------------------------------------------
$jobsToRun = @()
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
        $results += [pscustomobject]@{ Serial = $d; Camera = '-'; Result = 'SKIPPED (not in cameras.json)' }
        continue
    }
    $jobsToRun += [pscustomobject]@{ Serial = $d; CamId = $camId }
}

# ---- the work for one camera (runs in a background job) -------------------
$work = {
    param($adb, $d, $camId, $apk, $pkg, $server, $token, $provision)
    $perms = @('android.permission.CAMERA', 'android.permission.RECORD_AUDIO',
        'android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.POST_NOTIFICATIONS')
    $note = ''
    try {
        $out = (& $adb -s $d install -r $apk 2>&1 | Out-String)
        if ($out -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match') {
            & $adb -s $d uninstall $pkg 2>&1 | Out-Null
            $out = (& $adb -s $d install $apk 2>&1 | Out-String)
            $note += 'reinstalled (different signing key). '
        }
        if ($out -notmatch 'Success') { throw "install failed: $($out.Trim())" }

        foreach ($p in $perms) { & $adb -s $d shell pm grant $pkg $p 2>&1 | Out-Null }
        & $adb -s $d shell appops set $pkg REQUEST_INSTALL_PACKAGES allow 2>&1 | Out-Null

        $json = @{ id = $camId; server = $server; token = $token } | ConvertTo-Json -Compress
        $tmp = Join-Path $env:TEMP "bwc-config-$d.json"
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        $dir = "/sdcard/Android/data/$pkg/files"
        & $adb -s $d shell mkdir -p $dir 2>&1 | Out-Null
        & $adb -s $d push $tmp "$dir/config.json" 2>&1 | Out-Null
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue

        if ($provision) {
            # Android refuses a device owner while a second user exists. An empty "Guest" user is removed for that.
            $users = (& $adb -s $d shell pm list users 2>&1 | Out-String)
            foreach ($m in [regex]::Matches($users, 'UserInfo\{(\d+):Guest:')) {
                & $adb -s $d shell pm remove-user $m.Groups[1].Value 2>&1 | Out-Null
                $note += 'removed the unused Guest user. '
            }
            # the stock launcher must not sit under the app, or Android resumes it instead of restarting us after an update
            & $adb -s $d shell am force-stop com.android.launcher3 2>&1 | Out-Null
            # the camera's background-app limiter (MediaTek DuraSpeed) must not suppress the app
            & $adb -s $d shell dumpsys duraspeed addwhitelist $pkg 2>&1 | Out-Null
            $o = (& $adb -s $d shell dpm set-device-owner "$pkg/.BwcAdminReceiver" 2>&1 | Out-String)
            $dump = (& $adb -s $d shell dumpsys device_policy 2>&1 | Out-String)
            if ($dump -match 'Device Owner:[\s\S]{0,200}com\.swg\.swg_bwc') { $note += 'silent updates enabled (the app is now this camera''s Home app). ' }
            else { $note += 'silent updates NOT enabled: ' + ((($o -split "`n")[0]).Trim()) + ' ' }
        }

        & $adb -s $d shell am force-stop $pkg 2>&1 | Out-Null
        & $adb -s $d shell am start -n "$pkg/.MainActivity" 2>&1 | Out-Null
        return [pscustomobject]@{ Serial = $d; Camera = $camId; Result = ('UPDATED ' + $note).Trim() }
    } catch {
        return [pscustomobject]@{ Serial = $d; Camera = $camId; Result = "FAILED: $_" }
    }
}

# ---- run them in parallel (up to $Parallel at a time) ----------------------
$running = @()
$queue = [System.Collections.Queue]::new($jobsToRun)
$total = $jobsToRun.Count
$finished = 0
while ($queue.Count -gt 0 -or $running.Count -gt 0) {
    while ($queue.Count -gt 0 -and $running.Count -lt $Parallel) {
        $j = $queue.Dequeue()
        $running += Start-Job -ScriptBlock $work -ArgumentList $adb, $j.Serial, $j.CamId, $apk, $pkg, $cfg.server, $cfg.token, [bool]$Provision
    }
    $done = @($running | Where-Object { $_.State -ne 'Running' })
    foreach ($job in $done) {
        $r = Receive-Job $job | Select-Object -Last 1
        Remove-Job $job -Force
        $running = @($running | Where-Object { $_.Id -ne $job.Id })
        $finished++
        if ($r) {
            $results += $r
            $color = 'Red'
            if ($r.Result -like 'UPDATED*') { $color = 'Green' }
            Write-Host ("[{0}/{1}] {2} ({3}): {4}" -f $finished, $total, $r.Camera, $r.Serial, $r.Result) -ForegroundColor $color
        }
    }
    Start-Sleep -Milliseconds 400
}

# remember cameras added with -Id
$cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $Config -Encoding UTF8

Write-Host ''
$ok = @($results | Where-Object { $_.Result -like 'UPDATED*' }).Count
Write-Host ("{0} of {1} camera(s) updated." -f $ok, $devices.Count) -ForegroundColor Cyan
$results | Format-Table -AutoSize
