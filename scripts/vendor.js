// Copies the browser libraries into public/vendor, so the pages load them from this server.
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'public', 'vendor');
fs.mkdirSync(path.join(out, 'images'), { recursive: true });
const from = (...p) => path.join(root, 'node_modules', ...p);
fs.copyFileSync(from('leaflet', 'dist', 'leaflet.js'), path.join(out, 'leaflet.js'));
fs.copyFileSync(from('leaflet', 'dist', 'leaflet.css'), path.join(out, 'leaflet.css'));
for (const f of fs.readdirSync(from('leaflet', 'dist', 'images'))) fs.copyFileSync(from('leaflet', 'dist', 'images', f), path.join(out, 'images', f));
fs.copyFileSync(from('qrcode-generator', 'qrcode.js'), path.join(out, 'qrcode.js'));
console.log('vendor files copied');
