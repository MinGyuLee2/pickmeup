// Temporary compatibility listener for existing clients during the domain migration.
// There is no database connection or message dispatcher in this process.
import http from 'node:http';
import https from 'node:https';

const current = 'https://pickmeup.calkok.uk';
const legacy = 'https://enforced-spookily-unweave.ngrok-free.dev';
const sockets = new Set();
const server = http.createServer((request, response) => {
  if (!request.url?.startsWith('/') || request.url.length > 8192) {
    response.writeHead(400);response.end();return;
  }
  const origin = request.headers.origin;
  if (origin && ![current, legacy].includes(origin)) {
    response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ code: 'ORIGIN_DENIED', message: '허용되지 않은 요청입니다.' }));return;
  }
  const headers = { ...request.headers, host: new URL(current).host };
  for (const name of ['connection', 'proxy-connection', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']) delete headers[name];
  // Validate the old service origin before translating its same-origin browser requests.
  if (origin === legacy) headers.origin = current;
  const upstream = https.request(current + '/api' + request.url, { method: request.method, headers }, result => {
    response.writeHead(result.statusCode ?? 502, result.headers);result.pipe(response);
  });
  upstream.setTimeout(30_000, () => upstream.destroy());
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ code: 'UPSTREAM_UNAVAILABLE', message: '서버 연결을 확인해 주세요.' }));
  });
  request.pipe(upstream);response.on('close', () => upstream.destroy());
});
server.on('connection', socket => { sockets.add(socket);socket.on('close', () => sockets.delete(socket)); });
server.listen(4310, '127.0.0.1', () => console.log('Legacy API compatibility listener ready; canonical HTTPS upstream; no local DB writes or message dispatch.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close();for (const socket of sockets) socket.destroy();
});
