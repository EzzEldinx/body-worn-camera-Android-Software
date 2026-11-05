import 'package:flutter/material.dart';
import '../../../../core/constants/app_constants.dart';

/// Invisible tap accumulator over the company mark.
///
/// Seven taps inside [AppConstants.adminTapWindow] invoke [onUnlocked].
/// The child looks like ordinary branding; there is no visible affordance.
class HiddenAdminDoor extends StatefulWidget {
  const HiddenAdminDoor({
    super.key,
    required this.child,
    required this.onUnlocked,
    this.requiredTaps = AppConstants.adminTapCount,
    this.window = AppConstants.adminTapWindow,
  });


  final Widget child;
  final VoidCallback onUnlocked;
  final int requiredTaps;
  final Duration window;

  @override
  State<HiddenAdminDoor> createState() => _HiddenAdminDoorState();
}

class _HiddenAdminDoorState extends State<HiddenAdminDoor> {
  int _taps = 0;
  DateTime? _windowStart;

  void _onTap() {
    final now = DateTime.now();
    if (_windowStart == null ||
        now.difference(_windowStart!) > widget.window) {
      _windowStart = now;
      _taps = 1;
      return;
    }

    _taps += 1;
    if (_taps >= widget.requiredTaps) {
      _taps = 0;
      _windowStart = null;
      widget.onUnlocked();
    }
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: _onTap,
      child: widget.child,
    );
  }
}
