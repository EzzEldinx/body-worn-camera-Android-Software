/// GPS stream for OSD watermarking. Implemented with the camera overlay phase.
class GpsLocationStream {
  const GpsLocationStream();

  Stream<String> get coordinateOverlay async* {
    yield 'GPS — ACQUIRING';
  }
}
