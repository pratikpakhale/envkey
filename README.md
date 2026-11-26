# envkey

A local secret store for coding agents. Agents look secrets up by name and use them without the value ever
showing up in the chat, and you stop pasting the same API key into every new session.

It is a thin CLI over [gopass](https://www.gopass.pw/) with the age backend. gopass does the encryption, storage
and history; envkey adds what agents need: names-only search, values that go to pipes and files instead of the
terminal, and a view of which secrets hold the same value.

Not related to [EnvKey](https://github.com/envkey/envkey), the hosted secrets manager.

## Requirements

- macOS (the store's passphrase lives in the login Keychain), or any system with `GOPASS_AGE_PASSWORD` set
- Node.js 22 or later
- gopass: `brew install gopass`

## Setup (once per machine)

```sh
git clone https://github.com/pratikpakhale/envkey.git
ln -s "$PWD/envkey/bin/envkey.mjs" ~/.local/bin/envkey
envkey init
```

`envkey init` creates the store in `~/.envkey` and a random passphrase for its key in the macOS login Keychain
(item `envkey`), so no command ever prompts.

To move the store to a new Mac, copy `~/.envkey` and the Keychain item's password.

## Use

Run `envkey help` for every command. Secret paths read `scope/project-or-host/environment/NAME`:

```
work/acme/staging/DATABASE_URL
work/acme/local/server/STRIPE_SECRET_KEY
home/pi/SUDO_PASSWORD
```

```sh
envkey import apps/server/.env work/acme/local/server   # store every variable of an env file
envkey ls staging database                              # find by words, names only
envkey same work/acme/local/server/STRIPE_SECRET_KEY    # other paths holding the same value
envkey info work/acme/staging/DATABASE_URL              # length, fingerprint, first/last characters, last change
envkey set home/box/ADMIN_PASSWORD --from-file "$file"
envkey gen home/box/VNC_PASSWORD --length 24
```

`envkey get` prints the raw value, so always send it somewhere:

```sh
TOKEN="$(envkey get work/acme/staging/API_KEY)" && curl -H "Authorization: Bearer $TOKEN" https://api.example.com
printf 'STRIPE_SECRET_KEY=%s\n' "$(envkey get work/acme/local/server/STRIPE_SECRET_KEY)" >> .env.local
envkey get home/pi/SUDO_PASSWORD | sudo -S -p '' true
```

### Same values

In `envkey ls`, paths that end in the same `=N` hold the same value, and same-named paths without a shared mark
hold different ones. `envkey info` lists both, and `envkey same` lists the duplicates of one path. This is how you
find every copy of a key you are about to rotate, or the stale copy of one that stopped working.

```
work/acme/local/server/STRIPE_SECRET_KEY    =4
work/acme/local/web/STRIPE_SECRET_KEY       =4
work/acme/staging/STRIPE_SECRET_KEY
```

These read `~/.envkey/index.json`, which keeps a keyed fingerprint of every value (useless without the store's
passphrase). Only secrets whose files changed since the last run get decrypted again, so the first run on a big
store takes about a minute and later runs are instant.

## Telling your agent

Add something like this to the agent's instructions (`~/.claude/CLAUDE.md`, `AGENTS.md`, ...):

```md
`envkey` is my local secret store (`envkey help`). Use it whenever a task needs a key, token or password.

1. Look before asking or hunting through files: `envkey ls <words>` lists names only. Paths that end in the same
   `=N` hold the same value; `envkey same PATH` lists them.
2. A secret's value must never show up in the chat or in a command's output. `envkey get PATH` prints the value,
   so never run it on its own:
   - To use the value in a command, capture it: `TOKEN="$(envkey get PATH)"`, then use `$TOKEN`.
   - To send it to another program or machine, pipe it: `envkey get PATH | ssh box 'cat > /path/file'`.
   - To put it in an env file: `printf 'NAME=%s\n' "$(envkey get PATH)" >> .env.local`.
   - To see which key it is or compare two, without the value: `envkey info PATH`.
3. When you create a password or token, keep it with `envkey gen PATH` or `envkey set`, not in a loose text file.
```

This is an instruction, not a sandbox: an agent that can run `envkey get` can read any value in the store.

## Browser UI

```sh
envkey ui
```

Opens a page to search, add, edit, copy, reveal and delete secrets, with the same-value view. It listens on this
machine only (`http://localhost:4680`, or `--port N`) and refuses requests that another site's page started.

With [portless](https://github.com/vercel-labs/portless) installed and its proxy running
(`portless proxy start --no-tls --port 1355`), the same page is at `http://envkey.localhost:1355`.

## Under the hood

The store is plain gopass. With `GOPASS_HOMEDIR=~/.envkey` and the passphrase in `GOPASS_AGE_PASSWORD`, `gopass`
itself works on it: history, syncing to a git remote, recipients for other machines.

## Tests

```sh
node --test
```

The tests create a throwaway store in a temp directory and do not touch `~/.envkey` or the Keychain.

## License

MIT
