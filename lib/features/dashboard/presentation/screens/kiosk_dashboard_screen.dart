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
  Timer? _sosTimer;
  bool _sosFired = false;
  String? _currentFile;

  StreamSubscription<HardwareKeyEvent>? _hardwareSubscription;
  String _lastHardwareKeyText = "Waiting for BWC buttons...";

  bool _isPttActive = false;
  bool _isFlashOn = false;
  bool _showPhotoFlash = false;
  
  bool _isNightModeOn = false;
  bool _isLaserOn = false;

  double _currentZoomLevel = 1.0;
  double _maxZoomLevel = 1.0;
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
  }

  void _initHardwareKeys() {
    final hardwareListener = HardwareKeyListener();
    
    _hardwareSubscription = hardwareListener.events.listen((HardwareKeyEvent event) {
      if (mounted) {
        setState(() => _lastHardwareKeyText = 'Key: ${event.keyCode} | Act: ${event.action}');
      }

      int code = event.keyCode;
      int action = event.action;

      if (code == 1002) {
        _handleSosKey(action);
        return;
      }

      if (code == 1003) { 
        if (action == 0) if (mounted) setState(() => _isPttActive = true);
        if (action == 1) if (mounted) setState(() => _isPttActive = false);
      } 
      else if (action == 1 || action == 0) {
        if (action == 0) return; 

        if (code == 1001) _toggleRecording();
        else if (code == 1002) _toggleLaserBtn();
        else if (code == 1004 || code == 27) _takePhoto();
        else if (code == 1005) {
          if (action == 0) _wasLightButtonPressed = true;
          else if (action == 1) {
            if (_wasLightButtonPressed) _wasLightButtonPressed = false;
            else _takePhoto();
          }
        }
      }
    }, onError: (error) {
      debugPrint('Channel Error: $error');
    });
  }

  Future<void> _initCamera() async {
    try {
      _cameras = await availableCameras();
      if (_cameras != null && _cameras!.isNotEmpty) {
        _controller = CameraController(
          _cameras![_selectedCameraIndex],
          ResolutionPreset.high,
          streamingPreset: ResolutionPreset.high,
          enableAudio: true,
        );

        await _controller!.initialize();

        // Zoom is optional: this plugin may not implement it natively.
        try {
          _maxZoomLevel = await _controller!.getMaxZoomLevel();
          _minZoomLevel = await _controller!.getMinZoomLevel();
          _currentZoomLevel = _minZoomLevel;
        } catch (e) {
          debugPrint('Zoom not supported by this plugin: $e');
          _maxZoomLevel = 1.0;
          _minZoomLevel = 1.0;
          _currentZoomLevel = 1.0;
        }

        if (mounted) setState(() => _isCameraInitialized = true);
      }
    } catch (e) {
      _report('CAMERA INIT FAILED: $e');
    }
  }

  Future<void> _switchCamera() async {
    if (_cameras == null || _cameras!.length < 2) return;
    setState(() => _isCameraInitialized = false);
    _selectedCameraIndex = _selectedCameraIndex == 0 ? 1 : 0;
    await _initCamera();
  }

  // ---- Storage / feedback helpers -------------------------------------
  Future<String> _mediaDir() async {
    final base = await getExternalStorageDirectory() ??
        await getApplicationDocumentsDirectory();
    final dir = Directory('${base.path}/SWG_BWC');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir.path;
  }

  void _report(String msg) {
    debugPrint(msg);
    if (mounted) setState(() => _lastHardwareKeyText = msg);
  }

  // Hold the SOS key 2 s = alert control room; short press = laser toggle.
  void _handleSosKey(int action) {
    if (action == 0) {
      _sosFired = false;
      _sosTimer?.cancel();
      _sosTimer = Timer(const Duration(seconds: 2), () {
        _sosFired = true;
        ref.read(centralLinkProvider).emitSos();
        _report('SOS SENT');
      });
    } else if (action == 1) {
      _sosTimer?.cancel();
      if (!_sosFired) _toggleLaserBtn();
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

      try {
        await c.startVideoRecordingAndStreaming(
          path,
          CentralConfig.rtmpUrl,
          bitrate: 2000 * 1024,
        );
      } catch (e) {
        // Evidence must never depend on the network: fall back to local only.
        _report('STREAM FAILED, recording locally: $e');
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

    if (mounted) setState(() => _showPhotoFlash = true);
    Future.delayed(const Duration(milliseconds: 150), () {
      if (mounted) setState(() => _showPhotoFlash = false);
    });

    try {
      final dir = await _mediaDir();
      final name = 'IMG_${DateTime.now().millisecondsSinceEpoch}.jpg';
      await c.takePicture('$dir/$name');
      _report('SAVED: $name');
    } catch (e) {
      _report('PHOTO FAILED: $e');
    }
  }

  Future<void> _toggleFlashLight() async {
    if (_controller == null || _controller!.value.isInitialized != true) return;
    try {
      _isFlashOn = !_isFlashOn;
      await _controller!.setFlashMode(_isFlashOn ? FlashMode.torch : FlashMode.off);
      if (mounted) setState(() {});
    } catch (e) {}
  }

  void _toggleNightMode() {
    setState(() => _isNightModeOn = !_isNightModeOn);
    _kioskChannel.invokeMethod('toggleIR');
  }

  void _toggleLaserBtn() {
    setState(() => _isLaserOn = !_isLaserOn);
    _kioskChannel.invokeMethod('toggleLaser'); 
    if (mounted) setState(() => _lastHardwareKeyText = "LASER: ${_isLaserOn ? 'ON' : 'OFF'}");
  }

  Future<void> _setZoomDirect(double zoom) async {
    if (_controller == null || !_isCameraInitialized) return;
    double targetZoom = zoom;
    if (targetZoom > _maxZoomLevel) targetZoom = _maxZoomLevel;
    if (targetZoom < _minZoomLevel) targetZoom = _minZoomLevel;
    
    setState(() => _currentZoomLevel = targetZoom);
    try {
      await _controller!.setZoomLevel(_currentZoomLevel);
    } catch (e) {
      debugPrint('Zoom failed: $e');
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
                      childAspectRatio: 1.2,
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
    setState(() {
      _lastHardwareKeyText = "KIOSK UNLOCKED!";
    });
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
    _sosTimer?.cancel();
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    bool isFrontCamera = false;
    double landscapeRatio = 16 / 9; 

    if (_cameras != null && _cameras!.isNotEmpty) {
      isFrontCamera = _cameras![_selectedCameraIndex].lensDirection == CameraLensDirection.front;
    }

    if (_isCameraInitialized && _controller != null) {
      final size = _controller!.value.previewSize!;
      landscapeRatio = size.width > size.height ? size.width / size.height : size.height / size.width;
    }

    return Scaffold(
      backgroundColor: Colors.black, 
      body: HiddenAdminDoor(
        // 🔥 هنا ربطنا الباب السري بظهور شاشة الـ PIN 🔥
        onUnlocked: () => _showAdminPinDialog(),
        child: Stack(
          children: [
            Positioned.fill(
              child: _isCameraInitialized
                  ? Center(
                      child: AspectRatio(
                        aspectRatio: landscapeRatio, 
                        child: RotatedBox(
                          quarterTurns: isFrontCamera ? 2 : 0,
                          child: _controller!.buildPreview(),
                        ),
                      ),
                    )
                  : const Center(child: CircularProgressIndicator(color: Colors.red)),
            ),

            if (_showPhotoFlash)
              Positioned.fill(child: Container(color: Colors.white.withOpacity(0.8))),

            SafeArea(
              child: Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 8.0),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Expanded(child: StatusOverlay()),
                        IconButton(
                          icon: const Icon(Icons.flip_camera_ios, color: Colors.white, size: 32),
                          onPressed: _switchCamera,
                        )
                      ],
                    ),
                  ),
                  
                  const Spacer(),

                  if (isRecording)
                    Container(
                      margin: const EdgeInsets.only(bottom: 16),
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                      decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(20)),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.circle, color: Colors.red, size: 12),
                          const SizedBox(width: 8),
                          Text(_formatDuration(_recordDurationInSeconds), style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold, letterSpacing: 2)),
                        ],
                      ),
                    ),
                  GestureDetector(
                    onTap: _toggleRecording,
                    child: Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: isRecording ? Colors.red : Colors.red.withOpacity(0.5),
                        border: Border.all(color: Colors.white24, width: 4),
                      ),
                      child: Icon(isRecording ? Icons.stop : Icons.videocam, size: 48, color: Colors.white),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 24.0, vertical: 8.0),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text('REC', style: TextStyle(color: isRecording ? Colors.red : Colors.white54, fontWeight: FontWeight.bold)),
                        Text('LASER (SOS)', style: TextStyle(color: _isLaserOn ? Colors.red : Colors.white54, fontWeight: FontWeight.bold)),
                        Text('PTT', style: TextStyle(color: _isPttActive ? Colors.green : Colors.white54, fontWeight: FontWeight.bold)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            
            Positioned(
              right: 16,
              top: 140,
              child: Column(
                children: [
                  _buildSideButton(icon: Icons.flash_on, color: _isFlashOn ? Colors.yellow : Colors.white, onPressed: _toggleFlashLight),
                  const SizedBox(height: 16),
                  _buildSideButton(icon: Icons.nightlight_round, color: _isNightModeOn ? Colors.blue : Colors.white, onPressed: _toggleNightMode),
                  const SizedBox(height: 16),
                  _buildSideButton(icon: Icons.flare, color: _isLaserOn ? Colors.redAccent : Colors.white, onPressed: _toggleLaserBtn),
                ],
              ),
            ),

            if (_isCameraInitialized)
              Positioned(
                left: 16,
                top: 140,
                bottom: 140,
                child: Container(
                  width: 50,
                  decoration: BoxDecoration(
                    color: Colors.black45,
                    borderRadius: BorderRadius.circular(25),
                  ),
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      IconButton(
                        icon: const Icon(Icons.add, color: Colors.white),
                        onPressed: () => _setZoomDirect(_currentZoomLevel + 0.5),
                      ),
                      Expanded(
                        child: RotatedBox(
                          quarterTurns: 3, 
                          child: Slider(
                            value: _currentZoomLevel,
                            min: _minZoomLevel,
                            max: _maxZoomLevel,
                            activeColor: Colors.red,
                            inactiveColor: Colors.white38,
                            onChanged: (value) => _setZoomDirect(value),
                          ),
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.remove, color: Colors.white),
                        onPressed: () => _setZoomDirect(_currentZoomLevel - 0.5),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '${_currentZoomLevel.toStringAsFixed(1)}x',
                        style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold),
                      ),
                    ],
                  ),
                ),
              ),

            Positioned(
              top: 80,
              right: 16,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                color: Colors.red.withOpacity(0.8),
                child: Text(_lastHardwareKeyText, style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.bold)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSideButton({required IconData icon, required Color color, required VoidCallback onPressed}) {
    return GestureDetector(
      onTap: onPressed,
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(color: Colors.black54, shape: BoxShape.circle, border: Border.all(color: Colors.white24)),
        child: Icon(icon, color: color, size: 24),
      ),
    );
  }
}