// The witness: one big button, then a clear result. Arabic, for someone frightened on a roadside.
import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:image_picker/image_picker.dart';
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

typedef TakePhoto = Future<Uint8List?> Function();

// Small enough to reach the server on a weak network.
Future<Uint8List?> cameraPhoto() async {
  final shot = await ImagePicker().pickImage(source: ImageSource.camera, maxWidth: 1600, imageQuality: 70);
  return shot?.readAsBytes();
}

enum Step { home, sending, confirmed, failed }

class ReportScreen extends StatefulWidget {
  const ReportScreen({super.key, required this.api, this.locate = deviceFix, this.takePhoto = cameraPhoto});
  final Api api;
  final Locate locate;
  final TakePhoto takePhoto;
  @override
  State<ReportScreen> createState() => _ReportScreenState();
}

class _ReportScreenState extends State<ReportScreen> {
  static const _resendAfter = Duration(minutes: 2);
  static const _maxTries = 4;
  static const _maxPhotos = 3;
  Step step = Step.home;
  String failReason = '';
  DateTime? sentAt;
  final phone = TextEditingController();
  final note = TextEditingController();
  String? reportToken;
  int photosSent = 0;
  bool photoBusy = false, infoBusy = false, infoSent = false;
  String photoMessage = '', infoMessage = '';
  int? victims, vehicles;
  bool? trapped, fire;

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
    note.dispose();
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
        reportToken = await widget.api.report(lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, phone: phone.text.trim().isEmpty ? null : phone.text.trim());
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

  Future<void> _sendPhoto() async {
    final token = reportToken;
    if (token == null) return;
    setState(() => photoMessage = '');
    Uint8List? bytes;
    try {
      bytes = await widget.takePhoto();
    } catch (_) {
      if (mounted) setState(() => photoMessage = 'لم نتمكن من فتح الكاميرا.');
      return;
    }
    if (bytes == null || !mounted) return;
    setState(() => photoBusy = true);
    try {
      await widget.api.reportPhoto(token, bytes);
      photosSent++;
      photoMessage = 'وصلت الصورة إلى العون.';
    } catch (_) {
      photoMessage = 'لم تصل الصورة. أعد المحاولة أو أخبر العون على الخط.';
    }
    if (mounted) setState(() => photoBusy = false);
  }

  Future<void> _sendInfo() async {
    final token = reportToken;
    if (token == null) return;
    setState(() {
      infoBusy = true;
      infoMessage = '';
    });
    try {
      await widget.api.reportInfo(token, {'victims': victims, 'vehicles': vehicles, 'trapped': trapped, 'fire': fire, 'note': note.text.trim()});
      infoSent = true;
      infoMessage = 'وصلت المعلومات إلى العون. يمكنك تصحيحها وإرسالها مجدداً.';
    } catch (_) {
      infoMessage = 'لم تصل المعلومات. أعد المحاولة أو أخبر العون على الخط.';
    }
    if (mounted) setState(() => infoBusy = false);
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
        if (reportToken != null) ...[const SizedBox(height: 16), _details()],
        const Spacer(),
        const SizedBox(height: 16),
        if (live14) BigButton(label: 'اتصل مجدداً بالرقم 14', onPressed: _call),
        if (!live14) BigButton(label: 'بلاغ جديد', outlined: true, height: 56, onPressed: () => setState(() => step = Step.home)),
      ]);

  // Optional: the location has already gone, and nothing here delays it.
  Widget _details() => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('ساعد العون (اختياري)', style: C14.cairo(fontSize: 20, fontWeight: FontWeight.w800)),
        Text('لا تصوّر ولا تقترب إذا كان ذلك يعرضك للخطر.', style: C14.cairo(fontSize: 15, fontWeight: FontWeight.w600, color: C14.amberText)),
        const SizedBox(height: 8),
        Panel(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          BigButton(
            key: const Key('photo'),
            label: photoBusy ? 'جارٍ إرسال الصورة' : photosSent == 0 ? 'صوّر الحادث' : 'صورة أخرى',
            height: 56,
            color: C14.ink,
            onPressed: photoBusy || photosSent >= _maxPhotos ? null : _sendPhoto,
          ),
          const SizedBox(height: 6),
          Text(photosSent >= _maxPhotos ? 'أُرسلت $photosSent صور، وهو الحد الأقصى.' : 'أُرسل: $photosSent من $_maxPhotos', style: C14.cairo(fontSize: 14, color: C14.ink3)),
          if (photoMessage.isNotEmpty) Text(photoMessage, style: C14.cairo(fontSize: 15, fontWeight: FontWeight.w600)),
        ])),
        const SizedBox(height: 12),
        Panel(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _Count(label: 'عدد المصابين', value: victims, keyName: 'victims', onChanged: (v) => setState(() => victims = v)),
          _Count(label: 'عدد المركبات', value: vehicles, keyName: 'vehicles', onChanged: (v) => setState(() => vehicles = v)),
          _YesNo(label: 'هل يوجد عالقون داخل مركبة؟', value: trapped, onChanged: (v) => setState(() => trapped = v)),
          _YesNo(label: 'هل يوجد حريق؟', value: fire, onChanged: (v) => setState(() => fire = v)),
          const SizedBox(height: 8),
          TextField(key: const Key('note'), controller: note, maxLines: 3, maxLength: 300, decoration: const InputDecoration(hintText: 'معلومة أخرى: معلم قريب، اتجاه السير، خطر على الطريق')),
          const SizedBox(height: 4),
          BigButton(key: const Key('sendInfo'), label: infoBusy ? 'جارٍ الإرسال' : infoSent ? 'تحديث المعلومات' : 'أرسل المعلومات', height: 56, onPressed: infoBusy ? null : _sendInfo),
          if (infoMessage.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(infoMessage, style: C14.cairo(fontSize: 15, fontWeight: FontWeight.w600))),
        ])),
        const SizedBox(height: 8),
        Text('العون يتحقق من هذه المعلومات. تُستعمل لهذا الحادث فقط، وتُحذف الصور والمعلومات بعد 30 يوماً.', style: C14.cairo(fontSize: 13, color: C14.ink3)),
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

// Empty means "I don't know", which is different from zero.
class _Count extends StatelessWidget {
  const _Count({required this.label, required this.value, required this.keyName, required this.onChanged});
  final String label, keyName;
  final int? value;
  final ValueChanged<int?> onChanged;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(children: [
          Expanded(child: Text(label, style: C14.cairo(fontSize: 16, fontWeight: FontWeight.w600))),
          IconButton(tooltip: 'أقل', icon: const Icon(Icons.remove_circle_outline), onPressed: value == null ? null : () => onChanged(value == 0 ? null : value! - 1)),
          SizedBox(width: 44, child: Text(value?.toString() ?? '؟', key: Key('$keyName-value'), textAlign: TextAlign.center, style: C14.cairo(fontSize: 20, fontWeight: FontWeight.w800))),
          IconButton(key: Key('$keyName-plus'), tooltip: 'أكثر', icon: const Icon(Icons.add_circle_outline), onPressed: (value ?? 0) >= 99 ? null : () => onChanged((value ?? -1) + 1)),
        ]),
      );
}

class _YesNo extends StatelessWidget {
  const _YesNo({required this.label, required this.value, required this.onChanged});
  final String label;
  final bool? value;
  final ValueChanged<bool?> onChanged;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: C14.cairo(fontSize: 16, fontWeight: FontWeight.w600)),
          Wrap(spacing: 8, children: [
            ChoiceChip(label: const Text('نعم'), selected: value == true, onSelected: (on) => onChanged(on ? true : null)),
            ChoiceChip(label: const Text('لا'), selected: value == false, onSelected: (on) => onChanged(on ? false : null)),
          ]),
        ]),
      );
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
