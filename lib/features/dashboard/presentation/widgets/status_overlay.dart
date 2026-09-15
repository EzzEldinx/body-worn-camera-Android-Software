import 'dart:async';

import 'package:flutter/material.dart';

import '../../../../core/constants/app_colors.dart';
import '../../../../core/constants/app_strings.dart';
import '../../../../core/utils/date_formatter.dart';

/// Live clock + officer/GPS placeholders painted over the kiosk chrome.
/// GPS coordinates will be swapped for a real stream in the camera OSD phase.
class StatusOverlay extends StatefulWidget {
  const StatusOverlay({super.key});

  @override
  State<StatusOverlay> createState() => _StatusOverlayState();
}

class _StatusOverlayState extends State<StatusOverlay> {
  late DateTime _now;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _now = DateTime.now();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) {
        return;
      }
      setState(() => _now = DateTime.now());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            _chip(AppStrings.deviceModel, AppColors.textSecondary),
            const Spacer(),
            Text(
              DateFormatter.overlayStamp(_now),
              style: const TextStyle(
                color: AppColors.textPrimary,
                fontFeatures: [FontFeature.tabularFigures()],
                fontSize: 13,
                letterSpacing: 0.4,
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Text(
          AppStrings.officerPlaceholder,
          style: const TextStyle(
            color: AppColors.textPrimary,
            fontSize: 12,
            letterSpacing: 1.2,
          ),
        ),
        const SizedBox(height: 4),
        const Text(
          AppStrings.gpsPlaceholder,
          style: TextStyle(
            color: AppColors.statusWarn,
            fontSize: 12,
            letterSpacing: 1.1,
          ),
        ),
      ],
    );
  }

  Widget _chip(String label, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.surfaceAlt,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label,
        style: TextStyle(color: color, fontSize: 11, letterSpacing: 1.4),
      ),
    );
  }
}
