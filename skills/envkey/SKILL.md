---
name: envkey
description: "Get, use, store or compare secrets (API keys, tokens, passwords, connection strings, env variable values) through the local envkey store. Use it whenever a task needs a credential: calling an API, filling a .env file, logging in to a machine, before asking the user for one or searching .env files for it, and whenever you create a password or token."
---

# envkey

`envkey` is the local secret store. Every secret has a path, `scope/project-or-host/environment/NAME`, for example
`work/acme/staging/DATABASE_URL` or `home/pi/SUDO_PASSWORD`. Run `envkey help` for every command.

## Find it first

Look in the store before asking the user or hunting through files:

```sh
envkey ls staging database        # paths containing every word; names only, never values
```

Paths that end in the same `=N` hold the same value. Same-named paths without a shared `=N` hold different
values, so check which one the task needs.

```sh
envkey same PATH                  # the other paths that hold the same value as PATH
envkey info PATH                  # length, fingerprint, first/last characters, last change, same-value paths,
                                  # and same-named paths with a different value
```

## Use it without showing it

A secret's value must never show up in the chat or in a command's output. `envkey get PATH` prints the value, so
never run it on its own. Use one of these:

- To use the value in a command, capture it: `TOKEN="$(envkey get PATH)"`, then use `$TOKEN`.
- To send it to another program or machine, pipe it: `envkey get PATH | ssh box 'cat > /path/file'`, or
  `envkey get PATH | sudo -S -p '' true`.
- To put it in an env file: `printf 'NAME=%s\n' "$(envkey get PATH)" >> .env.local`. Check first that the
  file does not already set `NAME`.
- To see which key it is, or whether two match, without the value: `envkey info PATH` or `envkey same PATH`.

Do not echo a captured variable, and do not run commands that print it back (verbose curl, `env`, `set -x`).

## Store what you create

When you create a password or token, keep it in the store, not in a loose text file:

```sh
envkey gen home/box/VNC_PASSWORD --length 24      # generate and store
envkey set PATH --from-file "$file"               # store a value from a file or stdin; prints only the length
envkey import apps/server/.env work/acme/local/server   # store every variable of an env file
```

## Production

Paths under `*/prod/*` are production credentials. Use them only when the user asked for production, and only
for reading.
