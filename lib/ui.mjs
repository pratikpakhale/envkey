import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import * as store from './store.mjs';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};

// The server hands out secret values, so it answers only this machine's own page: a loopback host name (which a
// rebinding DNS name cannot be) and no request that another site's page started.
export function isTrusted(headers) {
  const host = (headers.host ?? '').replace(/:\d+$/, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  const site = headers['sec-fetch-site'];
  const sameSite = site === undefined || site === 'same-origin' || site === 'none';
  const sameOrigin = headers.origin === undefined || headers.origin.replace(/^https?:\/\//, '') === headers.host;
  return loopback && sameSite && sameOrigin;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new store.StoreError('request too large');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new store.StoreError('request body is not JSON');
  }
}

const api = {
  'GET /api/secrets': async () => {
    const marks = await store.index();
    return { paths: [...marks.keys()], groups: Object.fromEntries(store.sameValueGroups(marks)) };
  },
  'GET /api/info': (query) => store.info(store.checkPath(query.get('path'))),
  'GET /api/value': (query) => ({ value: store.read(store.checkPath(query.get('path'))) }),
  'PUT /api/secrets': async (_, req) => {
    const { path, value } = await readJson(req);
    if (typeof value !== 'string') throw new store.StoreError('missing value');
    return { existed: store.write(store.checkPath(path), value.replace(/\r?\n$/, '')) };
  },
  'POST /api/generate': async (_, req) => {
    const { path, length } = await readJson(req);
    store.generate(store.checkPath(path), length ?? 32);
    return {};
  },
  'DELETE /api/secrets': (query) => {
    store.remove(store.checkPath(query.get('path')));
    return {};
  },
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, type, body) => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  };
  const json = (status, body) => send(status, 'application/json', JSON.stringify(body));

  if (!isTrusted(req.headers)) return json(403, { error: 'this page only answers requests from itself on this machine' });
  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    return send(200, type, readFileSync(new URL(`../ui/${file}`, import.meta.url)));
  }
  const route = api[`${req.method} ${url.pathname}`];
  if (!route) return json(404, { error: 'not found' });
  try {
    json(200, await route(url.searchParams, req));
  } catch (error) {
    if (!(error instanceof store.StoreError)) throw error;
    json(400, { error: error.message });
  }
}

// Listens on this machine only and resolves with the port in use.
export function serve(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handle(req, res).catch((error) => {
        console.error(error);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      });
    });
    server.once('error', (error) => {
      reject(error.code === 'EADDRINUSE' ? new store.StoreError(`port ${port} is in use; is 'envkey ui' already running? (or pass --port)`) : error);
    });
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}
