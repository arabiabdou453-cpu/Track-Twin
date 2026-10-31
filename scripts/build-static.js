// Builds the public showcase for a static host such as Vercel: the website and the simulation.
// The live platform needs the Node server and its database, so its links lead to a page that says how it is shown.
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..'), pub = path.join(root, 'public'), out = path.join(root, 'track-twin');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'css'), { recursive: true });

const index = fs.readFileSync(path.join(pub, 'index.html'), 'utf8').replace(/href="\/(login|app)"/g, 'href="/demo"');
fs.writeFileSync(path.join(out, 'index.html'), index);
const platform = /href="\/(login|app|dispatch|metrics|unit|er)"/g;
fs.writeFileSync(path.join(out, 'twin.html'), fs.readFileSync(path.join(pub, 'twin.html'), 'utf8').replace(platform, 'href="/demo"'));
for (const f of ['mark.png', 'css/app.css']) fs.copyFileSync(path.join(pub, f), path.join(out, f));

fs.writeFileSync(path.join(out, 'demo.html'), `<!doctype html>
<html lang="fr" dir="ltr">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Démonstration · Track Twin</title>
<link rel="icon" href="/mark.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;800&family=Barlow:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/css/app.css">
<style>html, body { height: auto; } a.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 50px; padding: 0 22px; background: var(--red); color: #fff; border-radius: 8px; font-weight: 700; text-decoration: none; } a.btn.line { background: none; color: var(--ink); border: 1px solid var(--ink); }</style>
</head>
<body>
<main class="login card" style="width:min(560px, 100% - 32px)">
  <a class="brand" href="/" style="text-decoration:none"><img class="mark" src="/mark.png" alt="" width="30" height="30">Track Twin</a>
  <h1>La plateforme se montre en direct</h1>
  <p>Cette page publique présente le projet et la simulation. Les écrans de l'agent, de l'équipage, de l'hôpital et du témoin fonctionnent avec notre serveur de démonstration, lancé pendant la présentation.</p>
  <p class="muted">Prototype étudiant, hackathon SolveX 3.0. Jamais testé sur une intervention réelle.</p>
  <div class="row"><a class="btn" href="/twin">Voir la simulation</a><a class="btn line" href="/">Retour au site</a></div>
</main>
</body>
</html>
`);
fs.writeFileSync(path.join(out, 'vercel.json'), JSON.stringify({ cleanUrls: true }, null, 2) + '\n');
console.log('static site written to track-twin/');
