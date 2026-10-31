// The witness: one big button, then a clear result. Arabic, for someone frightened on a roadside.
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import 'api.dart';
import 'theme.dart';

// This prototype reaches no real agent, so it must not dial the real 14 or let anyone believe help is coming.
// Set to true only once the Civil Protection has approved it and an agent really watches these reports.
const live14 = false;

typedef Fix = ({double lat, double lon, double accuracy});
typedef Locate = Future<Fix> Function();

Future<Fix> deviceFix() async {
  var permission = await Geolocator.checkPermission();
  if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
  if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
    throw const PermissionDeniedException('denied');
  }
  final p = await Geolocator.getCurrentPosition(
    locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 15)),
  );
  return (lat: p.latitude, lon: p.longitude, accuracy: p.accuracy);
}

enum Step { home, sending, confirmed, failed }

class ReportScreen extends StatefulWidget {
  const ReportScreen({super.key, required this.api, this.locate = deviceFix});
  final Api api;
  final Locate locate;
  @override
  State<ReportScreen> createState() => _ReportScreenState();
}

class _ReportScreenState extends State<ReportScreen> {
  static const _resendAfter = Duration(minutes: 2);
  static const _maxTries = 4;
  Step step = Step.home;
  String failReason = '';
  DateTime? sentAt;
  final phone = TextEditingController();

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((p) {
      if (mounted) phone.text = p.getString('phone') ?? '';
    });
  }

  @override
  void dispose() {
    phone.dispose();
    super.dispose();
  }

  Future<void> _call() async {
    if (live14) await launchUrl(Uri.parse('tel:14'));
  }

  Future<void> start() async {
    unawaited(_call());
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('phone', phone.text.trim());
    if (sentAt != null && DateTime.now().difference(sentAt!) < _resendAfter) {
      setState(() => step = Step.confirmed);
      return;
    }
    setState(() => step = Step.sending);
    Fix fix;
    try {
      fix = await widget.locate();
    } on PermissionDeniedException {
      return _fail('لم تسمح بمشاركة الموقع. أخبر العون بمكانك على الخط.');
    } catch (_) {
      return _fail('لم نحدد موقعك. أخبر العون بمكانك على الخط.');
    }
    for (var attempt = 1; attempt <= _maxTries; attempt++) {
      try {
        await widget.api.report(lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, phone: phone.text.trim().isEmpty ? null : phone.text.trim());
        sentAt = DateTime.now();
        if (mounted) setState(() => step = Step.confirmed);
        return;
      } on ApiError {
        return _fail('لم يقبل الخادم البلاغ. أخبر العون بمكانك على الخط.');
      } catch (_) {
        if (attempt < _maxTries) await Future<void>.delayed(const Duration(seconds: 5));
      }
    }
    _fail('لا يوجد اتصال بالإنترنت. أخبر العون بمكانك على الخط.');
  }

  void _fail(String reason) {
    if (!mounted) return;
    setState(() {
      failReason = reason;
      step = Step.failed;
    });
  }

  @override
  Widget build(BuildContext context) => Directionality(
        textDirection: TextDirection.rtl,
        child: DefaultTextStyle.merge(
          style: C14.cairo(fontSize: 18, height: 1.5, color: C14.ink),
          child: Scaffold(
            body: SafeArea(
              child: Column(children: [
                if (!live14) const _DemoBar(),
                Expanded(child: Padding(padding: const EdgeInsets.all(16), child: _body())),
              ]),
            ),
          ),
        ),
      );

  Widget _body() => switch (step) {
        Step.home => _home(),
        Step.sending => _scroll(_sending()),
        Step.confirmed => _scroll(_confirmed()),
        Step.failed => _scroll(_failed()),
      };

  // Fills the screen, and scrolls on a small phone or with large system text.
  Widget _scroll(Widget child) => LayoutBuilder(
        builder: (context, box) => SingleChildScrollView(
          child: ConstrainedBox(constraints: BoxConstraints(minHeight: box.maxHeight), child: IntrinsicHeight(child: child)),
        ),
      );

  Widget _top() => Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
        const Flexible(child: FittedBox(fit: BoxFit.scaleDown, child: Brand())),
        const SizedBox(width: 8),
        Flexible(child: Text('بلاغ حادث مرور', overflow: TextOverflow.ellipsis, style: C14.cairo(fontSize: 15, fontWeight: FontWeight.w600, color: C14.ink3))),
      ]);

  Widget _home() => LayoutBuilder(
        builder: (context, box) => SingleChildScrollView(
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: box.maxHeight),
            child: IntrinsicHeight(
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                _top(),
                const SizedBox(height: 12),
                Expanded(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: 280),
                    child: Semantics(
                      button: true,
                      label: 'اضغط للاتصال بالرقم 14 وإرسال موقعك',
                      child: Material(
                        color: C14.red,
                        borderRadius: BorderRadius.circular(14),
                        child: InkWell(
                          key: const Key('call'),
                          borderRadius: BorderRadius.circular(14),
                          onTap: start,
                          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                            FittedBox(child: Text('14', textDirection: TextDirection.ltr, style: C14.display(150, color: Colors.white))),
                            Text('اضغط للاتصال', style: C14.cairo(fontSize: 29, fontWeight: FontWeight.w800, color: Colors.white)),
                            Text('ويُرسل موقعك إلى العون', style: C14.cairo(fontSize: 17, color: Colors.white)),
                          ]),
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 14),
                Text('رقم هاتفك (اختياري)', style: C14.cairo(fontSize: 15, fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                TextField(controller: phone, keyboardType: TextInputType.phone, textAlign: TextAlign.center, textDirection: TextDirection.ltr, decoration: const InputDecoration(hintText: '0555 12 34 56')),
                const SizedBox(height: 12),
                Text('العون يتأكد من كل بلاغ قبل إرسال الإسعاف. البلاغ الكاذب يعطل إنقاذ غيرك.', style: C14.cairo(fontSize: 14, color: C14.ink3)),
              ]),
            ),
          ),
        ),
      );

  Widget _again(String label) => BigButton(label: label, onPressed: start);

  Widget _sending() => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _top(),
        const SizedBox(height: 24),
        Text('جارٍ إرسال موقعك', style: C14.cairo(fontSize: 34, fontWeight: FontWeight.w800, height: 1.2)),
        const SizedBox(height: 8),
        Text('أكمل المكالمة مع الرقم 14. لا تغلق التطبيق إن استطعت.', style: C14.cairo(fontSize: 18, color: C14.ink2)),
        const SizedBox(height: 16),
        const Panel(child: Column(children: [
          _Line(color: C14.green, text: 'فتح الاتصال بالرقم 14'),
          _Line(color: C14.amber, text: 'إرسال الموقع إلى العون', bold: true),
          _Line(color: C14.line, text: 'تأكيد الوصول'),
        ])),
      ]);

  Widget _confirmed() => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _top(),
        const SizedBox(height: 14),
        Panel(color: C14.greenSoft, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('وصل موقعك إلى العون', style: C14.cairo(fontSize: 30, fontWeight: FontWeight.w800, height: 1.2, color: C14.greenText)),
          Text('ابقَ على الخط مع الرقم 14 وأجب عن أسئلته.', style: C14.cairo(fontSize: 18, fontWeight: FontWeight.w600, color: C14.greenText)),
        ])),
        const SizedBox(height: 16),
        Text('في انتظار الإسعاف', style: C14.cairo(fontSize: 20, fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        const _List(['ابتعد عن مسار السيارات.', 'لا تحرك المصاب إلا إذا كان في خطر مباشر.', 'أبقِ هاتفك قريباً منك، فقد يتصل بك العون.']),
        const Spacer(),
        if (live14) BigButton(label: 'اتصل مجدداً بالرقم 14', onPressed: _call),
        if (!live14) BigButton(label: 'بلاغ جديد', outlined: true, height: 56, onPressed: () => setState(() => step = Step.home)),
      ]);

  Widget _failed() => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _top(),
        const SizedBox(height: 14),
        Panel(color: C14.amberSoft, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('لم يصل موقعك', style: C14.cairo(fontSize: 30, fontWeight: FontWeight.w800, height: 1.2, color: C14.amberText)),
          Text(failReason, style: C14.cairo(fontSize: 18, fontWeight: FontWeight.w600, color: C14.amberText)),
        ])),
        const SizedBox(height: 16),
        Text('قل له', style: C14.cairo(fontSize: 20, fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        const _List(['اسم الطريق أو البلدية.', 'اتجاه السير.', 'أقرب معلم تراه.']),
        const Spacer(),
        _again('أعد إرسال موقعي'),
      ]);
}

class _DemoBar extends StatelessWidget {
  const _DemoBar();
  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        color: C14.amberSoft,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Text('نسخة عرض: لا تتصل بالرقم 14 ولا تصل إلى الحماية المدنية. في حادث حقيقي، اتصل بالرقم 14 من تطبيق الهاتف.',
            textAlign: TextAlign.center, style: C14.cairo(fontSize: 14, fontWeight: FontWeight.w600, color: C14.amberText)),
      );
}

class _Line extends StatelessWidget {
  const _Line({required this.color, required this.text, this.bold = false});
  final Color color;
  final String text;
  final bool bold;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(children: [
          Icon(Icons.circle, size: 18, color: color),
          const SizedBox(width: 14),
          Expanded(child: Text(text, style: C14.cairo(fontSize: 18, fontWeight: bold ? FontWeight.w800 : FontWeight.w400))),
        ]),
      );
}

class _List extends StatelessWidget {
  const _List(this.items);
  final List<String> items;
  @override
  Widget build(BuildContext context) => Panel(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          for (final t in items) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(t, style: C14.cairo(fontSize: 18))),
        ]),
      );
}
