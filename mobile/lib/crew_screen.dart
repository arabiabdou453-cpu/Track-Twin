// The ambulance crew: the mission, the route, and one big button for the next step.
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';
import 'api.dart';
import 'theme.dart';

const _mission = {'sent': "En attente de l'équipage", 'accepted': "En route vers l'accident", 'on_scene': 'Sur les lieux', 'to_hospital': "Vers l'hôpital", 'at_hospital': "Arrivé à l'hôpital"};
const _next = {'sent': ('accept', 'Accepter la mission'), 'accepted': ('arrive_scene', 'Arrivé sur les lieux'), 'on_scene': ('leave_scene', "Départ vers l'hôpital"), 'to_hospital': ('arrive_hospital', "Arrivé à l'hôpital")};
const _steps = [('sent', 'Mission'), ('accepted', 'Trajet'), ('on_scene', 'Sur place'), ('to_hospital', 'Hôpital')];
const _severity = {'low': 'faible', 'medium': 'moyenne', 'high': 'élevée', 'critical': 'critique'};

String minutes(num? s) {
  if (s == null) return '—';
  if (s < 60) return '${s.round()} s';
  return '${s ~/ 60}:${(s.round() % 60).toString().padLeft(2, '0')}';
}

class CrewLogin extends StatefulWidget {
  const CrewLogin({super.key, required this.api});
  final Api api;
  @override
  State<CrewLogin> createState() => _CrewLoginState();
}

class _CrewLoginState extends State<CrewLogin> {
  List<Map<String, dynamic>> units = [];
  int? unit;
  String? error;
  bool busy = false;
  final code = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    code.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final list = await widget.api.units();
      if (mounted) setState(() { units = list; unit = list.isEmpty ? null : list.first['id'] as int; error = null; });
    } catch (_) {
      if (mounted) setState(() => error = "Serveur injoignable. Vérifiez son adresse dans les réglages.");
    }
  }

  Future<void> _login() async {
    setState(() { busy = true; error = null; });
    try {
      await widget.api.loginCrew(unit!, code.text);
      if (mounted) Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => CrewScreen(api: widget.api)));
    } catch (e) {
      if (mounted) setState(() => error = e is ApiError ? e.message : 'Serveur injoignable.');
    }
    if (mounted) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('ÉQUIPAGE')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          Panel(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('CONNEXION', style: C14.display(34)),
            const SizedBox(height: 14),
            DropdownButtonFormField<int>(
              initialValue: unit,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Unité'),
              items: [for (final u in units) DropdownMenuItem(value: u['id'] as int, child: Text('${u['name']}', overflow: TextOverflow.ellipsis))],
              onChanged: (v) => setState(() => unit = v),
            ),
            const SizedBox(height: 12),
            TextField(controller: code, obscureText: true, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Code')),
            if (error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(error!, style: const TextStyle(color: C14.redText, fontWeight: FontWeight.w600))),
            const SizedBox(height: 14),
            BigButton(label: 'Se connecter', height: 56, onPressed: busy || unit == null ? null : _login),
          ])),
        ]),
      );
}

class CrewScreen extends StatefulWidget {
  const CrewScreen({super.key, required this.api});
  final Api api;
  @override
  State<CrewScreen> createState() => _CrewScreenState();
}

class _CrewScreenState extends State<CrewScreen> {
  Map<String, dynamic>? state;
  String? error;
  bool busy = false, gpsDenied = false;
  Timer? _poll;
  StreamSubscription<Position>? _gps;
  DateTime _lastSent = DateTime.fromMillisecondsSinceEpoch(0);

  @override
  void initState() {
    super.initState();
    _refresh();
    _poll = Timer.periodic(const Duration(seconds: 4), (_) => _refresh());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _gps?.cancel();
    super.dispose();
  }

  Map<String, dynamic>? get mission => state?['mission'] as Map<String, dynamic>?;

  Future<void> _refresh() async {
    try {
      final s = await widget.api.crewState();
      if (!mounted) return;
      setState(() { state = s; error = null; });
      final m = mission;
      if (m != null && m['status'] != 'sent' && m['simulated'] != 1 && m['simulated'] != true) _startGps();
    } on ApiError catch (e) {
      if (!mounted) return;
      if (e.status == 401) {
        Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => CrewLogin(api: widget.api)));
      } else {
        setState(() => error = e.message);
      }
    } catch (_) {
      if (mounted) setState(() => error = "Connexion perdue. Prévenez l'agent par radio si cela dure.");
    }
  }

  Future<void> _startGps() async {
    if (_gps != null) return;
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
      if (mounted) setState(() => gpsDenied = true);
      return;
    }
    _gps = Geolocator.getPositionStream(locationSettings: const LocationSettings(accuracy: LocationAccuracy.high)).listen((p) {
      final m = mission;
      if (m == null || DateTime.now().difference(_lastSent).inSeconds < 5) return;
      _lastSent = DateTime.now();
      widget.api.position(m['id'] as int, p.latitude, p.longitude).catchError((_) {});
    }, onError: (_) {
      if (mounted) setState(() => gpsDenied = true);
    });
  }

  Future<void> _do(String action) async {
    setState(() => busy = true);
    try {
      await widget.api.action(mission!['id'] as int, action);
      await _refresh();
    } catch (e) {
      if (mounted) setState(() => error = e is ApiError ? e.message : 'Connexion perdue. Réessayez.');
    }
    if (mounted) setState(() => busy = false);
  }

  Future<void> _logout() async {
    try {
      await widget.api.logout();
    } catch (_) {}
    if (mounted) Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => CrewLogin(api: widget.api)));
  }

  @override
  Widget build(BuildContext context) {
    final s = state, m = mission;
    return Scaffold(
      appBar: AppBar(title: const Text('ÉQUIPAGE'), actions: [TextButton(onPressed: _logout, child: const Text('Déconnexion', style: TextStyle(color: Colors.white)))]),
      body: s == null
          ? Center(child: error == null ? const CircularProgressIndicator() : Padding(padding: const EdgeInsets.all(16), child: Text(error!)))
          : SafeArea(child: Column(children: [
              Expanded(child: ListView(padding: const EdgeInsets.all(10), children: [
                if (error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Panel(color: C14.redSoft, child: Text(error!, style: const TextStyle(color: C14.redText, fontWeight: FontWeight.w600)))),
                _head(s, m),
                if (m != null) ...[
                  const SizedBox(height: 10),
                  ClipRRect(borderRadius: BorderRadius.circular(C14.radius), child: SizedBox(height: 280, child: _Map(state: s))),
                  const SizedBox(height: 10),
                  _facts(s, m),
                ],
              ])),
              if (m != null && _next[m['status']] != null)
                Container(
                  color: Colors.white,
                  padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
                  child: BigButton(
                    label: _next[m['status']]!.$2,
                    height: 72,
                    color: m['status'] == 'sent' ? C14.red : C14.green,
                    onPressed: busy ? null : () => _do(_next[m['status']]!.$1),
                  ),
                ),
            ])),
    );
  }

  Widget _head(Map<String, dynamic> s, Map<String, dynamic>? m) {
    final unit = s['unit'] as Map<String, dynamic>;
    final incident = s['incident'] as Map<String, dynamic>?;
    if (m == null) {
      return Panel(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('${unit['name']}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        const Text("Aucune mission. Elle s'affichera ici dès son envoi.", style: TextStyle(color: C14.ink3)),
      ]));
    }
    final at = _steps.indexWhere((x) => x.$1 == m['status']);
    return Panel(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('${unit['name']}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
      Text(_mission[m['status']] ?? '${m['status']}', style: const TextStyle(color: C14.ink3)),
      const SizedBox(height: 10),
      Row(children: [
        for (var k = 0; k < _steps.length; k++)
          Expanded(child: Padding(
            padding: const EdgeInsets.only(right: 4),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Container(height: 5, color: k < at ? C14.green : k == at ? C14.red : C14.line),
              const SizedBox(height: 4),
              Text(_steps[k].$2, style: TextStyle(fontSize: 12.5, fontWeight: k == at ? FontWeight.w800 : FontWeight.w500, color: k <= at ? C14.ink : C14.ink3)),
            ]),
          )),
      ]),
      const SizedBox(height: 12),
      Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (incident?['severity'] != null) Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(color: C14.red, borderRadius: BorderRadius.circular(4)),
            child: Text('Gravité : ${_severity[incident!['severity']]}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 13)),
          ),
          const SizedBox(height: 6),
          Text((incident?['road_label'] ?? 'Lieu sur la carte').toString().toUpperCase(), style: C14.display(26)),
        ])),
        const SizedBox(width: 10),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text(minutes(m['etaLeftS'] as num?), style: C14.display(60)),
          Text(m['routeSource'] == 'osrm' ? 'sans le trafic' : "à vol d'oiseau", style: const TextStyle(fontSize: 13, color: C14.ink3)),
        ]),
      ]),
      if (gpsDenied) const Padding(padding: EdgeInsets.only(top: 10), child: Text("Position indisponible : activez le GPS ou prévenez l'agent par radio.", style: TextStyle(color: C14.redText, fontWeight: FontWeight.w600))),
    ]));
  }

  Widget _facts(Map<String, dynamic> s, Map<String, dynamic> m) {
    final a = (s['incident'] as Map<String, dynamic>?)?['assessment'] as Map<String, dynamic>?;
    final hospital = m['hospital'] as Map<String, dynamic>?;
    final lights = (m['priority'] as List? ?? const []);
    String yes(dynamic v) => v == true || v == 1 ? 'Oui' : 'Non';
    return Panel(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (a != null) GridView.count(
        crossAxisCount: 3,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: 8,
        crossAxisSpacing: 8,
        childAspectRatio: 1.45,
        children: [
          _fact('Véhicules', '${a['vehicles']}'), _fact('Victimes', '${a['victims']}'), _fact('Bus', yes(a['bus'])),
          _fact('Coincées', yes(a['trapped'])), _fact('Incendie', yes(a['fire'])), _fact('Conscients', yes(a['conscious'])),
        ],
      ),
      if (hospital != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text("${hospital['name']} : ${m['ackPending'] == true ? 'en attente de confirmation' : 'alerte reçue'}", style: const TextStyle(fontWeight: FontWeight.w600))),
      if (lights.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text("Feux sur le trajet : ${lights.length} (${lights.any((p) => p['live'] == true) ? 'contrôleur réel' : "simulation, aucun feu réel n'est commandé"})", style: const TextStyle(color: C14.ink3))),
      if (m['status'] == 'on_scene') _VictimsForm(initial: a?['victims'] as int? ?? 1, onSave: (n) async {
        try {
          await widget.api.victims(m['id'] as int, n);
          await _refresh();
        } catch (e) {
          if (mounted) setState(() => error = e is ApiError ? e.message : 'Connexion perdue. Réessayez.');
        }
      }),
    ]));
  }

  Widget _fact(String k, String v) => Container(
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(color: C14.soft, borderRadius: BorderRadius.circular(8)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(k, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5, color: C14.ink3, fontWeight: FontWeight.w500)),
          Text(v, style: C14.display(24)),
        ]),
      );
}

class _VictimsForm extends StatefulWidget {
  const _VictimsForm({required this.initial, required this.onSave});
  final int initial;
  final Future<void> Function(int) onSave;
  @override
  State<_VictimsForm> createState() => _VictimsFormState();
}

class _VictimsFormState extends State<_VictimsForm> {
  late final c = TextEditingController(text: '${widget.initial}');
  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Row(children: [
          Expanded(child: TextField(controller: c, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Victimes sur place'))),
          const SizedBox(width: 8),
          SizedBox(height: 52, child: OutlinedButton(onPressed: () => widget.onSave(int.tryParse(c.text) ?? widget.initial), child: const Text('Mettre à jour'))),
        ]),
      );
}

class _Map extends StatelessWidget {
  const _Map({required this.state});
  final Map<String, dynamic> state;

  @override
  Widget build(BuildContext context) {
    final m = state['mission'] as Map<String, dynamic>;
    final incident = state['incident'] as Map<String, dynamic>?;
    final route = [for (final c in (m['route'] as List? ?? const [])) LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble())];
    final unit = m['unit'] as Map<String, dynamic>?;
    final hospital = m['hospital'] as Map<String, dynamic>?;
    LatLng? at(Map<String, dynamic>? x) => x == null || x['lat'] == null ? null : LatLng((x['lat'] as num).toDouble(), (x['lon'] as num).toDouble());
    final points = [...route, ?at(unit), ?at(incident), ?at(hospital)];
    Marker dot(LatLng p, Color color, {double size = 22, Color border = Colors.white}) => Marker(
          point: p, width: size, height: size,
          child: Container(decoration: BoxDecoration(color: color, shape: BoxShape.circle, border: Border.all(color: border, width: 3))),
        );
    return FlutterMap(
      options: points.length > 1
          ? MapOptions(initialCameraFit: CameraFit.coordinates(coordinates: points, padding: const EdgeInsets.all(28)))
          : MapOptions(initialCenter: points.isEmpty ? const LatLng(36.755, 3.06) : points.first, initialZoom: 14),
      children: [
        TileLayer(urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', userAgentPackageName: 'dz.couloir14.couloir14'),
        if (route.length > 1) PolylineLayer(polylines: [Polyline(points: route, color: C14.ink, strokeWidth: 6)]),
        MarkerLayer(markers: [
          for (final p in (m['priority'] as List? ?? const []))
            dot(LatLng((p['lat'] as num).toDouble(), (p['lon'] as num).toDouble()), p['status'] == 'active' ? C14.green : C14.amber, size: 18),
          if (at(hospital) != null) Marker(point: at(hospital)!, width: 30, height: 30, child: Container(decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle), padding: const EdgeInsets.all(4), child: const Logo(size: 22))),
          if (at(incident) != null && ['sent', 'accepted', 'on_scene'].contains(m['status'])) dot(at(incident)!, C14.red, size: 26),
          if (at(unit) != null) dot(at(unit)!, Colors.white, border: C14.ink),
        ]),
        const SimpleAttributionWidget(source: Text('OpenStreetMap')),
      ],
    );
  }
}
