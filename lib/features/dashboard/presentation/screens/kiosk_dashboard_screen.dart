import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/rendering.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:rtmp_broadcaster/rtmp_broadcaster.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'chat_screen.dart';
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
  DateTime _lastStopAt = DateTime(2000);
  final GlobalKey _frameKey = GlobalKey();
  bool _switching = false;
  DateTime _switchStartedAt = DateTime(2000);

  // Colour palette (same family as the control-room dashboard).
  static const Color _bgTop = Color(0xFF0F1828);
  static const Color _bgBottom = Color(0xFF1B2D4A);
  static const Color _panel = Color(0xFF1D2C47);
  static const Color _amber = Color(0xFFFFC857);
  static const Color _green = Color(0xFF3DDC97);
  static const Color _red = Color(0xFFFF5D73);
  static const Color _blue = Color(0xFF5AA9FF);
  static const Color _violet = Color(0xFF9B8CFF);
  final Map<String, DateTime> _lastFire = {};
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

  void _showChatDialog() {
  final TextEditingController msgController = TextEditingController();
  String selectedChatType = 'PUBLIC'; // 'PUBLIC' or 'PRIVATE'

  showDialog(
    context: context,
    builder: (context) {
      return StatefulBuilder(
        builder: (context, setDialogState) {
          return AlertDialog(
            backgroundColor: const Color(0xFF1D2C47),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
            title: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Control Room Chat', style: TextStyle(color: Colors.white, fontSize: 16)),
                DropdownButton<String>(
                  value: selectedChatType,
                  dropdownColor: const Color(0xFF0F1828),
                  style: const TextStyle(color: Colors.white, fontSize: 12),
                  items: const [
                    DropdownMenuItem(value: 'PUBLIC', child: Text('Public Chat')),
                    DropdownMenuItem(value: 'PRIVATE', child: Text('To Admin (Private)')),
                  ],
                  onChanged: (val) {
                    if (val != null) setDialogState(() => selectedChatType = val);
                  },
                ),
              ],
            ),
            content: SizedBox(
              width: 300,
              height: 350,
              child: Column(
                children: [
                  // مكان عرض الرسائل (هنا ممكن تربطه بـ Stream أو List عندك)
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: const Color(0xFF0F1828),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: const Center(
                        child: Text(
                          'No messages yet.\nMessages from Control Room will appear here.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Colors.white54, fontSize: 12),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  // حقل كتابة الرسالة وزر الإرسال
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: msgController,
                          style: const TextStyle(color: Colors.white, fontSize: 14),
                          decoration: const InputDecoration(
                            hintText: 'Type a message...',
                            hintStyle: TextStyle(color: Colors.white38),
                            border: InputBorder.none,
                          ),
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.send, color: Color(0xFFFFC857)),
                        onPressed: () {
                          final text = msgController.text.trim();
                          if (text.isEmpty) return;

                          // إرسال الرسالة عبر الـ CentralLink
                          ref.read(centralLinkProvider).sendChatMessage(
                            chatType: selectedChatType,
                            targetId: selectedChatType == 'PUBLIC' ? 'ALL' : 'ADMIN',
                            message: text,
                          );

                          msgController.clear();
                          _toast('Message sent');
                        },
                      ),
                    ],
                  ),
                ],
              ),
            ),
          );
        },
      );
    },
  );
}

  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
      DeviceOrientation.portraitDown,
    ]);
    
    _initCamera();
    _syncNightMode();
    _initHardwareKeys();
    _linkSub = ref.read(centralLinkProvider).messages.listen((m) {
      HapticFeedback.mediumImpact();
      _toast(m);
    });

    ref.read(centralLinkProvider).sendStatus(recording: false);

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
      // Side buttons (what this device really sends, from the system log):
      //   Plus   -> "light" (1005)         -> torch        Minus -> "volume" (1007) -> speaker volume
      //   Camera -> "take.picture" (1004)  -> capture      Mic   -> "audio"  (1008) -> laser
      //   Record (1001) -> record/stop     Green (1003) -> PTT      SOS (1002) -> alert (hold)
      // Acting on release, and ignoring a repeat within 600 ms, stops one press firing twice.
      // Minus button: the vendor sends 1007 on press and 1006 on release, so only 1007 counts.
      if (code == 1006) return;
      if (code == 1007 || code == 25) {
        if (_once('volume')) _cycleVolume();
        return;
      }
      if (code == 24) {
        if (action == 1 && _once('flash')) _toggleFlashLight();
        return;
      }
      if (action == 0) return; // everything below acts on release

      if (code == 1001) {
        if (_once('record', 900)) _toggleRecording();
      } else if (code == 1004 || code == 27) {
        _takePhoto();
      } else if (code == 1005) {
        if (_once('flash')) _toggleFlashLight();
      } else if (code == 1008) {
        if (_once('laser')) _toggleLaserBtn();
      }
    }, onError: (error) {
      debugPrint('Channel Error: $error');
    });
  }

  Future<void> _initCamera() async {
    try {
      if (_cameras == null) {
        _cameras = await availableCameras();
        debugPrint('CAMERAS: ${_cameras!.map((c) => '${c.name}/${c.lensDirection}').toList()}');
        // Start on the rear camera whatever order the device lists them in.
        final back = _cameras!.indexWhere((c) => c.lensDirection == CameraLensDirection.back);
        if (back >= 0) _selectedCameraIndex = back;
      }
      final list = _cameras;
      if (list != null && list.isNotEmpty) {
        // This camera really delivers 640x480. Asking for 1280x720 only stretched the picture.
        _controller = CameraController(
          list[_selectedCameraIndex],
          ResolutionPreset.medium,
          streamingPreset: ResolutionPreset.medium,
          enableAudio: true,
        );

        await _controller!.initialize().timeout(const Duration(seconds: 10));

        // Zoom is digital (screen only): this plugin has no native zoom.
        _minZoomLevel = 1.0;
        _maxZoomLevel = 4.0;
        _currentZoomLevel = 1.0;

        if (mounted) setState(() => _isCameraInitialized = true);
      }
    } catch (e) {
      _report('CAMERA INIT FAILED: $e');
      try {
        await _controller?.dispose(); // free the hardware so the next try can open it
      } catch (_) {}
      _controller = null;
      if (mounted) setState(() => _isCameraInitialized = false);
    }
  }

  Future<void> _switchCamera() async {
    final list = _cameras;
    debugPrint('SWITCH pressed: cameras=${list?.length} switching=$_switching recording=$isRecording');
    if (list == null || list.length < 2) {
      _toast('The camera list has ${list?.length ?? 0} camera(s), cannot switch', error: true);
      return;
    }
    if (isRecording) {
      _toast('Stop recording before switching cameras', error: true);
      return;
    }
    if (_switching) {
      if (DateTime.now().difference(_switchStartedAt).inSeconds > 20) {
        _switching = false; // a previous switch hung, start over
      } else {
        _toast('Still switching, please wait');
        return;
      }
    }
    _switching = true;
    _switchStartedAt = DateTime.now();
    _toast('Switching camera...');
    final previous = _selectedCameraIndex;
    final wantFront = list[previous].lensDirection != CameraLensDirection.front;
    final want = wantFront ? CameraLensDirection.front : CameraLensDirection.back;
    final found = list.indexWhere((c) => c.lensDirection == want);
    final next = found >= 0 ? found : (previous + 1) % list.length;
    final name = wantFront ? 'front' : 'rear';

    try {
      if (mounted) setState(() => _isCameraInitialized = false);
      await _releaseCamera();
      debugPrint('SWITCH released, opening camera index $next');
      _selectedCameraIndex = next;
      await _initCamera();
      if (!_isCameraInitialized) {
        await Future.delayed(const Duration(seconds: 1)); // one more try, the hardware can be slow
        await _initCamera();
      }
      if (_isCameraInitialized) {
        _toast('${wantFront ? 'Front' : 'Rear'} camera');
      } else {
        _toast('Could not open the $name camera, going back', error: true);
        _selectedCameraIndex = previous;
        await _initCamera();
      }
    } finally {
      _switching = false;
    }
  }

  // Two cameras cannot be open together. Order matters: take the preview off the
  // screen first (so the native view closes the camera), wait, then release the
  // controller, then give the hardware a moment before opening the other camera.
  Future<void> _releaseCamera() async {
    final old = _controller;
    _controller = null;
    if (mounted) setState(() => _isCameraInitialized = false);
    await WidgetsBinding.instance.endOfFrame;
    await Future.delayed(const Duration(milliseconds: 800));
    debugPrint('SWITCH preview removed, releasing the old camera');
    try {
      await old?.dispose().timeout(const Duration(seconds: 4));
      debugPrint('SWITCH old camera released');
    } catch (e) {
      debugPrint('SWITCH dispose problem: $e');
    }
    await Future.delayed(const Duration(milliseconds: 1500));
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

  // Hardware SOS key: hold 2 s = alert (a short press only shows the hint).
  void _handleSosKey(int action) {
    if (action == 0) {
      _sosDown();
    } else if (action == 1) {
      _sosUp();
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
        _lastStopAt = DateTime.now();
        _report('SAVED: ${_currentFile?.split('/').last}');
      } catch (e) {
        _report('STOP FAILED: $e');
      }
      if (mounted) setState(() => isRecording = false);
      link.sendStatus(recording: false);
      return;
    }

    try {
      // Let the server fully close the previous stream before publishing again.
      final since = DateTime.now().difference(_lastStopAt);
      if (since < const Duration(milliseconds: 1500)) {
        await Future.delayed(const Duration(milliseconds: 1500) - since);
      }
      final dir = await _mediaDir();
      final path = '$dir/VID_${DateTime.now().millisecondsSinceEpoch}.mp4';
      _currentFile = path;

      var streamed = true;
      try {
        await c.startVideoRecordingAndStreaming(
          path,
          CentralConfig.rtmpUrl,
          bitrate: 1500 * 1024,
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
      final stamp = DateTime.now().millisecondsSinceEpoch;
      var name = 'IMG_$stamp.jpg';
      if (isRecording) {
        // A still capture would interrupt the recording, so copy the live frame instead.
        name = 'IMG_$stamp.png';
        await _grabFrame('$dir/$name');
      } else {
        try {
          await c.takePicture('$dir/$name');
        } catch (_) {
          name = 'IMG_$stamp.png';
          await _grabFrame('$dir/$name');
        }
      }
      HapticFeedback.mediumImpact();
      _toast(isRecording ? 'Scene captured, still recording' : 'Photo saved');
    } catch (e) {
      _report('PHOTO FAILED: $e');
    }
  }

  Future<void> _toggleFlashLight() async {
    final c = _controller;
    final next = !_isFlashOn;
    // The device's own system service drives the LED directly (works while recording).
    if (await _prize('com.android.led.torch', open: next ? 1 : 0)) {
      if (mounted) setState(() => _isFlashOn = next);
      _toast(next ? 'Torch on' : 'Torch off');
      return;
    }
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

  bool _once(String key, [int ms = 600]) {
    final now = DateTime.now();
    final last = _lastFire[key];
    if (last != null && now.difference(last).inMilliseconds < ms) return false;
    _lastFire[key] = now;
    return true;
  }

  // The volume button opens the system's own volume slider, so the user drags it
  // up or down by touch (a press never changes the level by itself).
  Future<void> _cycleVolume() async {
    try {
      final r = await _kioskChannel.invokeMethod<Map>('showVolume');
      final level = (r?['level'] as num?)?.toInt() ?? 0;
      final max = (r?['max'] as num?)?.toInt() ?? 1;
      _toast('Volume $level of $max. Drag the slider to change it');
    } catch (e) {
      _toast('Volume failed: $e', error: true);
    }
  }

  // Volume keys: a single press steps 0.5x, holding the key steps smoothly.
  void _stepZoom(bool zoomIn) {
    final now = DateTime.now();
    final step = now.difference(_lastZoomKey).inMilliseconds < 250 ? 0.1 : 0.5;
    _lastZoomKey = now;
    _setZoomDirect(_currentZoomLevel + (zoomIn ? step : -step));
  }

  // Sends a command to the device's system app (laser, torch, IR, black-and-white mode).
  Future<bool> _prize(String action, {int? open, int? value, String? sensormode}) async {
    try {
      await _kioskChannel.invokeMethod('prize', {
        'action': action,
        if (open != null) 'open': open,
        if (value != null) 'value': value,
        if (sensormode != null) 'sensormode': sensormode,
      });
      return true;
    } catch (e) {
      debugPrint('prize $action failed: $e');
      return false;
    }
  }

  // Reads the real black-and-white state from the device so the button always matches it.
  Future<void> _syncNightMode() async {
    try {
      final v = (await _kioskChannel.invokeMethod<String>('getBwMode'))?.trim();
      if (mounted) setState(() => _isNightModeOn = v == '1');
      if (v == '1') _toast('Night mode (black and white) is on');
    } catch (_) {}
  }

  Future<void> _toggleNightMode() async {
    final next = !_isNightModeOn;
    final ok = await _prize('com.lxy.bw.sensormode', sensormode: next ? '1' : '0');
    if (!ok) {
      _toast('Night mode failed', error: true);
      return;
    }
    if (mounted) setState(() => _isNightModeOn = next);
    _toast(next ? 'Night mode on (black and white)' : 'Night mode off (colour)');
  }

  Future<void> _toggleLaserBtn() async {
    final next = !_isLaserOn;
    final ok = await _prize('lolaage.rayled.set', open: next ? 1 : 0);
    if (!ok) {
      _toast('Laser failed', error: true);
      return;
    }
    if (mounted) setState(() => _isLaserOn = next);
    _toast('Laser ${next ? 'on' : 'off'}');
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
      backgroundColor: _bgTop,
      body: HiddenAdminDoor(
        onUnlocked: () => _showAdminPinDialog(),
        child: Stack(
          children: [
            const Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [_bgTop, _bgBottom],
                  ),
                ),
              ),
            ),
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
                          // 👈 Chat button with unread red dot badge
                          ValueListenableBuilder<Map<String, int>>(
                            valueListenable: ref.read(centralLinkProvider).unreadByChat,
                            builder: (context, unreadMap, _) {
                              final totalUnread = unreadMap.values.fold(0, (sum, count) => sum + count);
                              return Stack(
                                clipBehavior: Clip.none,
                                children: [
                                  _miniBtn(Icons.chat, _blue, () {
                                    Navigator.push(
                                      context,
                                      MaterialPageRoute(builder: (context) => ChatScreen()),
                                    );
                                  }),
                                  if (totalUnread > 0)
                                    Positioned(
                                      right: 2,
                                      top: 2,
                                      child: Container(
                                        width: 10,
                                        height: 10,
                                        decoration: const BoxDecoration(
                                          color: Colors.red,
                                          shape: BoxShape.circle,
                                        ),
                                      ),
                                    ),
                                ],
                              );
                            },
                          ), 
                            _miniBtn(_wide ? Icons.crop_portrait : Icons.crop_16_9, _blue, _toggleView),
                            _miniBtn(Icons.flash_on, _amber, _toggleFlashLight, active: _isFlashOn),
                            _miniBtn(Icons.nightlight_round, _violet, _toggleNightMode, active: _isNightModeOn),
                            _miniBtn(Icons.flip_camera_ios, _blue, _switchCamera),
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
                      color: _toastErr ? const Color(0xFFB3263E) : _panel,
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

  Future<void> _grabFrame(String path) async {
    final boundary = _frameKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
    if (boundary == null) throw 'preview not ready';
    final img = await boundary.toImage(pixelRatio: 1.0); // full preview size, without digital zoom
    final data = await img.toByteData(format: ui.ImageByteFormat.png);
    if (data == null) throw 'could not read the frame';
    await File(path).writeAsBytes(data.buffer.asUint8List());
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
          child: RepaintBoundary(
            key: _frameKey,
            child: RotatedBox(
              quarterTurns: isFront ? 2 : 0,
              child: KeyedSubtree(
                key: ObjectKey(_controller),
                child: _controller!.buildPreview(),
              ),
            ),
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
          width: box.maxWidth - 16,
          height: (box.maxWidth - 16) * 9 / 16,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: FittedBox(fit: BoxFit.cover, child: frame),
          ),
        ),
      ),
    );
  }

  Widget _miniBtn(IconData icon, Color color, VoidCallback onTap, {bool active = false}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 40,
        height: 40,
        margin: const EdgeInsets.only(left: 8),
        decoration: BoxDecoration(
          color: active ? color.withValues(alpha: 0.28) : _panel,
          shape: BoxShape.circle,
          border: Border.all(color: active ? color : color.withValues(alpha: 0.45), width: active ? 2 : 1),
        ),
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
            icon: const Icon(Icons.remove, color: _amber),
            onPressed: () => _setZoomDirect(_currentZoomLevel - 0.5),
          ),
          Expanded(
            child: Slider(
              value: _currentZoomLevel,
              min: _minZoomLevel,
              max: _maxZoomLevel,
              activeColor: _amber,
              inactiveColor: Colors.white24,
              onChanged: _setZoomDirect,
            ),
          ),
          IconButton(
            icon: const Icon(Icons.add, color: _amber),
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
                decoration: BoxDecoration(color: _panel, shape: BoxShape.circle, border: Border.all(color: _blue, width: 2)),
                child: const Icon(Icons.photo_camera, color: _blue, size: 26),
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