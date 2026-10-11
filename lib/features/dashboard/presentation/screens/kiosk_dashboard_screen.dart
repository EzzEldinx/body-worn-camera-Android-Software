import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:rtmp_broadcaster/rtmp_broadcaster.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../widgets/status_overlay.dart';
import '../widgets/hidden_admin_door.dart';
import '../../../../hardware/hardware_key_listener.dart';
import '../../../../core/services/central_link.dart'; 

class KioskDashboardScreen extends ConsumerStatefulWidget {
  const KioskDashboardScreen({Key? key}) : super(key: key);

  @override
  ConsumerState<KioskDashboardScreen> createState() => _KioskDashboardScreenState();
}

class _KioskDashboardScreenState extends ConsumerState<KioskDashboardScreen> {
  CameraController? _controller;
  List<CameraDescription>? _cameras;
  bool _isCameraInitialized = false;
  int _selectedCameraIndex = 0;

  bool isRecording = false;
  int _recordDurationInSeconds = 0;
  Timer? _timer;
  Timer? _sosTick;
  double _sosProgress = 0;
  bool _sosActive = false;
  Timer? _toastTimer;
  String? _toastMsg;
  bool _toastErr = false;
  bool _zoomHinted = false;
  bool _wide = true; // true: 16:9 window with black bars, false: full portrait view
  static const bool _showKeyCodes = true; // shows the last hardware key code; set false when done
  String _lastKey = '-';
  DateTime _lastZoomKey = DateTime(2000);
  DateTime _lastPhotoAt = DateTime(2000);
  StreamSubscription<String>? _linkSub;
  bool _sosFired = false;
  String? _currentFile;

  StreamSubscription<HardwareKeyEvent>? _hardwareSubscription;

  bool _isPttActive = false;
  bool _isFlashOn = false;
  bool _showPhotoFlash = false;
  
  bool _isNightModeOn = false;
  bool _isLaserOn = false;

  double _currentZoomLevel = 1.0;
  double _maxZoomLevel = 4.0;
  double _minZoomLevel = 1.0;

  bool _wasLightButtonPressed = false;

  static const MethodChannel _kioskChannel = MethodChannel('com.swg.bwc/kiosk');

  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
      DeviceOrientation.portraitDown,
    ]);
    
    _initCamera();
    _initHardwareKeys();
    _linkSub = ref.read(centralLinkProvider).messages.listen((m) {
      HapticFeedback.mediumImpact();
      _toast(m);
    });
  }

  void _initHardwareKeys() {
    final hardwareListener = HardwareKeyListener();
    
    _hardwareSubscription = hardwareListener.events.listen((HardwareKeyEvent event) {
      debugPrint('Key: ${event.keyCode} action: ${event.action}');

      final code = event.keyCode;
      final action = event.action;
      if (_showKeyCodes && mounted) {
        setState(() => _lastKey = '$code ${action == 0 ? 'down' : 'up'}');
      }

      if (code == 1002) {
        _handleSosKey(action);
        return;
      }
      if (code == 1003) {
        if (action == 0) _setPtt(true);
        if (action == 1) _setPtt(false);
        return;
      }
      // Volume keys zoom (Android codes 24/25, or the vendor's 1006/1007).
      if (code == 24 || code == 25) {
        if (action == 0) _stepZoom(code == 24);
        return;
      }
      if (code == 1006 || code == 1007) {
        if (action == 1) _stepZoom(code == 1006);
        return;
      }
      if (action == 0) return; // everything below acts on release

      if (code == 1001) {
        _toggleRecording();
      } else if (code == 1004 || code == 27) {
        _takePhoto();
      } else if (code == 1005) {
        _toggleFlashLight();
      }
    }, onError: (error) {
      debugPrint('Channel Error: $error');
    });
  }

  Future<void> _initCamera() async {
    try {
      _cameras ??= await availableCameras();
      if (_cameras != null && _cameras!.isNotEmpty) {
        _controller = CameraController(
          _cameras![_selectedCameraIndex],
          ResolutionPreset.high,
          streamingPreset: ResolutionPreset.high,
          enableAudio: true,
        );

        await _controller!.initialize();

        // Zoom is digital (screen only): this plugin has no native zoom.
        _minZoomLevel = 1.0;
        _maxZoomLevel = 4.0;
        _currentZoomLevel = 1.0;

        if (mounted) setState(() => _isCameraInitialized = true);
      }
    } catch (e) {
      _report('CAMERA INIT FAILED: $e');
    }
  }

  Future<void> _switchCamera() async {
    final list = _cameras;
    if (list == null || list.length < 2) {
      _toast('This device has only one camera');
      return;
    }
    if (isRecording) {
      _toast('Stop recording before switching cameras', error: true);
      return;
    }
    final previous = _selectedCameraIndex;
    final wantFront = list[previous].lensDirection != CameraLensDirection.front;
    final want = wantFront ? CameraLensDirection.front : CameraLensDirection.back;
    final found = list.indexWhere((c) => c.lensDirection == want);
    final next = found >= 0 ? found : (previous + 1) % list.length;

    // Release the current camera first: two controllers cannot share the hardware.
    setState(() => _isCameraInitialized = false);
    final old = _controller;
    _controller = null;
    try {
      await old?.dispose();
    } catch (_) {}

    _selectedCameraIndex = next;
    await _initCamera();
    if (!_isCameraInitialized) {
      _toast('Could not open the ${wantFront ? 'front' : 'rear'} camera, going back', error: true);
      _selectedCameraIndex = previous;
      await _initCamera();
    } else {
      _toast(wantFront ? 'Front camera' : 'Rear camera');
    }
  }

  // ---- Storage / feedback helpers -------------------------------------
  Future<String> _mediaDir() async {
    final base = await getExternalStorageDirectory() ??
        await getApplicationDocumentsDirectory();
    final dir = Directory('${base.path}/SWG_BWC');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir.path;
  }

  void _toast(String msg, {bool error = false}) {
    debugPrint(msg);
    _toastTimer?.cancel();
    if (!mounted) return;
    setState(() {
      _toastMsg = msg;
      _toastErr = error;
    });
    _toastTimer = Timer(const Duration(seconds: 3), () {
      if (mounted) setState(() => _toastMsg = null);
    });
  }

  void _report(String msg) => _toast(msg, error: msg.contains('FAIL'));

  // ---- SOS: hold 2 s (screen button or hardware key) -------------------
  void _sosDown() {
    _sosFired = false;
    _sosTick?.cancel();
    HapticFeedback.selectionClick();
    final start = DateTime.now();
    setState(() {
      _sosActive = true;
      _sosProgress = 0.02;
    });
    _sosTick = Timer.periodic(const Duration(milliseconds: 50), (t) {
      final p = DateTime.now().difference(start).inMilliseconds / 2000;
      if (p >= 1) {
        t.cancel();
        _fireSos();
      } else if (mounted) {
        setState(() => _sosProgress = p);
      }
    });
  }

  void _sosUp({bool hint = true}) {
    _sosTick?.cancel();
    if (mounted) {
      setState(() {
        _sosActive = false;
        _sosProgress = 0;
      });
    }
    if (hint && !_sosFired) _toast('Hold SOS for 2 seconds to send an alert');
  }

  void _fireSos() {
    _sosFired = true;
    HapticFeedback.heavyImpact();
    if (mounted) {
      setState(() {
        _sosActive = false;
        _sosProgress = 0;
      });
    }
    final sent = ref.read(centralLinkProvider).emitSos();
    _toast(
      sent
          ? 'SOS sent. Waiting for the control room...'
          : 'No connection. The SOS will go out as soon as the network is back.',
      error: !sent,
    );
  }

  // Hardware SOS key: hold 2 s = alert, short press = laser.
  void _handleSosKey(int action) {
    if (action == 0) {
      _sosDown();
    } else if (action == 1) {
      final fired = _sosFired;
      _sosUp(hint: false);
      if (!fired) _toggleLaserBtn();
    }
  }

  // ---- PTT -----------------------------------------------------------------
  void _setPtt(bool on) {
    if (_isPttActive == on) return;
    if (mounted) setState(() => _isPttActive = on);
    HapticFeedback.lightImpact();
    ref.read(centralLinkProvider).sendPtt(on);
    if (on) {
      _toast(isRecording
          ? 'PTT active. Your microphone is in the live stream'
          : 'PTT signal sent. Start recording so the control room can hear you');
    }
  }

  // ---- Record + live stream ---------------------------------------------
  Future<void> _toggleRecording() async {
    final c = _controller;
    if (c == null || c.value.isInitialized != true) return;
    final link = ref.read(centralLinkProvider);

    if (isRecording) {
      _timer?.cancel();
      try {
        await c.stopEverything();
        _report('SAVED: ${_currentFile?.split('/').last}');
      } catch (e) {
        _report('STOP FAILED: $e');
      }
      if (mounted) setState(() => isRecording = false);
      link.sendStatus(recording: false);
      return;
    }

    try {
      final dir = await _mediaDir();
      final path = '$dir/VID_${DateTime.now().millisecondsSinceEpoch}.mp4';
      _currentFile = path;

      var streamed = true;
      try {
        await c.startVideoRecordingAndStreaming(
          path,
          CentralConfig.rtmpUrl,
          bitrate: 2000 * 1024,
        );
      } catch (e) {
        // Evidence must never depend on the network: fall back to local only.
        streamed = false;
        debugPrint('Stream failed: $e');
        try {
          await c.stopEverything();
        } catch (_) {}
        await c.startVideoRecording(path);
      }

      if (mounted) {
        setState(() {
          isRecording = true;
          _recordDurationInSeconds = 0;
        });
      }
      link.sendStatus(recording: true);
      HapticFeedback.mediumImpact();
      _toast(streamed ? 'Recording and streaming live' : 'Recording locally, stream is offline', error: !streamed);
      _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
        if (mounted) setState(() => _recordDurationInSeconds++);
      });
    } catch (e) {
      _report('REC FAILED: $e');
    }
  }

  Future<void> _takePhoto() async {
    final c = _controller;
    if (c == null ||
        c.value.isInitialized != true ||
        c.value.isTakingPicture == true) {
      return;
    }

    final now = DateTime.now();
    if (now.difference(_lastPhotoAt).inMilliseconds < 800) return; // one key can fire twice
    _lastPhotoAt = now;
    if (mounted) setState(() => _showPhotoFlash = true);
    Future.delayed(const Duration(milliseconds: 150), () {
      if (mounted) setState(() => _showPhotoFlash = false);
    });

    try {
      final dir = await _mediaDir();
      final name = 'IMG_${DateTime.now().millisecondsSinceEpoch}.jpg';
      await c.takePicture('$dir/$name');
      HapticFeedback.mediumImpact();
      _toast('Photo saved');
    } catch (e) {
      _report('PHOTO FAILED: $e');
    }
  }

  Future<void> _toggleFlashLight() async {
    final c = _controller;
    final next = !_isFlashOn;
    String? error;
    try {
      // Native torch first (works without the streaming plugin's help).
      await _kioskChannel.invokeMethod('setTorch', {'on': next});
    } catch (e1) {
      error = '$e1';
      try {
        if (c != null && c.value.isInitialized == true) {
          await c.setFlashMode(next ? FlashMode.torch : FlashMode.off);
          error = null;
        }
      } catch (_) {}
    }
    if (error != null) {
      _toast('Torch failed: $error', error: true);
      return;
    }
    if (mounted) setState(() => _isFlashOn = next);
    _toast(next ? 'Torch on' : 'Torch off');
  }

  // Volume keys: a single press steps 0.5x, holding the key steps smoothly.
  void _stepZoom(bool zoomIn) {
    final now = DateTime.now();
    final step = now.difference(_lastZoomKey).inMilliseconds < 250 ? 0.1 : 0.5;
    _lastZoomKey = now;
    _setZoomDirect(_currentZoomLevel + (zoomIn ? step : -step));
  }

  void _toggleNightMode() {
    setState(() => _isNightModeOn = !_isNightModeOn);
    _kioskChannel.invokeMethod('toggleIR');
    _toast('Night vision ${_isNightModeOn ? 'on' : 'off'}');
  }

  void _toggleLaserBtn() {
    setState(() => _isLaserOn = !_isLaserOn);
    _kioskChannel.invokeMethod('toggleLaser');
    _toast('Laser ${_isLaserOn ? 'on' : 'off'}');
  }

  // Zoom is digital and only changes this screen: the streaming plugin has no
  // native zoom, so the recording and live stream stay at 1x.
  void _setZoomDirect(double zoom) {
    setState(() => _currentZoomLevel =
        zoom.clamp(_minZoomLevel, _maxZoomLevel).toDouble());
    if (!_zoomHinted && _currentZoomLevel > 1.0) {
      _zoomHinted = true;
      _toast('Zoom is digital and only affects this screen, not the recording');
    }
  }

  String _formatDuration(int totalSeconds) {
    int hours = totalSeconds ~/ 3600;
    int minutes = (totalSeconds % 3600) ~/ 60;
    int seconds = totalSeconds % 60;
    return '${hours.toString().padLeft(2, '0')}:${minutes.toString().padLeft(2, '0')}:${seconds.toString().padLeft(2, '0')}';
  }

  // 🔥 دالة إظهار لوحة الأرقام لفك التجميد 🔥
  Future<void> _showAdminPinDialog() async {
    String enteredPin = '';
    const String correctPin = '1234'; // تقدر تغير الـ PIN من هنا

    await showDialog(
      context: context,
      barrierDismissible: false,
      builder: (BuildContext dialogContext) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            void onNumPress(String num) {
              if (enteredPin.length < 4) {
                setDialogState(() => enteredPin += num);
                // لو كمل 4 أرقام
                if (enteredPin.length == 4) {
                  if (enteredPin == correctPin) {
                    Navigator.pop(dialogContext); // اقفل النافذة
                    _unlockKiosk(); // نفذ أمر فك التجميد
                  } else {
                    // لو غلط، رجرج الرقم وامسحه
                    setDialogState(() => enteredPin = '');
                  }
                }
              }
            }

            return AlertDialog(
              scrollable: true,
              backgroundColor: Colors.grey[900],
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
              title: const Center(child: Text('Admin Access', style: TextStyle(color: Colors.white))),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // شاشة عرض الـ PIN (بيظهر نقط بدل الأرقام)
                  Container(
                    height: 50,
                    alignment: Alignment.center,
                    child: Text(
                      enteredPin.padRight(4, '○').replaceAll(RegExp(r'[0-9]'), '●'),
                      style: const TextStyle(color: Colors.redAccent, fontSize: 32, letterSpacing: 16),
                    ),
                  ),
                  const SizedBox(height: 20),
                  // لوحة الأرقام
                  SizedBox(
                    width: 250,
                    child: GridView.count(
                      shrinkWrap: true,
                      crossAxisCount: 3,
                      mainAxisSpacing: 12,
                      crossAxisSpacing: 12,
                      childAspectRatio: 2.0,
                      physics: const NeverScrollableScrollPhysics(),
                      children: [
                        for (var i = 1; i <= 9; i++)
                          _pinButton(i.toString(), () => onNumPress(i.toString())),
                        _pinButton('C', () => setDialogState(() => enteredPin = ''), color: Colors.redAccent),
                        _pinButton('0', () => onNumPress('0')),
                        _pinButton('X', () => Navigator.pop(dialogContext), color: Colors.grey[700]!),
                      ],
                    ),
                  )
                ],
              ),
            );
          },
        );
      },
    );
  }

  // تصميم زراير لوحة الأرقام
  Widget _pinButton(String label, VoidCallback onTap, {Color color = Colors.white24}) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(10)),
        alignment: Alignment.center,
        child: Text(label, style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold)),
      ),
    );
  }

  // دالة فك التجميد الفعلية
  void _unlockKiosk() {
    _kioskChannel.invokeMethod('disableKiosk');
    _toast('Kiosk unlocked');
    // هنستنى ثانية واحدة ونخرج من التطبيق خالص
    Future.delayed(const Duration(seconds: 1), () {
      SystemNavigator.pop(); 
    });
  }

  @override
  void dispose() {
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
      DeviceOrientation.portraitDown,
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
    _hardwareSubscription?.cancel();
    _timer?.cancel();
    _sosTick?.cancel();
    _toastTimer?.cancel();
    _linkSub?.cancel();
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cams = _cameras;
    final isFront = cams != null &&
        cams.isNotEmpty &&
        cams[_selectedCameraIndex].lensDirection == CameraLensDirection.front;

    return Scaffold(
      backgroundColor: Colors.black,
      body: HiddenAdminDoor(
        onUnlocked: () => _showAdminPinDialog(),
        child: Stack(
          children: [
            Positioned.fill(child: _previewLayer(isFront)),
            if (_showPhotoFlash)
              Positioned.fill(child: Container(color: Colors.white.withValues(alpha: 0.8))),
            SafeArea(
              child: Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const StatusOverlay(),
                        if (_showKeyCodes)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text('Last key: $_lastKey', style: const TextStyle(color: Colors.white54, fontSize: 11)),
                          ),
                        const SizedBox(height: 6),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.end,
                          children: [
                            _miniBtn(_wide ? Icons.crop_portrait : Icons.crop_16_9, Colors.white, _toggleView),
                            _miniBtn(Icons.flash_on, _isFlashOn ? Colors.yellow : Colors.white, _toggleFlashLight),
                            _miniBtn(Icons.nightlight_round, _isNightModeOn ? Colors.blue : Colors.white, _toggleNightMode),
                            _miniBtn(Icons.flare, _isLaserOn ? Colors.redAccent : Colors.white, _toggleLaserBtn),
                            _miniBtn(Icons.flip_camera_ios, Colors.white, _switchCamera),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const Spacer(),
                  if (_isCameraInitialized) _zoomRow(),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 4, 12, 14),
                    child: _actions(),
                  ),
                ],
              ),
            ),
            if (_toastMsg != null)
              Align(
                alignment: const Alignment(0, 0.38),
                child: IgnorePointer(
                  child: Container(
                    margin: const EdgeInsets.symmetric(horizontal: 20),
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    decoration: BoxDecoration(
                      color: _toastErr ? Colors.red.shade800 : Colors.black87,
                      borderRadius: BorderRadius.circular(22),
                    ),
                    child: Text(
                      _toastMsg!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w600),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  void _toggleView() {
    setState(() => _wide = !_wide);
    _toast(_wide ? 'Wide view' : 'Full view');
  }

  // Preview keeps its true proportions. Wide view crops the centre of the
  // upright frame into a 16:9 window (black bars above and below hold the
  // buttons); full view shows the whole frame.
  Widget _previewLayer(bool isFront) {
    if (!_isCameraInitialized || _controller == null) {
      return const Center(child: CircularProgressIndicator(color: Colors.red));
    }
    final size = _controller!.value.previewSize;
    final a = size?.width ?? 1280.0;
    final b = size?.height ?? 720.0;
    final pw = a < b ? a : b; // upright (portrait) frame
    final ph = a < b ? b : a;

    final frame = SizedBox(
      width: pw,
      height: ph,
      child: ClipRect(
        child: Transform.scale(
          scale: _currentZoomLevel,
          child: RotatedBox(
            quarterTurns: isFront ? 2 : 0,
            child: _controller!.buildPreview(),
          ),
        ),
      ),
    );

    if (!_wide) {
      return Center(child: FittedBox(fit: BoxFit.contain, child: frame));
    }
    return LayoutBuilder(
      builder: (context, box) => Center(
        child: SizedBox(
          width: box.maxWidth,
          height: box.maxWidth * 9 / 16,
          child: ClipRect(child: FittedBox(fit: BoxFit.cover, child: frame)),
        ),
      ),
    );
  }

  Widget _miniBtn(IconData icon, Color color, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 40,
        height: 40,
        margin: const EdgeInsets.only(left: 8),
        decoration: BoxDecoration(color: Colors.black54, shape: BoxShape.circle, border: Border.all(color: Colors.white24)),
        child: Icon(icon, color: color, size: 22),
      ),
    );
  }

  Widget _zoomRow() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Row(
        children: [
          IconButton(
            icon: const Icon(Icons.remove, color: Colors.white),
            onPressed: () => _setZoomDirect(_currentZoomLevel - 0.5),
          ),
          Expanded(
            child: Slider(
              value: _currentZoomLevel,
              min: _minZoomLevel,
              max: _maxZoomLevel,
              activeColor: Colors.red,
              inactiveColor: Colors.white38,
              onChanged: _setZoomDirect,
            ),
          ),
          IconButton(
            icon: const Icon(Icons.add, color: Colors.white),
            onPressed: () => _setZoomDirect(_currentZoomLevel + 0.5),
          ),
          SizedBox(
            width: 40,
            child: Text('${_currentZoomLevel.toStringAsFixed(1)}x',
                style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  Widget _actions() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (isRecording)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.circle, color: Colors.red, size: 12),
                const SizedBox(width: 8),
                Text(_formatDuration(_recordDurationInSeconds),
                    style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold, letterSpacing: 2)),
              ],
            ),
          ),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            GestureDetector(
              onTap: _takePhoto,
              child: Container(
                width: 54,
                height: 54,
                decoration: BoxDecoration(color: Colors.black54, shape: BoxShape.circle, border: Border.all(color: Colors.white54, width: 2)),
                child: const Icon(Icons.photo_camera, color: Colors.white, size: 26),
              ),
            ),
            GestureDetector(
              onTap: _toggleRecording,
              child: Container(
                width: 76,
                height: 76,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: isRecording ? Colors.red : Colors.red.withValues(alpha: 0.55),
                  border: Border.all(color: Colors.white54, width: 3),
                ),
                child: Icon(isRecording ? Icons.stop : Icons.videocam, size: 38, color: Colors.white),
              ),
            ),
            _holdBtn(label: 'SOS', color: Colors.red, active: _sosActive, progress: _sosProgress, onDown: _sosDown, onUp: _sosUp),
            _holdBtn(label: 'PTT', color: Colors.green, active: _isPttActive, onDown: () => _setPtt(true), onUp: () => _setPtt(false)),
          ],
        ),
      ],
    );
  }

  // Press-and-hold button (SOS, PTT). Listener avoids gesture-arena delays.
  Widget _holdBtn({
    required String label,
    required Color color,
    required bool active,
    double progress = 0,
    required VoidCallback onDown,
    required VoidCallback onUp,
  }) {
    return Listener(
      onPointerDown: (_) => onDown(),
      onPointerUp: (_) => onUp(),
      onPointerCancel: (_) => onUp(),
      child: SizedBox(
        width: 62,
        height: 62,
        child: Stack(
          alignment: Alignment.center,
          children: [
            if (progress > 0)
              SizedBox(
                width: 62,
                height: 62,
                child: CircularProgressIndicator(value: progress, strokeWidth: 4, color: Colors.white, backgroundColor: Colors.white24),
              ),
            Container(
              width: 52,
              height: 52,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: active ? color : color.withValues(alpha: 0.55),
                border: Border.all(color: Colors.white54, width: 2),
              ),
              child: Text(label, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 14)),
            ),
          ],
        ),
      ),
    );
  }
}