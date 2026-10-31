// Talks to the same Track Twin server as the website.
import 'dart:convert';
import 'package:http/http.dart' as http;

class ApiError implements Exception {
  ApiError(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => message;
}

class Api {
  Api(this.baseUrl, {http.Client? client}) : _client = client ?? http.Client();
  String baseUrl;
  final http.Client _client;
  String? _cookie;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'Cookie': ?_cookie,
      };
  Uri _uri(String path) => Uri.parse('${baseUrl.replaceAll(RegExp(r'/+$'), '')}/api$path');

  Future<dynamic> _read(http.Response r) async {
    dynamic data;
    try {
      data = jsonDecode(utf8.decode(r.bodyBytes));
    } catch (_) {
      data = null;
    }
    if (r.statusCode >= 400) {
      throw ApiError(r.statusCode, data is Map && data['error'] != null ? '${data['error']}' : 'La demande a échoué');
    }
    return data;
  }

  Future<dynamic> get(String path) async =>
      _read(await _client.get(_uri(path), headers: _headers).timeout(const Duration(seconds: 15)));

  Future<dynamic> post(String path, [Map<String, dynamic> body = const {}]) async {
    final r = await _client.post(_uri(path), headers: _headers, body: jsonEncode(body)).timeout(const Duration(seconds: 15));
    final cookie = r.headers['set-cookie'];
    if (cookie != null) _cookie = cookie.split(';').first;
    return _read(r);
  }

  Future<void> report({required double lat, required double lon, required double accuracy, String? phone}) =>
      post('/app/report', {'lat': lat, 'lon': lon, 'accuracy': accuracy.round(), 'phone': phone});

  Future<List<Map<String, dynamic>>> units() async =>
      ((await get('/login-options'))['units'] as List).cast<Map<String, dynamic>>();

  Future<void> loginCrew(int unitId, String code) => post('/login', {'role': 'crew', 'id': unitId, 'pin': code});

  Future<void> logout() async {
    await post('/logout');
    _cookie = null;
  }

  Future<Map<String, dynamic>> crewState() async => (await get('/state')) as Map<String, dynamic>;
  Future<void> action(int missionId, String name) => post('/missions/$missionId/action', {'action': name});
  Future<void> position(int missionId, double lat, double lon) => post('/missions/$missionId/position', {'lat': lat, 'lon': lon});
  Future<void> victims(int missionId, int count) => post('/missions/$missionId/victims', {'victims': count});
}
