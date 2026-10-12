$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$out = "C:\Projects\swg-bwc-system\button-report.txt"
"BWC button report $(Get-Date)" | Out-File $out -Encoding utf8
function Log($t) { $t | Out-File $out -Append -Encoding utf8; Write-Host $t }

Log "== Window focus =="
(& $adb shell dumpsys window) | Select-String "mCurrentFocus|mFocusedApp" | ForEach-Object { Log $_.Line.Trim() }

Log "== Vendor packages =="
(& $adb shell pm list packages) | Select-String -Pattern "lolaage|swg|bwc|smartway|torch|laser|keyevent|hotkey" | ForEach-Object { Log $_.Line }

Log "== LED and flashlight devices =="
foreach ($d in "/sys/class/leds","/sys/class/flashlight","/sys/class/torch") {
  Log "-- $d"
  (& $adb shell "ls $d 2>&1") | ForEach-Object { Log $_ }
}

Log "== Who listens for lolaage actions =="
(& $adb shell dumpsys package) | Select-String -Pattern "lolaage" -Context 0,1 | Select-Object -First 40 | ForEach-Object { Log $_.ToString() }

$buttons = @("PLUS (+)","MINUS (-)","CAMERA (camera icon)","MIC (microphone icon)","GREEN oval","SOS (orange, left side)","RECORD (orange, right side top)")
foreach ($b in $buttons) {
  Log ""
  Log "##### $b #####"
  Read-Host "Press Enter here, then press ONLY the $b button ONE time within 4 seconds"
  & $adb logcat -c
  $f = "$env:TEMP\ev.txt"
  Remove-Item $f -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $adb -ArgumentList "shell","getevent","-lt" -RedirectStandardOutput $f -NoNewWindow -PassThru
  Start-Sleep -Seconds 4
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Log "Kernel input events:"
  Get-Content $f -ErrorAction SilentlyContinue | Select-String "EV_KEY|EV_SW" | ForEach-Object { Log ("  " + $_.Line.Trim()) }
  Log "What the BWC app received:"
  (& $adb logcat -d -s flutter:I) | Select-String "Key:" | ForEach-Object { Log ("  " + $_.Line.Trim()) }
}
Log ""
Log "DONE"
