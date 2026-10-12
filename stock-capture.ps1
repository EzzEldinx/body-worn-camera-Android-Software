$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$dir = "C:\Projects\swg-bwc-system\stock-capture"
New-Item -ItemType Directory -Force $dir | Out-Null
& $adb shell am force-stop com.swg.swg_bwc

$focus = (& $adb shell dumpsys window) | Select-String "mCurrentFocus=Window" | Select-Object -First 1
"$focus" | Out-File "$dir\focus.txt" -Encoding utf8
Write-Host "Foreground window: $focus"
$pkg = $null
if ("$focus" -match "u0 ([\w.]+)/") { $pkg = $Matches[1] }
Write-Host "Package: $pkg"
if ($pkg) {
  $i = 0
  (& $adb shell pm path $pkg) | ForEach-Object {
    $path = ($_ -replace "package:","").Trim()
    if ($path) { $i++; & $adb pull $path "$dir\oldapp_$i.apk" | Out-Null }
  }
}
$ft = ((& $adb shell pm path com.pri.factorytest) | Select-Object -First 1) -replace "package:",""
if ($ft) { & $adb pull $ft.Trim() "$dir\factorytest.apk" | Out-Null }
(& $adb shell "ls -la /sys/class/flashlight/mt-flash-led1/ 2>&1") | Out-File "$dir\flash-sysfs.txt" -Encoding utf8

& $adb logcat -c
$p = Start-Process -FilePath $adb -ArgumentList "logcat","-b","all","-v","time" -RedirectStandardOutput "$dir\logcat.txt" -NoNewWindow -PassThru
Write-Host ""
Write-Host "NOW on the device, in the OLD app, do these, 4 seconds apart:"
Write-Host "  1) SOS once (laser on)   2) SOS again (laser off)"
Write-Host "  3) + once (flash on)     4) + again (flash off)"
Write-Host "  5) camera button once    6) mic button once"
for ($s = 45; $s -gt 0; $s--) {
  $a = (& $adb shell "cat /sys/class/flashlight/mt-flash-led1/brightness 2>&1") -join ""
  "$(Get-Date -Format HH:mm:ss) led1=$a" | Out-File "$dir\flash-state.txt" -Append -Encoding utf8
  Write-Host -NoNewline "`r$s seconds left   "
  Start-Sleep -Seconds 1
}
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
& $adb shell dumpsys activity broadcasts | Out-File "$dir\broadcasts.txt" -Encoding utf8
Compress-Archive -Path "$dir\*" -DestinationPath "C:\Projects\swg-bwc-system\stock-capture.zip" -Force
Write-Host ""
Write-Host "DONE. Send stock-capture.zip"
