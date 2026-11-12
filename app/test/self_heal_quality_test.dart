import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:swg_bwc/core/services/self_heal.dart';
import 'package:swg_bwc/core/services/video_quality.dart';

void main() {
  test('only a lost camera plugin triggers a restart', () {
    expect(SelfHeal.isPluginLost(MissingPluginException('No implementation found for method startVideoRecording')), isTrue);
    expect(SelfHeal.isPluginLost(Exception('MissingPluginException(No implementation found')), isTrue);
    expect(SelfHeal.isPluginLost(Exception('network down')), isFalse);
  });

  test('restarts are limited to 3 per 10 minutes so a real fault cannot loop', () {
    const now = 10000000;
    expect(SelfHeal.mayRestart([], now), isTrue);
    expect(SelfHeal.mayRestart([now - 1000, now - 2000], now), isTrue);
    expect(SelfHeal.mayRestart([now - 1000, now - 2000, now - 3000], now), isFalse);
    expect(SelfHeal.mayRestart([now - 700000, now - 800000, now - 900000], now), isTrue); // all older than 10 min
  });

  test('automatic quality follows the network and manual choices are the safe ones', () {
    expect(VideoQuality.forNetwork(fast: true), VideoQuality.p1080);
    expect(VideoQuality.forNetwork(fast: false), VideoQuality.p720);
    expect(VideoQuality.selectable, [VideoQuality.p480, VideoQuality.p720, VideoQuality.p1080]);
    expect(VideoQuality.selectable.contains(VideoQuality.p2160), isFalse);
    expect(VideoQuality.selectable.contains(VideoQuality.p240), isFalse);
  });
}
