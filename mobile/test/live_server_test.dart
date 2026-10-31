// Runs the app's API code against a real Track Twin server, only when TRACKTWIN_SERVER is set.
// Use a test server with SMS turned off: this creates an accident and a mission.
import 'dart:io';
import 'package:track_twin/api.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final env = Platform.environment;
  final server = env['TRACKTWIN_SERVER'];

  test('a report, then a full crew mission', () async {
    final witness = Api(server!);
    await witness.report(lat: 36.754, lon: 3.064, accuracy: 12);

    final op = Api(server);
    await op.post('/login', {'role': 'operator', 'id': 0, 'pin': env['OPERATOR_PIN']});
    final state = (await op.get('/state')) as Map<String, dynamic>;
    expect((state['pending'] as List).first['accuracy_m'], 12);
    final created = (await op.post('/incidents')) as Map<String, dynamic>;
    final id = created['id'];
    await op.post('/incidents/$id/location', {'lat': 36.736, 'lon': 3.14, 'road_label': 'RN 5'});
    await op.post('/incidents/$id/assess', {'vehicles': 2, 'victims': 3, 'bus': false, 'trapped': true, 'fire': false, 'conscious': true});
    final s = (await op.post('/incidents/$id/suggest')) as Map<String, dynamic>;
    final unitId = (s['units'] as List).first['id'] as int;
    await op.post('/incidents/$id/dispatch', {'unitId': unitId, 'hospitalId': (s['hospitals'] as List).first['id']});

    final crew = Api(server);
    expect((await crew.units()).any((u) => u['id'] == unitId), isTrue);
    await crew.loginCrew(unitId, env['CREW_PIN']!);
    var c = await crew.crewState();
    final m = c['mission'] as Map<String, dynamic>;
    expect(m['status'], 'sent');
    expect(c['incident']['assessment']['victims'], 3);
    expect(m['hospital']['name'], isNotEmpty);
    expect(m['route'], isList);
    final missionId = m['id'] as int;
    await crew.action(missionId, 'accept');
    await crew.position(missionId, 36.74, 3.13);
    await crew.action(missionId, 'arrive_scene');
    await crew.victims(missionId, 4);
    await crew.action(missionId, 'leave_scene');
    c = await crew.crewState();
    expect(c['mission']['status'], 'to_hospital');
    await crew.action(missionId, 'arrive_hospital');
    await crew.logout();
    expect(() => crew.crewState(), throwsA(isA<ApiError>().having((e) => e.status, 'status', 401)));
  }, skip: server == null ? 'TRACKTWIN_SERVER is not set' : null, timeout: const Timeout(Duration(minutes: 1)));
}
