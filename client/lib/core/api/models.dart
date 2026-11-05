/// What the server sends to dashboards and apps (see dashboard_snapshot / dashboard_cam in server/server.js).
enum CamState { rec, online, off }

class Camera {
  Camera({
    required this.id, required this.name, required this.group, required this.online, required this.recording, required this.remote,
    required this.ptt, required this.ts, this.lat, this.lng, this.acc, this.fixTs, this.speed, this.company, this.region, this.quality,
  });

  final String id, name, group;
  final bool online, recording, remote, ptt;
  final int ts;
  final double? lat, lng, acc, speed;
  final int? fixTs;
  final String? company, region, quality;

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
