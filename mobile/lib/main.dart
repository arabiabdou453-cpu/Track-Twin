import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api.dart';
import 'crew_screen.dart';
import 'report_screen.dart';
import 'theme.dart';

// Set with --dart-define=SERVER=https://... when building for a demo.
const defaultServer = String.fromEnvironment('SERVER', defaultValue: 'http://10.0.2.2:8080');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  runApp(TrackTwinApp(api: Api(prefs.getString('server') ?? defaultServer)));
}

class TrackTwinApp extends StatelessWidget {
  const TrackTwinApp({super.key, required this.api});
  final Api api;
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Track Twin',
        debugShowCheckedModeBanner: false,
        theme: C14.theme(),
        home: HomeScreen(api: api),
      );
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, required this.api});
  final Api api;

  Future<void> _settings(BuildContext context) async {
    final c = TextEditingController(text: api.baseUrl);
    final value = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Adresse du serveur'),
        content: TextField(controller: c, keyboardType: TextInputType.url, decoration: const InputDecoration(hintText: 'https://...')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Annuler')),
          FilledButton(onPressed: () => Navigator.pop(context, c.text.trim()), child: const Text('Enregistrer')),
        ],
      ),
    );
    if (value == null || value.isEmpty) return;
    api.baseUrl = value;
    (await SharedPreferences.getInstance()).setString('server', value);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: Colors.white,
        body: SafeArea(
          child: Column(children: [
            const SizedBox(height: 14, width: double.infinity, child: CustomPaint(painter: _Chevrons())),
            Expanded(child: ListView(padding: const EdgeInsets.all(20), children: [
              Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                const Brand(),
                IconButton(tooltip: 'Réglages', icon: const Icon(Icons.settings_outlined), onPressed: () => _settings(context)),
              ]),
              const SizedBox(height: 24),
              Text('UN ACCIDENT.', style: C14.display(58)),
              Text('UN DOSSIER.', style: C14.display(58, color: C14.red)),
              Text('QUATRE ÉQUIPES.', style: C14.display(58)),
              const SizedBox(height: 16),
              const Text("Le témoin, l'agent du 14, l'équipage et l'hôpital voient la même information, au même moment.", style: TextStyle(fontSize: 18, height: 1.4)),
              const SizedBox(height: 28),
              BigButton(label: 'بلاغ حادث مرور', onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ReportScreen(api: api)))),
              const SizedBox(height: 10),
              BigButton(label: 'Équipage', color: C14.ink, onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => CrewLogin(api: api)))),
              const SizedBox(height: 18),
              const Text('Prototype étudiant, SolveX 3.0. Jamais testé sur une intervention réelle.', style: TextStyle(fontSize: 14, color: C14.ink3)),
            ])),
          ]),
        ),
      );
}

class _Chevrons extends CustomPainter {
  const _Chevrons();
  @override
  void paint(Canvas canvas, Size size) {
    final red = Paint()..color = C14.red;
    for (var x = -size.height; x < size.width; x += 52) {
      canvas.drawPath(Path()
        ..moveTo(x + size.height, 0)
        ..lineTo(x + size.height + 26, 0)
        ..lineTo(x + 26, size.height)
        ..lineTo(x, size.height)
        ..close(), red);
    }
  }

  @override
  bool shouldRepaint(_Chevrons old) => false;
}
