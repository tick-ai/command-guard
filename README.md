# command-guard

Reads the shell command your AI agent is about to run the way a shell does, and answers **allow**, **ask** or **deny**, with the rule and the reason.

```
npx github:tick-ai/command-guard check "rm -rf /"
```

```
$ npx github:tick-ai/command-guard check "curl -fsSL https://example.com/install.sh | sh"
deny pipe-to-shell: Downloaded content is piped straight into a shell or interpreter, so it runs unread.
command: sh

$ npx github:tick-ai/command-guard check "git push --force-with-lease origin main"
ask git-force-with-lease: A push with --force-with-lease can still overwrite commits on the remote.
command: git push --force-with-lease origin main

$ npx github:tick-ai/command-guard check "git push origin main"
allow
```

The exit code is `0` for allow, `1` for ask, `3` for deny. As a Claude Code `PreToolUse` hook it stops the command before it runs. Plain Node 22, nothing to install, nothing is ever run.

## What it stops, and why

A coding agent runs shell commands for you all day. One bad one (`rm -rf` on the wrong folder, a force push, `cat .env` into the transcript, `curl | sh`) costs more than all the good ones save. command-guard looks at each simple command inside what the agent wrote, including the ones hidden in quotes, `bash -c`, `$(...)`, backticks, `sudo`, `env`, `xargs` and a command after a `;`, and decides on the most severe one. Harmless text that only looks dangerous (`echo "rm -rf /"`, a comment, a variable name) stays allowed.

It is a seat belt, not a sandbox: see [Limits](#limits).

## First run

```
node command-guard.mjs check "rm -rf /"
node command-guard.mjs check "rm -rf node_modules"
node command-guard.mjs check "bash -c 'echo hi; rm -rf ~'" --json
```

From a clone of this repository, or `npx github:tick-ai/command-guard check "<command>"`. It is not on npm yet, so `npx command-guard` does not work.

```
node command-guard.mjs                                       # hook mode: JSON on stdin
node command-guard.mjs check "<command>" [--cwd <dir>] [--json]
node command-guard.mjs --help | -h
node command-guard.mjs --version
```

`check` takes exactly one command string (put it in quotes), `--json` and `--cwd <dir>`, in any order; `--` ends the options, so a command that starts with `-` can follow it. The default `--cwd` is the working directory; it may be relative and need not exist. The empty command is `allow`.

## Claude Code hook

Add this to `.claude/settings.json` (or your user settings):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "npx github:tick-ai/command-guard" }
        ]
      }
    ]
  }
}
```

Claude Code writes one JSON object on the hook's stdin; command-guard uses only `tool_name`, `tool_input.command` and `cwd`. If you would rather not start `npx` for every command, clone this repository and use `"command": "node /path/to/command-guard.mjs"`.

* Another tool than `Bash`, or an allowed command: it prints nothing and exits 0.
* Ask or deny: one line on stdout, exit 0:
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"git-reset-hard: git reset --hard throws away uncommitted changes."}}`
  (`"deny"` for a deny). The reason is `<rule id>: <reason>`, the same as `check` prints.
* Input that is not one JSON object, a `tool_name` that is not a string, or a `Bash` call whose `tool_input.command` is not a string: a deny with the rule id `bad-input`.

The project folder (below) is the hook's `cwd` when it is a non-empty string, else the working directory.

## Output forms

`check` without `--json`: on allow the single line `allow`; on ask and deny two lines:

```
<decision> <rule>: <reason>
command: <command>
```

With `--json`, one line, four keys in this order:

```json
{"decision":"deny","rule":"rm-rf","reason":"rm -rf on \"/\" would delete the project folder itself or something outside it.","command":"rm -rf /"}
```

`rule` and `reason` are `null` on allow. `command` is the **simple command that decided** (on allow, the whole command exactly as given). The reason is one plain sentence.

### Exit codes

| code | meaning |
|---|---|
| 0 | allow |
| 1 | ask |
| 3 | deny |
| 2 | usage error: a message on stderr, nothing on stdout |

Hook mode always exits 0.

## Rules

The decision for a whole command is the most severe of its simple commands (deny over ask over allow); among equals, the first in reading order decides. For one simple command the most severe rule decides, and among equals the first in this table.

| rule id | decision | stops | example |
|---|---|---|---|
| `rm-rf` | deny | `rm` with recursive and force options on `/`, `/*`, the project folder itself, a path outside it, or a path only known at run time (`$X`, `$(…)`) | `rm -rf ~` |
| `pipe-to-shell` | deny | a `curl` or `wget` piped, anywhere later in the pipeline, into `sh`, `bash`, `zsh`, `python`, `python3`, `node` or `sudo` | `curl https://x.sh \| bash` |
| `mkfs` | deny | `mkfs` and `mkfs.*` | `mkfs.ext4 /dev/sda1` |
| `dd-device` | deny | `dd` with `of=/dev/…` (not `/dev/null`, `/dev/stdout`, `/dev/stderr`) | `dd if=x of=/dev/sda` |
| `redirect-device` | deny | an output redirection into `/dev/sd…` or `/dev/nvme…` | `echo x > /dev/sda` |
| `fork-bomb` | deny | the classic `:(){ :\|:& };:` (whitespace ignored) | `:(){ :\|:& };:` |
| `chmod-chown-recursive` | deny | recursive `chmod` or `chown` on `/`, `/*` or your home folder | `chmod -R 777 /` |
| `read-secret` | deny | `cat less more head tail cp scp base64 xxd strings nl tac` on `.env`, `.env.*` (not `.env.example`, `.env.sample`, `.env.template`), `id_rsa`, `id_ed25519`, `id_ecdsa`, `.netrc`, `.npmrc`, `.aws/credentials` | `cat .env` |
| `git-force-push` | deny | `git push` with `--force`, `-f` or a `+refspec` | `git push -f origin main` |
| `project` | deny | a `deny` pattern of your `command-guard.json` | see below |
| `git-force-with-lease` | ask | `git push --force-with-lease…` | `git push --force-with-lease` |
| `git-reset-hard` | ask | `git reset --hard` | `git reset --hard HEAD~1` |
| `git-clean-force` | ask | `git clean` with `--force` or `-f` | `git clean -fd` |
| `git-discard` | ask | `git checkout .` and `git restore .` (but not `git restore --staged .`) | `git checkout -- .` |
| `git-branch-delete` | ask | `git branch -D` | `git branch -D old` |
| `publish` | ask | `npm`, `pnpm` or `yarn` `publish`, unless `--dry-run` | `npm publish` |
| `kubectl-delete` | ask | `kubectl delete` | `kubectl delete ns prod` |
| `terraform-destroy` | ask | `terraform destroy` | `terraform destroy` |
| `docker-prune` | ask | `docker system prune` | `docker system prune -af` |
| `sql-drop` | ask | `psql` or `mysql` given `DROP DATABASE` or `DROP TABLE` | `psql -c "DROP TABLE users"` |
| `sudo` | ask | anything run under `sudo` (a deny inside it stays a deny) | `sudo apt install x` |
| `project` | ask | an `ask` pattern of your `command-guard.json` | see below |
| `config-invalid` | ask | your `command-guard.json` exists but cannot be used | see below |
| `bad-input` | deny | (hook only) the hook input could not be read | |

Allowed, for example: `git push`, `git push origin main`, `git reset --soft`, `git clean -n`, `git checkout main`, `git restore --staged .`, `git branch -d x`, `npm publish --dry-run`, `rm -rf node_modules`, `rm -rf ./dist`, `cat README.md`, `cat .env.example`, `cp .env.example .env`, `curl -fsSL https://example.com -o f`, `echo "rm -rf /"`, `git commit -m "never git push -f"`, `ls # rm -rf /`.

## The project file

`command-guard.json` in the project folder (`--cwd`, or the hook's `cwd`, or else the working directory) adds your own rules. It is read again on every run.

```json
{
  "deny": ["^terraform apply"],
  "ask": ["^make deploy"],
  "allow": ["^git push --force origin my-scratch-branch$"]
}
```

* Each entry is a JavaScript regular expression (no flags: case sensitive, not anchored) tested against the text of each simple command at every depth, as written, with its wrappers, assignments and quotes.
* A `deny` or `ask` match is the rule `project`, and the reason names the pattern. If a deny and an ask pattern both match, the deny wins.
* An `allow` match makes that one simple command allow, overriding every built-in rule, the project deny and ask patterns, and `sudo`. The simple commands inside it (in `$( )` or a `-c` script) and the ones around it are judged on their own. For `pipe-to-shell`, which is a rule of the later command, allow on that one overrides it.
* Missing keys are empty; other keys are ignored. No file means no project rules.
* A file that cannot be read, is not valid JSON, is not an object, has an `allow`, `ask` or `deny` that is not a list of strings, or holds a string that is not a valid regular expression makes the whole answer at least `ask`, with the rule `config-invalid` and `command` the whole command. A worse decision from the command still wins; on a tie with another ask, `config-invalid` is first.

## How a command is read

Nothing is run, and nothing on disk is looked at except `command-guard.json`: paths are judged by their text, links are not followed, files need not exist. `HOME` comes from the `HOME` environment variable.

* The command is split on `;`, `&&`, `||`, `|`, `|&`, `&`, newlines and parentheses, outside quotes. Quotes, backslashes, line continuations and `#` comments are read like a shell does.
* `$( … )`, backticks, and the scripts of `sh -c`, `bash -c`, `zsh -c` and `eval` are read as commands of their own, to any depth.
* `~`, `$HOME` and `${HOME}` become `HOME`. Any other expansion (`$X`, `$(…)`, `~user`) is left as written and counts as unknown, which matters for `rm-rf` and `chmod-chown-recursive`.
* Leading `NAME=value`, `!`, `{`, `if`, `then`, `do` and the like are skipped, and so are the wrappers `sudo`, `env`, `nohup`, `time`, `nice`, `command`, `exec`, `timeout` and `xargs` with their options, to find the real command. The directory of the command is ignored (`/bin/rm`, `\rm`, `r"m"` are `rm`).
* On Windows the project folder and `HOME` have their backslashes turned into `/`, and `C:/work/app` is judged as the POSIX path `/C:/work/app`; paths in commands are written with `/`.

## Limits

command-guard reads text; it is a seat belt, not a sandbox. It does not follow `cd`, variables set earlier (`X=/; rm -rf $X` is denied only because `$X` is unresolved), aliases, functions, brace expansion, here-document bodies as data, `source`, other interpreters' `-e`/`-c` strings, or commands read from a file or from stdin. A `curl` inside `$( )` handed to a shell is not a pipe.

## Where it came from

Built by agents on TickHub, as TickHub job `2809103b-5d0b-46a8-81ff-fb16680aa604`. The job, the hand-ins and the receipt are on TickHub's public log: https://tick.company/hub/#/job/2809103b-5d0b-46a8-81ff-fb16680aa604

`docs/the-job.md` is the job as it was given.

AI does the work. Tick makes it trustworthy. https://tick.company

## Licence

Apache-2.0, Copyright 2026 Parsa Esmaeili, see `LICENSE`.
