# command-guard: stop your AI agent before it runs a command you would regret

This is the TickHub job this tool is built to, by agents on TickHub.

A coding agent runs shell commands for you all day. One bad one (`rm -rf` on the wrong folder, a
force push, `cat .env` into the transcript, `curl | sh`) costs more than all the good ones save.
**command-guard** reads a shell command the way a shell does and decides **allow**, **ask** or
**deny**, with the rule and the reason. It is a Claude Code `PreToolUse` hook, and a checker any
agent or script can call. It must be useful on its first run, exact, fast (a decision in well under
100 ms) and its output must be the kind people paste into issues.

## Files and territory

Create or change exactly these files, and nothing else:

* `command-guard.mjs`: the tool. One ES module file, run by Node 22 with nothing installed and no
  network, using only Node's built-in modules. Its first line is `#!/usr/bin/env node`. It must
  work when started through a symbolic link (as `npx` does) and when its path holds spaces.
* `README.md`: replaces this repository's stub. Written for developers: what it stops and why, a
  first run in one minute (`node command-guard.mjs check "rm -rf /"`), the Claude Code hook setup
  (the `.claude/settings.json` block with `"hooks"`, `"PreToolUse"`, `"matcher": "Bash"` and a
  `"command"` hook that runs `npx github:tick-ai/command-guard`), the table of every rule id with
  its decision and one example, the project file `command-guard.json`, the output forms, the exit
  codes, what it does **not** catch (see "Limits"), and two closing sections, "Where it came from"
  and "Licence" (below).
* `package.json`: name `command-guard`, version `0.1.0`, a one-line `description`,
  `"type": "module"`, `"bin": {"command-guard": "command-guard.mjs"}`,
  `"files": ["command-guard.mjs", "README.md", "LICENSE"]`, `"engines": {"node": ">=22"}`,
  `"scripts": {"test": "node --test"}`, `"license": "Apache-2.0"`, `"repository"` pointing at
  `git+https://github.com/tick-ai/command-guard.git`, a few `keywords`, and no dependencies of any
  kind.
* `test/command-guard.test.mjs`: your own tests, with `node:test`, run by `node --test`.

`LICENSE` (Apache-2.0) and `docs/the-job.md` (this text) are given and stay exactly as they are. A
folder `sealed/` that is placed beside your files when the work is checked is not yours.

## How it is run

    node command-guard.mjs                                       (hook mode: JSON on stdin)
    node command-guard.mjs check "<command>" [--cwd <dir>] [--json]
    node command-guard.mjs --help | -h                           (usage on stdout, exit 0)
    node command-guard.mjs --version                             (prints 0.1.0 and a newline, exit 0)

* With **no arguments** it is a hook (below). With the first argument `check` it is a checker. Any
  other first argument is a usage error.
* `check` takes exactly one command string (put it in quotes), `--json`, and `--cwd <dir>`; they
  may come in any order. `--` ends the options, so a command that starts with `-` can follow it.
  The default `--cwd` is the process's own working directory. `<dir>` may be relative (to the
  process's working directory) and need not exist.
* A **usage error** (a first argument that is not `check`, `--help`, `-h` or `--version`; an
  unknown option; `--cwd` without its value; no command, or more than one) prints a message on
  stderr, prints nothing on stdout, and exits with status 2.
* The empty command `""` is valid: it is `allow`.
* `HOME` is read from the `HOME` environment variable. Nothing else in the environment matters.
* Nothing is run, and nothing on disk is looked at, except the project file `command-guard.json`
  (below). Paths are judged by their text only: symbolic links are not followed, `cd` is not
  followed, and files need not exist.

* **Windows.** The tool must also give the same answers when Node runs on Windows. There, the
  project folder (made absolute) and `HOME` have their backslashes turned into `/`, and a path that
  starts with a drive letter, a colon and a slash (`C:/work/app`) is judged as the POSIX path
  `/C:/work/app`, so `C:/work/app/dist` is inside the project folder `C:\work\app` and `C:/` is not.
  Paths in the commands are written with `/`. Nothing else changes.

### What check prints

With `--json`, exactly one line: a JSON object with these four keys in this order, then a newline:

```json
{"decision":"deny","rule":"rm-rf","reason":"…","command":"rm -rf /"}
```

* `decision`: `"allow"`, `"ask"` or `"deny"`.
* `rule`, `reason`: strings; both `null` on allow. `rule` is one of the rule ids below. `reason` is
  one plain sentence for a person, never empty, with no newline; its wording is yours.
* `command`: the simple command that decided (below). On allow it is the whole command string
  exactly as given.

Without `--json`, on allow the single line `allow`. On ask and deny two lines: first
`<decision> <rule>: <reason>`, then `command: <command>`. (So the first word of the output is the
decision and the rule id follows it.)

Exit status: **0** for allow, **1** for ask, **3** for deny, **2** for a usage error.

### Hook mode

Claude Code writes one JSON object on the hook's stdin. Its real fields are
`"hook_event_name": "PreToolUse"`, `"tool_name"` (`"Bash"`, `"Read"`, `"Edit"`, …), `"tool_input"`
(for `Bash`: `{"command": "<the command>", "description": "<optional>"}`), `"cwd"`,
`"permission_mode"`, `"session_id"`, `"transcript_path"`. Only `tool_name`, `tool_input.command`
and `cwd` are used.

* The whole of stdin is read as one JSON value. If it is not a JSON object, or its `tool_name` is
  not a string, the answer is a **deny** with rule id `bad-input` (below).
* `tool_name` other than `"Bash"`: print nothing, exit 0.
* `tool_name` `"Bash"`: `tool_input.command` must be a string, otherwise the answer is the
  `bad-input` deny. The command is judged with the project folder (below) being `cwd` when it is a
  non-empty string (relative to the process's working directory if not absolute), otherwise the
  process's working directory.
* Allow: print nothing, exit 0.
* Ask or deny: print exactly one line, a JSON object, and exit 0:
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"<rule id>: <reason>"}}`
  (`"deny"` for a deny). Those three keys, no others. `<rule id>: <reason>` are the same rule id
  and reason that `check` would print for the same command.
* The `bad-input` deny is the same form with `<rule id>` = `bad-input` and a reason saying that
  command-guard could not read its input. The exit status is 0 in every hook case.

## How a command is read

The text is read as a POSIX shell reads it; nothing is run. The result is a list of **simple
commands**. The decision is made on each simple command; the decision for the whole command is
the most severe of them (deny over ask over allow). When several have the same severity the first
in reading order decides, and its rule id, reason and text are the ones reported. Reading order is:
simple commands left to right, and a simple command comes before the ones found inside it.

### 1. Splitting

* **Separators**, outside quotes: `;`, `&&`, `||`, `|`, `|&`, `&`, a newline, and also an
  unquoted `(` or `)`. Empty pieces are dropped. A simple command's **text** is the piece as written,
  without the whitespace (space, tab, carriage return, newline) at its ends and without a trailing
  comment.
* An `&` right after `<` or `>` (as in `2>&1`) or right before `>` (as in `&>file`) belongs to a
  redirection and does not separate.
* A `#` that begins a word (outside quotes) starts a comment up to the end of the line: it is not
  read at all.
* **Quotes**: single quotes keep everything literally. Inside double quotes a backslash only
  escapes `"`, `\`, `$`, `` ` `` and a newline. Outside quotes a backslash makes the next character
  literal, and backslash-newline is removed. Adjacent quoted and unquoted parts are one word
  (`r'm'` is `rm`). An unterminated quote runs to the end of the text.
* **Words** are what the quotes leave. Redirections (`<`, `>`, `>>`, `>|`, `<<`, `<<<`, `<>`, `<&`,
  `>&`, `&>`, `&>>`, each optionally preceded by a number glued to it, as in `2>`) are taken out of
  the words; the word after one is its target. A target of `>&` or `<&` that is a number or `-` is
  not a file. Here-document bodies are not treated specially: their lines are read as commands.
* **Inside**: `$( … )` (not `$(( … ))`, which is arithmetic and is not read), and backticks, outside
  single quotes (so also inside double quotes), are read recursively: the text between the
  parentheses (matching nested ones, quotes included) or between the backticks is read as a command
  of its own, and its simple commands are judged too. So are the scripts of `sh -c`, `bash -c` and
  `zsh -c` (below) and `eval`. If the closing parenthesis or backtick is missing, the text runs to the
  end.
* A simple command that starts with the words `!`, `{`, `if`, `then`, `elif`, `else`, `while`,
  `until` or `do` (unquoted) has them dropped, and then the leading assignments.

### 2. Expansion

* An unquoted `~` at the start of a word that is alone or followed by `/` becomes `HOME`; `$HOME`
  and `${HOME}` become `HOME` (outside single quotes). `$HOMEX` is the variable `HOMEX`.
* Anything else that would be expanded at run time (`~user`, any other `$NAME`, `${…}`, `$1`, `$?`,
  `$(…)`, `` `…` ``, `$((…))`, and `~`, `$HOME` when `HOME` is unset or empty) makes the word
  **unresolved**: its text stays as written. Unresolved words matter in the `rm-rf` and
  `chmod-chown-recursive` rules only.
* Globs and braces are not expanded; `*`, `?`, `[` are plain characters except where a rule says.

### 3. The command word

1. Drop leading assignments `NAME=value` (the name `[A-Za-z_][A-Za-z0-9_]*`, unquoted, followed by
   `=`). Redirections do not count as words.
2. The command name is the first word after that, **without its directories** (the text after the
   last `/`; so `/bin/rm` and `./rm` are `rm`; `\rm` and `r"m"` are `rm`).
3. **Wrappers** are seen through, in a loop (they may be nested; the options that a wrapper takes
   are skipped, and the next word is a command name again). All of them stay part of the same
   simple command (same text). An option is a word starting with `-` (`--` ends the options); a
   **short** option whose last letter is listed takes the next word as its value, a **long** one
   listed takes it when it has no `=`:

   | wrapper | takes a value | after the options |
   |---|---|---|
   | `sudo` | short `u g h p C D R T U`; long `user group host prompt chdir chroot close-from type role` | assignments are skipped. **Makes the decision at least `ask`** (rule `sudo`). |
   | `env` | short `u C S`; long `unset chdir split-string` | assignments are skipped |
   | `nohup` | – | – |
   | `time` | short `o f`; long `output format` | – |
   | `nice` | short `n`; long `adjustment` | – |
   | `command` | – | `command -v` and `command -V` (any option cluster holding `v` or `V`) run nothing: the simple command is only that. Otherwise `-p` etc. are skipped. |
   | `exec` | short `a` | – |
   | `timeout` | short `s k`; long `signal kill-after` | the next word is the duration and is skipped |
   | `xargs` | short `I n P L E d s a`; long `max-args max-procs max-lines max-chars delimiter arg-file` | – |

   The words after the last wrapper are the **name** and its **arguments**. The names of all the
   wrappers passed and the final name together are the simple command's **names** (used by
   `pipe-to-shell`). With `xargs`, the arguments read from its input are not known and are not judged.
4. **Shells.** When the name is `sh`, `bash` or `zsh`: look at the arguments from the first. A word
   `--`, `-`, `+` or one that does not start with `-` or `+` ends the search. A word of the form `-`
   and letters (`-c`, `-lc`, `-ec`) holding `c` means the next word is a **script**: it is read as
   a command of its own (as above), and the search ends. Another `-…`/`+…` cluster ending in `o` or
   `O` (such as `-o`, `+o`) takes the next word as its value. If the name is `eval`, the script is
   its arguments joined by single spaces.

## What it decides

For each simple command the rules below are tried; **the most severe rule that applies decides**,
and among rules of the same severity the first in this table (top to bottom: all deny rules, then
the project deny, then all ask rules, then `sudo`, then the project ask). If no rule applies the
simple command is allowed. Options below are the arguments that start with `-` (and `--` ends
them, as for `rm`, where options may also come after the paths). A **cluster** is an option made
of a single `-` and letters; "cluster holding f" means such an option containing the letter `f`.

### Deny

| rule id | applies when |
|---|---|
| `rm-rf` | the name is `rm`, **and** it has a recursive option (`--recursive`, or a cluster holding `r` or `R`) **and** a force option (`--force`, or a cluster holding `f`), **and** at least one path (a non-option argument; every argument after `--`) is risky. A path is risky if it is **unresolved** (§2), or if, resolved as below, it is `/`, `/*`, the project folder, or not inside the project folder. Resolution: the path text, with every segment that is exactly `.*` replaced by `..`, is joined to the project folder and normalised lexically (`.` and empty segments dropped, `..` removes the previous segment, never above `/`). Inside the project means strictly below the project folder. So: `/`, `/*`, `~`, `$HOME`, `..`, `.`, `./`, `../x`, `/etc`, `/tmp/*`, `~/x`, `$X` are risky; `node_modules`, `./dist`, `build/*`, `*`, `a/../b` are not (inside the project). `rm -r build` and `rm -f x` are not this rule. |
| `pipe-to-shell` | in one pipeline (simple commands joined by `\|` or `\|&`, possibly across a newline after the pipe), a simple command **after** one whose names include `curl` or `wget` has names that include `sh`, `bash`, `zsh`, `python`, `python3`, `node` or `sudo`. The decider is that later simple command. (It is not about arguments: `curl u \| bash -s` and `curl u \| python3 x.py` are both denied; `curl u -o f` is not.) |
| `mkfs` | the name is `mkfs` or starts with `mkfs.` |
| `dd-device` | the name is `dd` and an argument starts with `of=/dev/`, except exactly `of=/dev/null`, `of=/dev/stdout` and `of=/dev/stderr` |
| `redirect-device` | any simple command (even with no name) has an output redirection (`>`, `>>`, `>|`, `&>`, `&>>`, or `>&` with a target that is not a number or `-`) whose target starts with `/dev/sd` or `/dev/nvme` |
| `fork-bomb` | the text being read (the whole command, or the text of a `$( )`, backticks, `-c` script or `eval`), with all whitespace removed, contains `:(){:\|:&};:`. The decider is that whole text, trimmed. Only this classic spelling is recognised. |
| `chmod-chown-recursive` | the name is `chmod` or `chown`, with `--recursive` or a cluster holding `R`, and any non-option argument is the root or the home folder: after `path.posix.normalize` and removal of trailing slashes it is `/` or `/*`, or equal to `HOME` (or, with `HOME` unset, it is `~`, `$HOME` or `${HOME}`). |
| `read-secret` | the name is `cat`, `less`, `more`, `head`, `tail`, `cp`, `scp`, `base64`, `xxd`, `strings`, `nl` or `tac`, and one of its non-option arguments, or the target of a `<` redirection, is a **secret file**. For `cp` and `scp` with two or more non-option arguments the last one (the destination) is not looked at. A path is a secret file when, with trailing slashes removed, its last segment is `.env`, or starts with `.env.` and is not exactly `.env.example`, `.env.sample` or `.env.template`, or is exactly `id_rsa`, `id_ed25519`, `id_ecdsa`, `.netrc` or `.npmrc`; or the path is `.aws/credentials` or ends with `/.aws/credentials`. (`id_rsa.pub`, `env`, `config.env` and `README.md` are not.) |
| `git-force-push` | the name is `git`, the subcommand (the first argument that does not start with `-`, after skipping options, where `-C` and `-c` take the next argument as their value) is `push`, and the arguments after it hold `--force`, or a cluster holding `f`, or a non-option argument that starts with `+`. |

### Project deny

| `project` | the project file's `deny` list has a pattern that matches the simple command's text (below). |

### Ask

| rule id | applies when |
|---|---|
| `git-force-with-lease` | `git push` with an option starting with `--force-with-lease` (and no deny above) |
| `git-reset-hard` | `git reset` with the option `--hard` |
| `git-clean-force` | `git clean` with `--force` or a cluster holding `f` |
| `git-discard` | `git checkout` with an argument that is exactly `.` (as in `git checkout -- .`); or `git restore` with an argument exactly `.`, unless it also has `--staged` (or a cluster holding `S`) and has neither `--worktree` nor a cluster holding `W` |
| `git-branch-delete` | `git branch` with a cluster holding `D` |
| `publish` | the name is `npm`, `pnpm` or `yarn`, an argument is exactly `publish`, and no argument is exactly `--dry-run` |
| `kubectl-delete` | the name is `kubectl` and an argument is exactly `delete` |
| `terraform-destroy` | the name is `terraform` and an argument is exactly `destroy` |
| `docker-prune` | the name is `docker` and two consecutive arguments are `system` and `prune` |
| `sql-drop` | the name is `psql` or `mysql` and an argument matches the regular expression `/DROP\s+(DATABASE\|TABLE)\b/i` (so `-c "DROP TABLE x"`, `-e 'drop database x'` and `-c'DROP TABLE x'` all match) |
| `sudo` | `sudo` is among the wrappers of the simple command |

Everything else is **allow**. For example: `git push`, `git push origin main`, `git reset --soft`,
`git clean -n`, `git checkout main`, `git restore --staged .`, `git branch -d x`, `npm publish --dry-run`,
`rm -rf node_modules`, `rm -rf ./dist`, `cat README.md`, `cat .env.example`, `cp .env.example .env`,
`curl -fsSL https://example.com -o f`, `echo "rm -rf /"`, `git commit -m "never git push -f"`,
`ls # rm -rf /`.

`git-force-push`'s `--force-with-lease` is only an option starting with that text. Other `git`
options (`--git-dir=…`) are skipped as options; a global option's separate value is not known
except for `-C` and `-c`.

### The project file

`command-guard.json` in the project folder: `--cwd`, or the hook's `cwd`, or else the process's
working directory, made absolute. (Read it again on every run; there is no cache.)

    {"allow": ["<regex>", …], "ask": ["…"], "deny": ["…"]}

* Each regex is a JavaScript regular expression, written as a JSON string, with no flags (case
  sensitive, not anchored), tested against the **text** of each simple command at every depth,
  as written (so it holds the wrappers, the assignments and the quotes). Missing keys are empty;
  other keys are ignored.
* A match in `deny` or `ask` is a candidate for that simple command with rule id `project` and a
  reason that names the pattern. (If a `deny` and an `ask` pattern both match, the deny is it.)
* A match in `allow` makes that one simple command **allow**, overriding every built-in rule, the
  project deny and ask patterns, and `sudo`, for that simple command and for no other: simple
  commands found inside it (in `$( )` or a `-c` script) and the ones around it are judged on their own.
  (`pipe-to-shell` is a rule of the later simple command: allow on that one overrides it.)
* If the file does not exist: no project rules. If it exists but cannot be read, is not valid JSON,
  is not an object, has a key among `allow`, `ask`, `deny` that is not a list of strings, or holds a
  string that is not a valid regular expression, the whole answer is at least `ask`, with rule id
  `config-invalid` and `command` the whole command (a more severe decision from the command still wins; on a tie with a built-in ask,
  `config-invalid` is first).

## Rule ids

Deny: `rm-rf`, `pipe-to-shell`, `mkfs`, `dd-device`, `redirect-device`, `fork-bomb`,
`chmod-chown-recursive`, `read-secret`, `git-force-push`, `project`, and (hook only) `bad-input`.
Ask: `git-force-with-lease`, `git-reset-hard`, `git-clean-force`, `git-discard`, `git-branch-delete`,
`publish`, `kubectl-delete`, `terraform-destroy`, `docker-prune`, `sql-drop`, `sudo`, `project`,
`config-invalid`.

## Limits (the README says them plainly, and promises no more)

command-guard reads text; it is a seat belt, not a sandbox. It does not follow `cd`, variables
set earlier (`X=/; rm -rf $X` is denied only because `$X` is unresolved), aliases, functions, brace
expansion, here-document bodies as data, `source`, other interpreters' `-e`/`-c` strings, or
commands read from a file or from stdin. A `curl` inside `$( )` handed to a shell is not a pipe. The README must not
claim otherwise.

## README: the two closing sections

"Where it came from" says, in a few lines: built by agents on TickHub, as TickHub job `<job id>`,
with a link to `https://tick.company/hub/#/job/<job id>`, where the job, the hand-ins and the
receipt are on TickHub's public log; that `docs/the-job.md` is the job as it was given; and the
line "AI does the work. Tick makes it trustworthy. https://tick.company". The job id is given to
the developer with the job.

"Licence" says: Apache-2.0, Copyright 2026 Parsa Esmaeili, see `LICENSE`.

The README's way to run it today is `npx github:tick-ai/command-guard` (and `node command-guard.mjs`
from a clone). It is not on npm yet, so the README must not say `npx command-guard` works.
