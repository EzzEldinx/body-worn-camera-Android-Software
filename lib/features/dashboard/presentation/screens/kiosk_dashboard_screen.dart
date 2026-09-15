import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/constants/app_colors.dart';
import '../../../../core/constants/app_strings.dart';
import '../providers/kiosk_controller.dart';
import '../widgets/admin_pin_dialog.dart';
import '../widgets/hidden_admin_door.dart';
import '../widgets/status_overlay.dart';

/// Dedicated-device home surface. Camera preview replaces the center later.
class KioskDashboardScreen extends ConsumerWidget {
  const KioskDashboardScreen({super.key});

  Future<void> _openAdminDoor(BuildContext context, WidgetRef ref) {
    return AdminPinDialog.show(
      context: context,
      onSuccess: () => _exitKiosk(context, ref),
    );
  }

  Future<void> _exitKiosk(BuildContext context, WidgetRef ref) async {
    Navigator.of(context).pop();
    await ref.read(kioskControllerProvider.notifier).disarm();
    await SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: AppColors.background,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
            child: Column(
              children: [
                const StatusOverlay(),
                const Spacer(),
                HiddenAdminDoor(
                  onUnlocked: () => _openAdminDoor(context, ref),
                  child: const _CompanyMark(),
                ),
                const SizedBox(height: 12),
                const Text(
                  AppStrings.kioskHint,
                  style: TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                    letterSpacing: 1.6,
                  ),
                ),
                const Spacer(),
                const _HardwareStatusBar(),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _CompanyMark extends StatelessWidget {
  const _CompanyMark();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          width: 96,
          height: 96,
          decoration: BoxDecoration(
            color: AppColors.surface,
            shape: BoxShape.circle,
            border: Border.all(color: AppColors.accentMuted, width: 2),
          ),
          child: const Icon(
            Icons.videocam,
            color: AppColors.accent,
            size: 48,
          ),
        ),
        const SizedBox(height: 16),
        const Text(
          AppStrings.companyName,
          style: TextStyle(
            color: AppColors.textPrimary,
            fontSize: 28,
            fontWeight: FontWeight.w700,
            letterSpacing: 8,
          ),
        ),
        const SizedBox(height: 4),
        const Text(
          AppStrings.appTitle,
          style: TextStyle(
            color: AppColors.textSecondary,
            fontSize: 13,
            letterSpacing: 1.2,
          ),
        ),
      ],
    );
  }
}

/// Visual stand-ins for KEY_CAMERA / SOS / PTT until hardware wiring lands.
class _HardwareStatusBar extends StatelessWidget {
  const _HardwareStatusBar();

  @override
  Widget build(BuildContext context) {
    return const Row(
      children: [
        Expanded(child: _StatusButton(label: AppStrings.recIdle, hot: false)),
        SizedBox(width: 12),
        Expanded(child: _StatusButton(label: AppStrings.sos, hot: false)),
        SizedBox(width: 12),
        Expanded(child: _StatusButton(label: AppStrings.ptt, hot: false)),
      ],
    );
  }
}

class _StatusButton extends StatelessWidget {
  const _StatusButton({required this.label, required this.hot});

  final String label;
  final bool hot;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 14),
      decoration: BoxDecoration(
        color: hot ? AppColors.accent : AppColors.surface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: hot ? AppColors.accent : AppColors.surfaceAlt,
        ),
      ),
      child: Text(
        label,
        textAlign: TextAlign.center,
        style: TextStyle(
          color: hot ? AppColors.textPrimary : AppColors.textSecondary,
          fontWeight: FontWeight.w700,
          letterSpacing: 2,
        ),
      ),
    );
  }
}
