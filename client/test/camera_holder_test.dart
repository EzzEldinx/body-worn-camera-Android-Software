import 'package:flutter_test/flutter_test.dart';
import 'package:visionguard_client/core/api/models.dart';

void main() {
  test('holder comes from the server and blank means none', () {
    expect(Camera.fromJson({'cameraId': 'A', 'holder': '  محمد القحطاني '}).holder, 'محمد القحطاني');
    expect(Camera.fromJson({'cameraId': 'A', 'holder': '  '}).holder, isNull);
    expect(Camera.fromJson({'cameraId': 'A'}).holder, isNull);
  });
}
