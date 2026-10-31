// A pretend traffic-light controller for bench tests and demos. It checks each command the way a real one must, and touches no hardware.
const http = require('node:http'), crypto = require('node:crypto');

function createBench(secret, { maxAgeMs = 30000 } = {}) {
  const commands = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const expected = crypto.createHmac('sha256', secret).update(body).digest();
      const got = Buffer.from(String(req.headers['x-signature'] || ''), 'hex');
      const reply = (code, accepted, why) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ accepted, why })); };
      if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return reply(401, false, 'bad signature');
      const c = JSON.parse(body);
      if (Math.abs(Date.now() - c.at) > maxAgeMs) return reply(400, false, 'too old');
      commands.push(c);
      console.log(new Date().toLocaleTimeString('fr-FR'), c.action, 'light', c.lightId, 'mission', c.missionId);
      reply(200, true);
    });
  });
  return { server, commands };
}

if (require.main === module) {
  const secret = process.env.SIGNAL_SECRET;
  if (!secret) { console.error('Set SIGNAL_SECRET to the same value as in .env'); process.exit(1); }
  const port = +(process.env.BENCH_PORT || 8099);
  createBench(secret).server.listen(port, '127.0.0.1', () => console.log(`Bench controller on http://127.0.0.1:${port}. No real light is connected.`));
}

module.exports = { createBench };
