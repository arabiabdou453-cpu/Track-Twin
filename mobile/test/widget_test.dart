import 'dart:convert';
import 'package:track_twin/api.dart';
import 'package:track_twin/crew_screen.dart';
import 'package:track_twin/report_screen.dart';
import 'package:track_twin/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<Fix> goodFix() async => (lat: 36.75, lon: 3.06, accuracy: 12.0);

void main() {
  setUp(() {
    C14.webFonts = false;
    SharedPreferences.setMockInitialValues({});
  });

  Future<void> pump(WidgetTester t, Widget w) async {
    t.view.physicalSize = const Size(1080, 2340);
    t.view.devicePixelRatio = 3;
    addTearDown(t.view.reset);
    await t.pumpWidget(MaterialApp(home: w));
    await t.pump();
  }

  Future<void> settle(WidgetTester t) => t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100))).then((_) => t.pump());

  testWidgets('a report is sent and confirmed, without dialling in demo mode', (t) async {
    Map<String, dynamic>? sent;
    final api = Api('http://x', client: MockClient((r) async {
      sent = jsonDecode(r.body) as Map<String, dynamic>;
      expect(r.url.path, '/api/app/report');
      return http.Response('{"ok":true}', 200);
    }));
    await pump(t, ReportScreen(api: api, locate: goodFix));
    expect(live14, isFalse);
    expect(find.textContaining('نسخة عرض'), findsOneWidget);
    await t.tap(find.byKey(const Key('call')));
    await settle(t);
    expect(find.text('وصل موقعك إلى العون'), findsOneWidget);
    expect(sent!['lat'], 36.75);
    expect(sent!['accuracy'], 12);
  });

  testWidgets('a failed location shows what to tell the agent', (t) async {
    final api = Api('http://x', client: MockClient((r) async => http.Response('{}', 200)));
    await pump(t, ReportScreen(api: api, locate: () async => throw Exception('no gps')));
    await t.tap(find.byKey(const Key('call')));
    await settle(t);
    expect(find.text('لم يصل موقعك'), findsOneWidget);
    expect(find.text('أقرب معلم تراه.'), findsOneWidget);
  });

  testWidgets('a server refusal is reported, not hidden', (t) async {
    final api = Api('http://x', client: MockClient((r) async => http.Response('{"error":"Trop"}', 429)));
    await pump(t, ReportScreen(api: api, locate: goodFix));
    await t.tap(find.byKey(const Key('call')));
    await settle(t);
    expect(find.text('لم يصل موقعك'), findsOneWidget);
  });

  testWidgets('the crew sees no mission, and the login cookie is kept', (t) async {
    final seen = <String>[];
    final api = Api('http://x', client: MockClient((r) async {
      seen.add(r.headers['Cookie'] ?? '');
      if (r.url.path == '/api/login') return http.Response('{"role":"crew","id":3}', 200, headers: {'set-cookie': 'gc_session=abc; HttpOnly; Path=/'});
      return http.Response(jsonEncode({'unit': {'id': 3, 'name': 'Unit 3'}, 'mission': null, 'incident': null}), 200);
    }));
    await t.runAsync(() => api.loginCrew(3, '0000'));
    await pump(t, CrewScreen(api: api));
    await settle(t);
    expect(seen.last, 'gc_session=abc');
    expect(find.textContaining('Aucune mission'), findsOneWidget);
    await t.pumpWidget(const SizedBox());
  });

  test('times read like the website', () {
    expect(minutes(null), '—');
    expect(minutes(42), '42 s');
    expect(minutes(244), '4:04');
  });
}
