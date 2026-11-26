import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class StoreError extends Error {}

export const HOME = process.env.ENVKEY_HOME || path.join(os.homedir(), '.envkey');
export const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const ROOT = path.join(HOME, '.local', 'share', 'gopass', 'stores', 'root');
const INDEX = path.join(HOME, 'index.json');
const KEYCHAIN = ['-s', 'envkey', '-a', 'age-passphrase'];
const DECRYPT_CONCURRENCY = 6;

export function storeExists() {
  return existsSync(path.join(HOME, '.config', 'gopass', 'config'));
}

// The store's key is locked with a passphrase that lives in the login Keychain, so no call ever prompts.
// GOPASS_AGE_PASSWORD overrides it (machines without a Keychain, tests).
function passphrase({ create = false } = {}) {
  if (process.env.GOPASS_AGE_PASSWORD) return process.env.GOPASS_AGE_PASSWORD;
  if (process.platform !== 'darwin') throw new StoreError('set GOPASS_AGE_PASSWORD (no Keychain on this platform)');
  const found = spawnSync('security', ['find-generic-password', ...KEYCHAIN, '-w'], { encoding: 'utf8' });
  if (found.status === 0) return found.stdout.trim();
  if (!create) throw new StoreError("the store's passphrase is not in the login Keychain (item 'envkey'); run 'envkey init'");
  const fresh = randomBytes(32).toString('base64url');
  const added = spawnSync('security', ['-i'], {
    input: `add-generic-password ${KEYCHAIN.join(' ')} -l "envkey store passphrase" -w ${fresh}\n`,
    encoding: 'utf8',
  });
  if (added.status !== 0) throw new StoreError(`could not save the passphrase to the Keychain: ${added.stderr.trim()}`);
  return fresh;
}

let cachedPassphrase;
function gopassEnv() {
  cachedPassphrase ??= passphrase();
  return { ...process.env, GOPASS_HOMEDIR: HOME, GOPASS_AGE_PASSWORD: cachedPassphrase, GOPASS_NO_NOTIFY: 'true' };
}

function gopass(args, { input = '', allowFail = false } = {}) {
  const result = spawnSync('gopass', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: gopassEnv() });
  if (result.error?.code === 'ENOENT') throw new StoreError('gopass is not installed (brew install gopass)');
  if (result.error) throw new StoreError(result.error.message);
  if (result.status !== 0 && !allowFail) {
    throw new StoreError(result.stderr.trim().split('\n').pop() || `gopass ${args[0]} failed`);
  }
  return result;
}

function requireStore() {
  if (!storeExists()) throw new StoreError("no store yet; run 'envkey init'");
}

export function checkPath(p) {
  if (!p) throw new StoreError('missing secret path');
  if (!PATH_RE.test(p)) throw new StoreError(`invalid path '${p}' (letters, digits, . _ - separated by /)`);
  return p;
}

const fileOf = (p) => path.join(ROOT, `${p}.age`);
const nameOf = (p) => p.split('/').pop();

export function init() {
  if (storeExists()) return false;
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  cachedPassphrase = passphrase({ create: true });
  gopass(['--yes', 'setup', '--crypto', 'age', '--storage', 'gitfs']);
  for (const [key, value] of [
    ['core.autosync', 'false'],
    ['core.notifications', 'false'],
    ['core.exportkeys', 'false'],
    ['show.fuzzysearch', 'false'],
  ]) {
    gopass(['config', key, value]);
  }
  return true;
}

// Each secret is one encrypted file, so the file tree is the list of secrets.
export function listPaths() {
  requireStore();
  return readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.age'))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).slice(0, -'.age'.length).split(path.sep).join('/'))
    .sort();
}

const showResult = (p, result) => {
  if (result.status !== 0) {
    const near = listPaths().filter((other) => nameOf(other) === nameOf(p));
    throw new StoreError(`no secret at '${p}'${near.length ? `; did you mean: ${near.join(', ')}` : ''}`);
  }
  return result.stdout.replace(/\r?\n$/, '');
};

export function read(p) {
  requireStore();
  return showResult(p, gopass(['show', '-n', checkPath(p)], { allowFail: true }));
}

function readAsync(p) {
  return new Promise((resolve, reject) => {
    const child = spawn('gopass', ['show', '-n', p], { env: gopassEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (status) => {
      try {
        resolve(showResult(p, { status, stdout }));
      } catch (error) {
        reject(error);
      }
    });
  });
}

// The index keeps a keyed fingerprint of every value, so finding equal values never decrypts the whole store.
// The key comes from the store's passphrase: without it, the fingerprints of short passwords cannot be guessed.
let indexKey;
function mark(value) {
  cachedPassphrase ??= passphrase();
  indexKey ??= createHmac('sha256', cachedPassphrase).update('envkey value index v1').digest();
  return createHmac('sha256', indexKey).update(value).digest('hex').slice(0, 16);
}

function loadIndex() {
  try {
    const data = JSON.parse(readFileSync(INDEX, 'utf8'));
    if (data.version === 1) return data.entries;
  } catch {}
  return {};
}

function saveIndex(entries) {
  const temp = `${INDEX}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
  renameSync(temp, INDEX);
}

function stamp(p) {
  const { mtimeMs, size } = statSync(fileOf(p));
  return { mtimeMs, size };
}

function remember(p, value) {
  const entries = loadIndex();
  entries[p] = { ...stamp(p), mark: mark(value) };
  saveIndex(entries);
}

// Returns path -> fingerprint for every secret, decrypting only files that changed since the last call
// (including changes made with gopass directly). onStale(count) is called before that work starts.
export async function index({ onStale } = {}) {
  const paths = listPaths();
  const known = loadIndex();
  const current = {};
  const stale = [];
  for (const p of paths) {
    const now = stamp(p);
    const entry = known[p];
    if (entry && entry.mtimeMs === now.mtimeMs && entry.size === now.size) current[p] = entry;
    else stale.push([p, now]);
  }
  if (stale.length) {
    onStale?.(stale.length);
    const queue = [...stale];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [p, now] = next;
        current[p] = { ...now, mark: mark(await readAsync(p)) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(DECRYPT_CONCURRENCY, stale.length) }, worker));
  }
  if (stale.length || paths.length !== Object.keys(known).length) saveIndex(current);
  return new Map(paths.map((p) => [p, current[p].mark]));
}

// Numbers each value held by more than one path; paths that share a number hold the same value.
export function sameValueGroups(marks) {
  const byMark = Map.groupBy(marks.keys(), (p) => marks.get(p));
  const groups = new Map();
  for (const p of marks.keys()) {
    const members = byMark.get(marks.get(p));
    if (members.length < 2 || groups.has(p)) continue;
    const number = new Set(groups.values()).size + 1;
    for (const member of members) groups.set(member, number);
  }
  return groups;
}

// Other paths that hold the same value as p, without decrypting anything that has not changed.
export async function duplicates(p, { onStale } = {}) {
  const marks = await index({ onStale });
  if (!marks.has(checkPath(p))) {
    const near = [...marks.keys()].filter((other) => nameOf(other) === nameOf(p));
    throw new StoreError(`no secret at '${p}'${near.length ? `; did you mean: ${near.join(', ')}` : ''}`);
  }
  return [...marks.keys()].filter((other) => other !== p && marks.get(other) === marks.get(p));
}

// Returns true when the path already held a value.
export function write(p, value) {
  checkPath(p);
  if (value === '') throw new StoreError(`refusing to store an empty value at '${p}'`);
  const existed = existsSync(fileOf(p));
  gopass(['insert', '-f', p], { input: value });
  remember(p, value);
  return existed;
}

export function generate(p, length = 32) {
  checkPath(p);
  if (!Number.isInteger(length) || length < 8) throw new StoreError('length must be a whole number, 8 or more');
  if (existsSync(fileOf(p))) throw new StoreError(`'${p}' already exists; remove it first to replace it`);
  write(p, randomBytes(length).toString('base64url').slice(0, length));
}

export function remove(p) {
  checkPath(p);
  if (!existsSync(fileOf(p))) throw new StoreError(`no secret at '${p}'`);
  gopass(['rm', '-f', p]);
  const entries = loadIndex();
  delete entries[p];
  saveIndex(entries);
}

// Describes a secret without its value: the first and last characters only for long single-line values.
export async function info(p, { onStale } = {}) {
  const value = read(p);
  const marks = await index({ onStale });
  const own = marks.get(p);
  const others = [...marks.keys()].filter((other) => other !== p);
  const changed = gopass(['history', p], { allowFail: true }).stdout.match(/\d{4}-\d{2}-\d{2}T[\d:]+\S*/)?.[0];
  return {
    path: p,
    length: value.length,
    fingerprint: own.slice(0, 12),
    shape: value.length >= 32 && !value.includes('\n') ? `${value.slice(0, 8)}…${value.slice(-4)}` : undefined,
    changed,
    sameValue: others.filter((other) => marks.get(other) === own),
    sameNameDifferentValue: others.filter((other) => nameOf(other) === nameOf(p) && marks.get(other) !== own),
  };
}
