import 'dart:convert';
import 'dart:io';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;

class VoiceNoteManager {
  final AudioRecorder _audioRecorder = AudioRecorder();
  bool isRecording = false;

  // 🎙️ ebd2 el-tasgeel
  Future<void> startRecording() async {
    try {
      if (await _audioRecorder.hasPermission()) {
        final dir = await getTemporaryDirectory();
        final filePath = '${dir.path}/voice_${DateTime.now().millisecondsSinceEpoch}.m4a';
        
        await _audioRecorder.start(
          const RecordConfig(encoder: AudioEncoder.aacLc), 
          path: filePath,
        );
        isRecording = true;
      }
    } catch (e) {
      print('Error starting record: $e');
    }
  }

  // ⏹️ e2fef el-tasgeel w eb3to Base64 عبر الـ Socket
  Future<void> stopAndSend({
    required IO.Socket socket,
    required String cameraId,
  }) async {
    try {
      final path = await _audioRecorder.stop();
      isRecording = false;

      if (path != null) {
        final file = File(path);
        if (await file.exists()) {
          List<int> audioBytes = await file.readAsBytes();
          // Twyeel el-bytes l-Base64 format zay el-dashboard ma b-tstqblha
          String base64Audio = 'data:audio/m4a;base64,' + base64Encode(audioBytes);

          // Emitting via Socket.io
          socket.emit('send_message', {
            'chatType': 'PRIVATE',
            'targetId': 'admin',      // Men el-camera ll-admin (Control Room)
            'senderId': cameraId,     // ID bta3 el-camera (e.g., BWC-01-RIY)
            'message': '[Voice Note]',
            'audio': base64Audio,
            'timestamp': DateTime.now().millisecondsSinceEpoch,
          });

          // Mas7 el-file el-mo2aqt
          await file.delete();
        }
      }
    } catch (e) {
      print('Error stopping/sending record: $e');
    }
  }
}