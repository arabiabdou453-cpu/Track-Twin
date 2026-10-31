// The Track Twin identity (direction D): red, black and white, with condensed display type.
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

abstract class C14 {
  static const red = Color(0xFFD4121F);
  static const ink = Color(0xFF14161A);
  static const ink2 = Color(0xFF3E4148);
  static const ink3 = Color(0xFF5A5E66);
  static const bg = Color(0xFFF1F1F2);
  static const soft = Color(0xFFF4F4F5);
  static const line = Color(0xFFE3E4E7);
  static const green = Color(0xFF0A8A4E);
  static const greenSoft = Color(0xFFE4F7EF);
  static const greenText = Color(0xFF06623F);
  static const amber = Color(0xFFF0A500);
  static const amberSoft = Color(0xFFFFF4E0);
  static const amberText = Color(0xFF7F4A00);
  static const redSoft = Color(0xFFFDEAEB);
  static const redText = Color(0xFFA50E19);
  static const radius = 12.0;
  // Tests run without the network, so they turn the downloaded fonts off.
  static bool webFonts = true;

  static TextStyle display(double size, {Color? color}) =>
      webFonts
          ? GoogleFonts.barlowCondensed(fontSize: size, fontWeight: FontWeight.w800, height: 1, color: color ?? ink)
          : TextStyle(fontSize: size, fontWeight: FontWeight.w800, height: 1, color: color ?? ink);

  static TextStyle cairo({double? fontSize, FontWeight? fontWeight, double? height, Color? color}) => webFonts
      ? GoogleFonts.cairo(fontSize: fontSize, fontWeight: fontWeight, height: height, color: color)
      : TextStyle(fontSize: fontSize, fontWeight: fontWeight, height: height, color: color);

  static ThemeData theme() {
    final base = ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: red, primary: red, surface: Colors.white),
      scaffoldBackgroundColor: bg,
    );
    return base.copyWith(
      textTheme: base.textTheme.apply(fontFamily: webFonts ? GoogleFonts.barlow().fontFamily : null, bodyColor: ink, displayColor: ink),
      appBarTheme: AppBarTheme(backgroundColor: ink, foregroundColor: Colors.white, titleTextStyle: display(24, color: Colors.white)),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(radius)),
      ),
    );
  }
}

class Logo extends StatelessWidget {
  const Logo({super.key, this.size = 28});
  final double size;
  @override
  Widget build(BuildContext context) => Image.asset('assets/mark.png', width: size, height: size);
}

class Brand extends StatelessWidget {
  const Brand({super.key, this.color = C14.ink});
  final Color color;
  @override
  Widget build(BuildContext context) => Directionality(
        textDirection: TextDirection.ltr,
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          const Logo(),
          const SizedBox(width: 8),
          Text('Track Twin', style: C14.display(26, color: color)),
        ]),
      );
}

class BigButton extends StatelessWidget {
  const BigButton({super.key, required this.label, required this.onPressed, this.color = C14.red, this.height = 64, this.outlined = false});
  final String label;
  final VoidCallback? onPressed;
  final Color color;
  final double height;
  final bool outlined;
  @override
  Widget build(BuildContext context) => SizedBox(
        width: double.infinity,
        height: height,
        child: outlined
            ? OutlinedButton(
                style: OutlinedButton.styleFrom(foregroundColor: C14.ink, side: const BorderSide(color: C14.ink), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(C14.radius))),
                onPressed: onPressed,
                child: Text(label, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              )
            : FilledButton(
                style: FilledButton.styleFrom(backgroundColor: color, foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(C14.radius))),
                onPressed: onPressed,
                child: Text(label, textAlign: TextAlign.center, style: const TextStyle(fontSize: 21, fontWeight: FontWeight.w700)),
              ),
      );
}

class Panel extends StatelessWidget {
  const Panel({super.key, required this.child, this.color = Colors.white});
  final Widget child;
  final Color color;
  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(C14.radius)),
        child: child,
      );
}
