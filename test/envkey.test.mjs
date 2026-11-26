import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isTrusted } from '../lib/ui.mjs';

const CLI = fileURLToPath(new URL('../bin/envkey.mjs', import.meta.url));
let dir;

function envkey(args, input = '') {
  return spawnSync('node', [CLI, ...args], {
    input,
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ENVKEY_HOME: path.join(dir, 'home'), GOPASS_AGE_PASSWORD: 'test-passphrase' },
  });
}

function ok(args, input) {
  const result = envkey(args, input);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'envkey-test-'));
  ok(['init']);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('set then get returns the exact value with no trailing newline', () => {
  assert.match(ok(['set', 'work/app/staging/API_KEY'], 'tk_demo_abcdefghijklmnopqrstuvwxyz0123\n'), /^stored work\/app\/staging\/API_KEY \(38 characters\)/);
  assert.equal(ok(['get', 'work/app/staging/API_KEY']), 'tk_demo_abcdefghijklmnopqrstuvwxyz0123');
  assert.match(ok(['set', 'work/app/staging/API_KEY'], 'tk_demo_rotated-abcdefghijklmnopqrstu'), /^updated/);
});

test('multi-line values are kept', () => {
  const pem = '-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----';
  ok(['set', 'work/app/local/PRIVATE_KEY'], `${pem}\n`);
  assert.equal(ok(['get', 'work/app/local/PRIVATE_KEY']), pem);
});

test('set reads a file and never prints the value', () => {
  writeFileSync(path.join(dir, 'secret.txt'), 'file-delivered-value\n');
  const out = ok(['set', 'home/pi/SUDO_PASSWORD', '--from-file', 'secret.txt']);
  assert.doesNotMatch(out, /file-delivered-value/);
  assert.equal(ok(['get', 'home/pi/SUDO_PASSWORD']), 'file-delivered-value');
});

test('ls filters by every word and shows names only', () => {
  const all = ok(['ls']);
  assert.match(all, /home\/pi\/SUDO_PASSWORD/);
  assert.doesNotMatch(all, /tk_demo|file-delivered/);
  assert.equal(ok(['ls', 'staging', 'api']).trim(), 'work/app/staging/API_KEY');
  assert.equal(envkey(['ls', 'nothing-like-this']).status, 1);
});

test('info shows a fingerprint, and hides the shape of short values', () => {
  const long = ok(['info', 'work/app/staging/API_KEY']);
  assert.match(long, /^length +37$/m);
  assert.match(long, /^fingerprint +[0-9a-f]{12}$/m);
  assert.match(long, /^shape +tk_demo_…rstu$/m);
  assert.match(long, /^changed +\d{4}-/m);
  assert.doesNotMatch(long, /rotated/);
  assert.doesNotMatch(ok(['info', 'home/pi/SUDO_PASSWORD']), /shape|file-delivered/);
});

test('ls marks paths that hold the same value, and info names them', () => {
  ok(['set', 'dup/a/local/SHARED_KEY'], 'one-value-shared-by-two-paths');
  ok(['set', 'dup/b/local/SHARED_KEY'], 'one-value-shared-by-two-paths');
  ok(['set', 'dup/c/local/SHARED_KEY'], 'a-different-value');

  const lines = ok(['ls', 'dup']).trim().split('\n');
  const [a, b, c] = lines.map((line) => line.trim().split(/\s+/));
  assert.equal(a[0], 'dup/a/local/SHARED_KEY');
  assert.match(a[1], /^=\d+$/);
  assert.equal(b[1], a[1]);
  assert.deepEqual(c, ['dup/c/local/SHARED_KEY']);

  const info = ok(['info', 'dup/a/local/SHARED_KEY']);
  assert.match(info, /^same value +dup\/b\/local\/SHARED_KEY$/m);
  assert.match(info, /^same name, different value +dup\/c\/local\/SHARED_KEY$/m);
});

test('same lists the other paths with the same value, and nothing for a unique value', () => {
  assert.equal(ok(['same', 'dup/a/local/SHARED_KEY']).trim(), 'dup/b/local/SHARED_KEY');
  const unique = envkey(['same', 'dup/c/local/SHARED_KEY']);
  assert.equal(unique.status, 0);
  assert.equal(unique.stdout, '');
  assert.match(unique.stderr, /no other secret holds the value/);
  const missing = envkey(['same', 'dup/x/local/SHARED_KEY']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /did you mean: dup\/a\/local\/SHARED_KEY/);
});

test('changing a value through envkey updates the marks', () => {
  ok(['set', 'dup/b/local/SHARED_KEY'], 'a-different-value');
  const marks = Object.fromEntries(ok(['ls', 'dup']).trim().split('\n').map((line) => line.trim().split(/\s+/)));
  assert.equal(marks['dup/a/local/SHARED_KEY'], undefined);
  assert.equal(marks['dup/b/local/SHARED_KEY'], marks['dup/c/local/SHARED_KEY']);
});

test('changes made with gopass directly are picked up', () => {
  const result = spawnSync('gopass', ['insert', '-f', 'dup/a/local/SHARED_KEY'], {
    input: 'a-different-value',
    env: { ...process.env, GOPASS_HOMEDIR: path.join(dir, 'home'), GOPASS_AGE_PASSWORD: 'test-passphrase', GOPASS_NO_NOTIFY: 'true' },
  });
  assert.equal(result.status, 0, String(result.stderr));
  const groups = new Set(ok(['ls', 'dup']).trim().split('\n').map((line) => line.trim().split(/\s+/)[1]));
  assert.equal(groups.size, 1);
});

test('the index on disk holds neither values nor plain hashes of them', () => {
  const index = readFileSync(path.join(dir, 'home', 'index.json'), 'utf8');
  assert.doesNotMatch(index, /a-different-value|file-delivered-value/);
  const plain = createHash('sha256').update('a-different-value').digest('hex').slice(0, 16);
  assert.ok(!index.includes(plain));
});

test('gen stores a value of the asked length and will not overwrite', () => {
  ok(['gen', 'home/box/VNC_PASSWORD', '--length', '20']);
  assert.equal(ok(['get', 'home/box/VNC_PASSWORD']).length, 20);
  assert.equal(envkey(['gen', 'home/box/VNC_PASSWORD']).status, 1);
});

test('import stores each variable of a dotenv file and skips empty ones', () => {
  writeFileSync(path.join(dir, 'src.env'), '# comment\nA_KEY=one\nexport B_URL="two words"\nEMPTY=\n');
  assert.equal(ok(['import', 'src.env', 'work/other/local']).trim(), 'imported 2 into work/other/local/ (skipped 1 empty)');
  assert.equal(ok(['get', 'work/other/local/B_URL']), 'two words');
});

test('a missing secret fails and suggests paths with the same name', () => {
  const result = envkey(['get', 'work/app/prod/API_KEY']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /did you mean: work\/app\/staging\/API_KEY/);
});

test('rm deletes, and bad paths are rejected', () => {
  ok(['rm', 'home/box/VNC_PASSWORD']);
  assert.equal(envkey(['get', 'home/box/VNC_PASSWORD']).status, 1);
  assert.equal(envkey(['set', 'bad path'], 'x').status, 1);
  assert.equal(envkey(['set', 'a/EMPTY'], '').status, 1);
});

test('the ui only trusts requests from its own page on this machine', () => {
  assert.equal(isTrusted({ host: 'localhost:4680' }), true);
  assert.equal(isTrusted({ host: 'envkey.localhost', origin: 'https://envkey.localhost', 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(isTrusted({ host: 'evil.example:4680' }), false);
  assert.equal(isTrusted({ host: 'localhost:4680', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(isTrusted({ host: 'localhost:4680', 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(isTrusted({ host: 'localhost:4680', origin: 'http://localhost:9999' }), false);
});

test('the ui serves the page and reads, writes, generates and deletes secrets', async () => {
  const server = spawn('node', [CLI, 'ui', '--port', '0'], {
    cwd: dir,
    env: { ...process.env, ENVKEY_HOME: path.join(dir, 'home'), GOPASS_AGE_PASSWORD: 'test-passphrase' },
  });
  try {
    const base = await new Promise((resolve, reject) => {
      server.stdout.on('data', (chunk) => resolve(chunk.toString().match(/http:\/\/localhost:\d+/)[0]));
      server.on('exit', () => reject(new Error('ui exited early')));
    });
    const call = async (method, url, body) => {
      const response = await fetch(base + url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body && JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };

    assert.match(await (await fetch(base + '/')).text(), /<title>envkey<\/title>/);

    assert.equal((await call('PUT', '/api/secrets', { path: 'ui/test/TOKEN', value: 'from-the-browser' })).status, 200);
    assert.ok((await call('GET', '/api/secrets')).body.paths.includes('ui/test/TOKEN'));
    assert.equal((await call('GET', '/api/value?path=ui/test/TOKEN')).body.value, 'from-the-browser');
    assert.equal(ok(['get', 'ui/test/TOKEN']), 'from-the-browser');

    const info = (await call('GET', '/api/info?path=ui/test/TOKEN')).body;
    assert.equal(info.length, 16);
    assert.doesNotMatch(JSON.stringify(info), /from-the-browser/);

    assert.equal((await call('POST', '/api/generate', { path: 'ui/test/GENERATED' })).status, 200);
    assert.equal(ok(['get', 'ui/test/GENERATED']).length, 32);

    assert.equal((await call('DELETE', '/api/secrets?path=ui/test/TOKEN')).status, 200);
    const missing = await call('GET', '/api/value?path=ui/test/TOKEN');
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /no secret at/);

    const crossSite = await fetch(base + '/api/secrets', { headers: { origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);
  } finally {
    server.kill();
  }
});
