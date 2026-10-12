#!/usr/bin/env node
// The one origin: everything goes to Forgejo except the editor's path prefix (and its websocket),
// which goes to the editor service. This is what a location block in nginx or a handle_path in
// Caddy does in a real installation (see the README); it is a program here so the prototype
// starts without installing anything.
//
//   proxy.js --port <n> --forgejo http://127.0.0.1:<n> --live http://127.0.0.1:<n> [--prefix /live]
//
// The Host header is passed on unchanged, so Forgejo sees the public address (its ROOT_URL).
// The service's operator endpoints (status, hook pokes) are not reachable through here.
import http from 'node:http';
import net from 'node:net';
import winston from 'winston';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : process.argv[i + 1]; };
const port = Number(arg('port'));
const forgejo = new URL(arg('forgejo'));
const live = new URL(arg('live'));
const prefix = arg('prefix', '/live');
if (!port || !forgejo.port || !live.port) { process.stderr.write('proxy.js --port <n> --forgejo <url> --live <url> [--prefix /live]\n'); process.exit(2); }

const log = winston.createLogger({
  level: process.env.PROXY_LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.printf(({ timestamp, level, message }) => `${timestamp} proxy ${level}: ${message}`)),
  transports: [new winston.transports.Console({ stderrLevels: ['error', 'warn', 'info', 'debug'] })],
});

const isLive = (path) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
const internal = (path) => path.startsWith(`${prefix}/internal/`) || path.startsWith(`${prefix}/api/status`) || path.startsWith(`${prefix}/webhook/`);
const target = (path) => (isLive(path) ? live : forgejo);
const forwarded = (req) => ({ ...req.headers, 'x-forwarded-for': req.socket.remoteAddress, 'x-forwarded-proto': 'http' });

const server = http.createServer((req, res) => {
  if (internal(req.url)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found\n'); return; }
  const to = target(req.url);
  const up = http.request({ host: to.hostname, port: to.port, method: req.method, path: req.url, headers: forwarded(req) }, (r) => {
    res.writeHead(r.statusCode, r.statusMessage, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    log.warn(`${req.method} ${req.url} -> ${to.host}: ${e.message}`);
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${to === live ? 'The live editor service' : 'Forgejo'} is not reachable right now.\n`);
  });
  req.pipe(up);
});

// websocket (and any other upgrade): the request head is replayed to the upstream, then bytes flow both ways
server.on('upgrade', (req, socket, head) => {
  if (internal(req.url)) { socket.destroy(); return; }
  const to = target(req.url);
  const up = net.connect(Number(to.port), to.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const end = () => { up.destroy(); socket.destroy(); };
  up.on('error', end);
  socket.on('error', end);
  up.on('close', end);
  socket.on('close', end);
});

server.listen(port, '127.0.0.1', () => log.info(`http://127.0.0.1:${port}/ -> Forgejo ${forgejo.origin}, ${prefix}/ -> editor service ${live.origin}`));

function stop(signal) {
  log.info(`${signal}: stopping`);
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
