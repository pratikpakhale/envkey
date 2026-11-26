#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import * as store from '../lib/store.mjs';
import { serve } from '../lib/ui.mjs';

const HELP = `envkey: a local store for secrets, so agents fetch them by name and nobody pastes them into chat.

  envkey ls [words...]            list secret paths that contain every word (names only, never values);
                                  paths that end in the same =N hold the same value
  envkey info PATH                length, fingerprint, first/last characters of long values, last change,
                                  other paths with the same value, and same-named paths that differ
  envkey same PATH                list the other paths that hold the same value as PATH
  envkey get PATH                 write the raw value to stdout, with no trailing newline
  envkey set PATH [--from-file F] store a value from F, from stdin, or from a hidden prompt in a terminal
  envkey gen PATH [--length N]    generate a random value (default 32 characters) and store it
  envkey import FILE PREFIX       store every variable of a dotenv FILE as PREFIX/NAME
  envkey rm PATH                  delete a secret
  envkey ui [--port N]            browse and edit the store in a browser (this machine only)
  envkey init                     create the store (once per machine)

Paths read scope/project-or-host/environment/NAME, for example
  work/acme/staging/DATABASE_URL    home/pi/SUDO_PASSWORD    personal/blog/prod/CMS_TOKEN

Never let a value reach the terminal or the chat. Always send 'get' somewhere:
  envkey get home/pi/SUDO_PASSWORD | sudo -S -p '' true
  envkey get personal/vercel/TOKEN | ssh box 'install -m600 /dev/stdin /srv/state/vercel.token'
  TOKEN="$(envkey get work/acme/staging/API_KEY)" && curl -H "Authorization: Bearer $TOKEN" ...
  printf 'API_KEY=%s\\n' "$(envkey get work/acme/staging/API_KEY)" >> .env.local
To check or compare a value, use 'envkey info' or the =N marks in 'envkey ls'.
`;

const DEFAULT_UI_PORT = 4680;

function announceIndexing(count) {
  if (count >= 10) process.stderr.write(`envkey: indexing ${count} changed secrets, about ${Math.ceil(count / 6)}s\n`);
}

function die(message) {
  process.stderr.write(`envkey: ${message}\n`);
  process.exit(1);
}

function readTtySecret(prompt) {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    process.stdin.setRawMode(true);
    let value = '';
    process.stdin.on('data', (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stderr.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    });
  });
}

// Registers envkey.localhost with portless and returns that URL when its proxy answers.
async function portlessUrl(port) {
  if (spawnSync('portless', ['alias', 'envkey', String(port)], { stdio: 'ignore' }).status !== 0) return undefined;
  const url = spawnSync('portless', ['get', 'envkey'], { encoding: 'utf8' }).stdout.trim();
  const answers = await fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  return answers ? url : undefined;
}

const commands = {
  init() {
    console.log(store.init() ? `created the store at ${store.HOME}` : `store already exists at ${store.HOME}`);
  },

  async ls({ positionals }) {
    const words = positionals.map((w) => w.toLowerCase());
    const marks = await store.index({ onStale: announceIndexing });
    const groups = store.sameValueGroups(marks);
    const paths = [...marks.keys()].filter((p) => words.every((w) => p.toLowerCase().includes(w)));
    if (!paths.length) {
      if (words.length) die(`nothing matches '${positionals.join(' ')}'`);
      return;
    }
    const width = Math.max(...paths.map((p) => p.length));
    console.log(paths.map((p) => (groups.has(p) ? `${p.padEnd(width)}  =${groups.get(p)}` : p)).join('\n'));
  },

  async same({ positionals }) {
    const paths = await store.duplicates(store.checkPath(positionals[0]), { onStale: announceIndexing });
    if (paths.length) console.log(paths.join('\n'));
    else process.stderr.write(`envkey: no other secret holds the value of ${positionals[0]}\n`);
  },

  async info({ positionals }) {
    const details = await store.info(store.checkPath(positionals[0]), { onStale: announceIndexing });
    const rows = [
      ['path', [details.path]],
      ['length', [details.length]],
      ['fingerprint', [details.fingerprint]],
      ['shape', details.shape ? [details.shape] : []],
      ['changed', details.changed ? [details.changed] : []],
      ['same value', details.sameValue],
      ['same name, different value', details.sameNameDifferentValue],
    ];
    const width = Math.max(...rows.filter(([, values]) => values.length).map(([label]) => label.length));
    for (const [label, values] of rows) {
      values.forEach((value, i) => console.log(`${(i ? '' : label).padEnd(width)}  ${value}`));
    }
  },

  get({ positionals }) {
    process.stdout.write(store.read(store.checkPath(positionals[0])));
  },

  async set({ positionals, values }) {
    const p = store.checkPath(positionals[0]);
    let value;
    if (values['from-file']) value = readFileSync(values['from-file'], 'utf8');
    else if (process.stdin.isTTY) value = await readTtySecret(`value for ${p}: `);
    else value = readFileSync(0, 'utf8');
    value = value.replace(/\r?\n$/, '');
    const existed = store.write(p, value);
    console.log(`${existed ? 'updated' : 'stored'} ${p} (${value.length} characters)`);
  },

  gen({ positionals, values }) {
    const p = store.checkPath(positionals[0]);
    const length = Number(values.length ?? 32);
    store.generate(p, length);
    console.log(`generated ${p} (${length} characters)`);
  },

  import({ positionals }) {
    const [file, prefix] = positionals;
    if (!file || !prefix) die('usage: envkey import FILE PREFIX');
    store.checkPath(prefix);
    const vars = Object.entries(parseEnv(readFileSync(file, 'utf8')));
    const kept = vars.filter(([name, value]) => value !== '' && store.PATH_RE.test(name));
    for (const [name, value] of kept) store.write(`${prefix}/${name}`, value);
    console.log(`imported ${kept.length} into ${prefix}/ (skipped ${vars.length - kept.length} empty)`);
  },

  rm({ positionals }) {
    const p = store.checkPath(positionals[0]);
    store.remove(p);
    console.log(`removed ${p}`);
  },

  async ui({ values }) {
    await store.index({ onStale: announceIndexing });
    const chosen = values.port ?? process.env.PORT;
    const port = await serve(Number(chosen ?? DEFAULT_UI_PORT));
    const url = (chosen === undefined && (await portlessUrl(port))) || `http://localhost:${port}`;
    console.log(`envkey ui: ${url}  (Ctrl-C to stop)`);
    if (process.stdout.isTTY) spawn('open', [url], { stdio: 'ignore' });
  },
};

const [command, ...rest] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(HELP);
} else if (!Object.hasOwn(commands, command)) {
  die(`unknown command '${command}'; see 'envkey help'`);
} else {
  const parsed = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      'from-file': { type: 'string' },
      length: { type: 'string' },
      port: { type: 'string' },
    },
  });
  try {
    await commands[command](parsed);
  } catch (error) {
    if (!(error instanceof store.StoreError)) throw error;
    die(error.message);
  }
}
