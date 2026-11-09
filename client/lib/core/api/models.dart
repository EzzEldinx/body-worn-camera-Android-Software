/// What the server sends to dashboards and apps (see dashboard_snapshot / dashboard_cam in server/server.js).
enum CamState { rec, online, off }

class Camera {
  Camera({
    required this.id, required this.name, required this.group, required this.online, required this.recording, required this.remote,
    required this.ptt, required this.ts, this.lat, this.lng, this.acc, this.fixTs, this.speed, this.company, this.region, this.quality, this.battery, this.batteryTs, this.holder, this.atDock = false, this.qualityAuto = false,
  });

  final String id, name, group;
  final bool online, recording, remote, ptt, qualityAuto, atDock;
  final int ts;
  final double? lat, lng, acc, speed;
  final int? fixTs, battery, batteryTs;
  final String? company, region, quality, holder;

  factory Camera.fromJson(Map j) => Camera(
        id: '${j['cameraId']}',
        name: (j['name'] is String && (j['name'] as String).isNotEmpty) ? j['name'] as String : '${j['cameraId']}',
        group: (j['grp'] ?? '') as String,
        online: j['online'] == true,
        recording: j['recording'] == true,
        remote: j['remote'] == true,
        ptt: j['ptt'] == true,
        ts: (j['ts'] as num?)?.toInt() ?? 0,
        lat: (j['lat'] as num?)?.toDouble(),
        lng: (j['lng'] as num?)?.toDouble(),
        acc: (j['acc'] as num?)?.toDouble(),
        speed: (j['speed'] as num?)?.toDouble(),
        fixTs: (j['fixTs'] as num?)?.toInt(),
        company: j['company'] as String?,
        region: j['region'] as String?,
        quality: j['quality'] as String?,
        battery: (j['battery'] as num?)?.toInt(),
        batteryTs: (j['batteryTs'] as num?)?.toInt(),
        qualityAuto: j['qualityAuto'] == true,
        atDock: j['posSrc'] == 'dock',
        holder: (j['holder'] is String && (j['holder'] as String).trim().isNotEmpty) ? (j['holder'] as String).trim() : null,
      );

  CamState get state => recording ? CamState.rec : (online ? CamState.online : CamState.off);
  bool get hasPosition => lat != null && lng != null;

  /// A GPS fix older than two minutes is shown as "last known position", like on the web dashboard.
  bool get gpsFresh => fixTs != null && DateTime.now().millisecondsSinceEpoch - fixTs! < 120000;
}

class Alarm {
  Alarm({required this.id, required this.cameraId, required this.ts, required this.ack, this.lat, this.lng});
  final int id;
  final String cameraId;
  final int ts;
  final bool ack;
  final double? lat, lng;

  factory Alarm.fromJson(Map j) => Alarm(
        id: (j['id'] as num).toInt(), cameraId: '${j['cameraId']}', ts: (j['ts'] as num?)?.toInt() ?? 0, ack: j['ack'] == true,
        lat: (j['lat'] as num?)?.toDouble(), lng: (j['lng'] as num?)?.toDouble(),
      );

  Alarm acked() => Alarm(id: id, cameraId: cameraId, ts: ts, ack: true, lat: lat, lng: lng);
}

class User {
  User({required this.id, required this.username, required this.name, required this.role, required this.staff, required this.superAdmin, this.company, this.companyId});
  final int id;
  final String username, name, role;
  final bool staff, superAdmin;
  final String? company;
  final int? companyId;

  factory User.fromJson(Map j) => User(
        id: (j['id'] as num).toInt(), username: '${j['username']}', name: '${j['name']}', role: '${j['role']}',
        staff: j['staff'] == true, superAdmin: j['super'] == true, company: j['company'] as String?, companyId: (j['companyId'] as num?)?.toInt(),
      );

  Map<String, dynamic> toJson() => {'id': id, 'username': username, 'name': name, 'role': role, 'staff': staff, 'super': superAdmin, 'company': company, 'companyId': companyId};
}

class Recording {
  Recording({required this.id, required this.cameraId, required this.filename, required this.size, required this.ts, required this.sha256});
  final int id, size, ts;
  final String cameraId, filename, sha256;
  bool get isVideo => filename.toLowerCase().endsWith('.mp4');

  factory Recording.fromJson(Map j) => Recording(
        id: (j['id'] as num).toInt(), cameraId: '${j['cameraId']}', filename: '${j['filename']}', size: (j['size'] as num).toInt(),
        ts: ((j['recordedTs'] ?? j['uploadedTs']) as num?)?.toInt() ?? 0, sha256: '${j['sha256']}',
      );
}

/// One camera sitting in a dock bay, as reported by the Dock Agent (see server/dock.js).
class DockCam {
  DockCam({required this.slot, required this.state, this.cameraId, this.company, this.battery, this.storageFreeMb, this.files, this.pendingMb,
      this.message, this.index, this.total, this.file, this.bytesDone, this.bytesTotal, this.synced, this.lastSyncTs});
  final int slot;
  final String state; // connected | offloading | synced | error | other
  final String? cameraId, company, message, file;
  final int? battery, storageFreeMb, files, pendingMb, index, total, bytesDone, bytesTotal, synced, lastSyncTs;

  factory DockCam.fromJson(Map j) {
    final p = j['progress'] is Map ? j['progress'] as Map : const {};
    int? i(Object? v) => (v as num?)?.toInt();
    return DockCam(
      slot: i(j['slot']) ?? 0, state: '${j['state'] ?? 'connected'}', cameraId: j['cameraId'] as String?, company: j['company'] as String?,
      battery: i(j['battery']), storageFreeMb: i(j['storageFreeMb']), files: i(j['files']), pendingMb: i(j['pendingMb']), message: j['message'] as String?,
      index: i(p['index']), total: i(p['total']), file: p['file'] as String?, bytesDone: i(p['bytesDone']), bytesTotal: i(p['bytesTotal']),
      synced: i(j['synced']), lastSyncTs: i(j['lastSyncTs']),
    );
  }

  double get progress => state == 'synced' ? 1 : (bytesTotal != null && bytesTotal! > 0 ? (bytesDone ?? 0) / bytesTotal! : 0);
}

class Dock {
  Dock({required this.id, required this.ts, required this.online, required this.cameras, this.mode, this.agent, this.status = 'offline'});
  final String id;
  final int ts;
  final bool online;
  final String status; // online | connecting | offline
  final String? mode, agent;
  final List<DockCam> cameras;
  factory Dock.fromJson(Map j) => Dock(
        id: '${j['id']}', ts: (j['ts'] as num?)?.toInt() ?? 0, online: j['online'] == true, status: '${j['status'] ?? (j['online'] == true ? 'online' : 'offline')}', mode: j['mode'] as String?, agent: j['agent'] as String?,
        cameras: [for (final c in (j['cameras'] as List? ?? const [])) DockCam.fromJson(c as Map)],
      );
}

class DockState {
  DockState({this.filesAwaiting = 0, required this.slots, required this.enabled, required this.docks, required this.recordings, required this.recordingsBytes, required this.todayCount, required this.todayBytes, this.freeBytes, this.totalBytes});
  final int slots, recordings, recordingsBytes, todayCount, todayBytes, filesAwaiting;
  final bool enabled;
  final List<Dock> docks;
  final int? freeBytes, totalBytes;
  factory DockState.fromJson(Map j) {
    final s = j['storage'] is Map ? j['storage'] as Map : const {};
    int n(Object? v) => (v as num?)?.toInt() ?? 0;
    return DockState(
      filesAwaiting: ((j['fileCounts'] is Map ? (j['fileCounts'] as Map)['awaiting'] : 0) as num?)?.toInt() ?? 0,
      slots: n(j['slots']) == 0 ? 10 : n(j['slots']), enabled: j['enabled'] == true,
      docks: [for (final d in (j['docks'] as List? ?? const [])) Dock.fromJson(d as Map)],
      recordings: n(s['recordings']), recordingsBytes: n(s['recordingsBytes']), todayCount: n(s['todayCount']), todayBytes: n(s['todayBytes']),
      freeBytes: (s['freeBytes'] as num?)?.toInt(), totalBytes: (s['totalBytes'] as num?)?.toInt(),
    );
  }
}


/// A video or photo the dock copied from a camera, and what is to be done with it (see server/dock.js: dock_files).
class DockFile {
  DockFile({required this.id, required this.cameraId, required this.filename, required this.size, required this.bucket, this.recordedTs, this.addedTs, this.updatedTs, this.message, this.camDelete = false, this.camDeletedTs, this.auto = false});
  final int id, size;
  final String cameraId, filename;
  final String bucket; // awaiting | queued | local | cloud | failed
  final int? recordedTs, addedTs, updatedTs, camDeletedTs;
  final String? message;
  final bool camDelete, auto;
  bool get isVideo => filename.toLowerCase().endsWith('.mp4');
  bool get removed => camDeletedTs != null;

  factory DockFile.fromJson(Map j) => DockFile(
        id: (j['id'] as num).toInt(), cameraId: '${j['cameraId']}', filename: '${j['filename']}', size: (j['size'] as num?)?.toInt() ?? 0, bucket: '${j['bucket']}',
        recordedTs: (j['recordedTs'] as num?)?.toInt(), addedTs: (j['addedTs'] as num?)?.toInt(), updatedTs: (j['updatedTs'] as num?)?.toInt(), message: j['message'] as String?,
        camDelete: (j['camDelete'] as num?) == 1, camDeletedTs: (j['camDeletedTs'] as num?)?.toInt(), auto: j['chosenBy'] == 'auto',
      );
}

class DockFiles {
  DockFiles({required this.mode, required this.counts, required this.files});
  final String mode; // ask | auto_cloud | auto_local
  final Map<String, ({int n, int bytes})> counts;
  final List<DockFile> files;
  factory DockFiles.fromJson(Map j) {
    final c = j['counts'] is Map ? j['counts'] as Map : const {};
    return DockFiles(
      mode: '${(j['policy'] is Map ? (j['policy'] as Map)['mode'] : null) ?? 'ask'}',
      counts: {for (final k in const ['awaiting', 'queued', 'local', 'cloud', 'failed']) k: (n: ((c[k] as Map?)?['n'] as num?)?.toInt() ?? 0, bytes: ((c[k] as Map?)?['bytes'] as num?)?.toInt() ?? 0)},
      files: [for (final f in (j['files'] as List? ?? const [])) DockFile.fromJson(f as Map)],
    );
  }
}


/// A Help & Support ticket (see server/support.js).
class Ticket {
  Ticket({required this.id, required this.ref, required this.subject, required this.status, required this.priority, required this.category, required this.updated, this.by, this.company, this.cameraId, this.replies = 0, this.messages = const []});
  final int id, updated, replies;
  final String ref, subject, status, priority, category;
  final String? by, company, cameraId;
  final List<TicketMessage> messages;
  factory Ticket.fromJson(Map j) => Ticket(
        id: (j['id'] as num).toInt(), ref: '${j['ref']}', subject: '${j['subject']}', status: '${j['status']}', priority: '${j['priority']}', category: '${j['category']}',
        updated: (j['updated'] as num?)?.toInt() ?? 0, by: j['by'] as String?, company: j['company'] as String?, cameraId: j['cameraId'] as String?, replies: (j['replies'] as num?)?.toInt() ?? 0,
        messages: [for (final m in (j['messages'] as List? ?? const [])) TicketMessage.fromJson(m as Map)],
      );
}

class TicketMessage {
  TicketMessage({required this.author, required this.staff, required this.body, required this.ts});
  final String author, body;
  final bool staff;
  final int ts;
  factory TicketMessage.fromJson(Map j) => TicketMessage(author: '${j['author']}', staff: j['staff'] == true, body: '${j['body']}', ts: (j['ts'] as num?)?.toInt() ?? 0);
}
