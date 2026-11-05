import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../core/constants/app_colors.dart';
import '../../../../core/constants/app_constants.dart';
import '../../../../core/constants/app_strings.dart';
import '../../../../core/security/pin_validator.dart';

/// Modal PIN sheet used only after the Hidden Admin Door fires.
class AdminPinDialog extends StatefulWidget {
  const AdminPinDialog({
    super.key,
    required this.onSuccess,
    PinValidator? validator,
  }) : validator = validator;

  final VoidCallback onSuccess;
  final PinValidator? validator;

  static Future<void> show({
    required BuildContext context,
    required VoidCallback onSuccess,
    PinValidator? validator,
  }) {
    return showDialog<void>(
      context: context,
      barrierDismissible: false,
      barrierColor: AppColors.overlayScrim,
      builder: (context) {
        return AdminPinDialog(
          onSuccess: onSuccess,
          validator: validator,
        );
      },
    );
  }

  @override
  State<AdminPinDialog> createState() => _AdminPinDialogState();
}

class _AdminPinDialogState extends State<AdminPinDialog> {
  final TextEditingController _controller = TextEditingController();
  late final PinValidator _validator;
  String? _error;

  @override
  void initState() {
    super.initState();
    _validator = widget.validator ?? PinValidator();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final pin = _controller.text.trim();
    if (_validator.validate(pin)) {
      widget.onSuccess();
      return;
    }
    setState(() {
      _error = AppStrings.pinInvalid;
      _controller.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      child: AlertDialog(
        backgroundColor: AppColors.surface,
        title: const Text(
          AppStrings.pinTitle,
          style: TextStyle(color: AppColors.textPrimary),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: _controller,
              autofocus: true,
              obscureText: true,
              maxLength: AppConstants.adminPinMaxLength,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              style: const TextStyle(
                color: AppColors.textPrimary,
                letterSpacing: 6,
                fontSize: 22,
              ),
              decoration: InputDecoration(
                hintText: AppStrings.pinHint,
                hintStyle: const TextStyle(
                  color: AppColors.textSecondary,
                  letterSpacing: 0,
                  fontSize: 16,
                ),
                counterText: '',
                errorText: _error,
                errorStyle: const TextStyle(color: AppColors.pinError),
                enabledBorder: const UnderlineInputBorder(
                  borderSide: BorderSide(color: AppColors.textSecondary),
                ),
                focusedBorder: const UnderlineInputBorder(
                  borderSide: BorderSide(color: AppColors.accent),
                ),
              ),
              onSubmitted: (_) => _submit(),
            ),
          ],  
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text(
              AppStrings.pinCancel,
              style: TextStyle(color: AppColors.textSecondary),
            ),
          ),
          TextButton(
            onPressed: _submit,
            child: const Text(
              AppStrings.pinConfirm,
              style: TextStyle(color: AppColors.accent),
            ),
          ),
        ],
      ),
    );
  }
}