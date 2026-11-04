#!/usr/bin/env node
// command-guard: stop your AI agent before it runs a command you would regret.
// Reads a shell command the way a shell does (nothing is run) and decides allow, ask or deny,
// with the rule and the reason. A Claude Code PreToolUse hook, and a checker for any script.
// Plain Node 22, built-in modules only.

import { readFileSync } from 'node:fs';
import { resolve, join, posix } from 'node:path';

const VERSION = '0.1.0';
const IS_WIN = process.platform === 'win32';
const MAX_DEPTH = 64;

const USAGE = `command-guard ${VERSION}: stop your AI agent before it runs a command you would regret.

Usage:
  command-guard check "<command>" [--cwd <dir>] [--json]
  command-guard                        (hook mode: one PreToolUse JSON object on stdin)
  command-guard --help | -h
  command-guard --version

check prints allow, or "<decision> <rule>: <reason>" and "command: <command>" (one JSON object with --json).
Exit status: 0 allow, 1 ask, 3 deny, 2 usage error.
`;

// ---------------------------------------------------------------- paths

function toPosixPath(p) {
  if (!IS_WIN) return p;
  let q = p.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(q)) q = '/' + q;
  return q;
}

// A path written in a command: on Windows "C:/x" is judged as the POSIX path "/C:/x".
function cmdPath(p) {
  return IS_WIN && /^[A-Za-z]:\//.test(p) ? '/' + p : p;
}

// Lexical normalisation of an absolute POSIX path: "." and empty segments dropped, ".." removes the
// previous segment and never goes above "/".
function lexNorm(p) {
  const stack = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return '/' + stack.join('/');
}

function baseName(t) {
  return t.slice(t.lastIndexOf('/') + 1);
}

// ---------------------------------------------------------------- reading a command

const WS = /[ \t\r\n]/;
const KEYWORDS = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'while', 'until', 'do']);

// Index of the ")" that closes a "(" whose content starts at `from` (or the end of the text).
function findParenEnd(s, from) {
  const n = s.length;
  let depth = 1;
  let j = from;
  while (j < n) {
    const ch = s[j];
    if (ch === '\\') j += 2;
    else if (ch === "'") {
      const k = s.indexOf("'", j + 1);
      if (k < 0) return n;
      j = k + 1;
    } else if (ch === '"') j = skipDouble(s, j + 1);
    else if (ch === '`') j = findBacktickEnd(s, j + 1) + 1;
    else if (ch === '(') { depth += 1; j += 1; }
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return j;
      j += 1;
    } else j += 1;
  }
  return n;
}

// Index just after the double quote that closes a string whose content starts at `j`.
function skipDouble(s, j) {
  const n = s.length;
  while (j < n) {
    const ch = s[j];
    if (ch === '\\') j += 2;
    else if (ch === '"') return j + 1;
    else if (ch === '$' && s[j + 1] === '(') {
      const e = findParenEnd(s, j + 2);
      j = e < n ? e + 1 : n;
    } else if (ch === '`') j = findBacktickEnd(s, j + 1) + 1;
    else j += 1;
  }
  return n;
}

// Index of the backtick that closes a command substitution whose content starts at `j` (or the end).
function findBacktickEnd(s, j) {
  const n = s.length;
  while (j < n) {
    if (s[j] === '\\') j += 2;
    else if (s[j] === '`') return j;
    else j += 1;
  }
  return n;
}

function lex(s, ctx) {
  const n = s.length;
  const units = [];
  let i = 0;
  let segStart = 0;
  let cut = -1;
  let words = [];
  let redirs = [];
  let subs = [];
  let cur = null;
  let pending = null;
  let pipeSeq = 0;
  let curPipe = -1;
  let joinNext = false;

  const begin = () => {
    if (!cur) cur = { text: '', unres: false, plain: true, prefix: '', open: true };
    return cur;
  };
  const lit = (str, quoted) => {
    const w = begin();
    w.text += str;
    if (quoted) { w.plain = false; w.open = false; } else if (w.open) w.prefix += str;
  };
  const unres = (src) => {
    const w = begin();
    w.text += src;
    w.unres = true;
    w.plain = false;
    w.open = false;
  };
  const expanded = (value) => {
    const w = begin();
    w.text += value;
    w.plain = false;
    w.open = false;
  };
  const endWord = () => {
    if (!cur) return;
    const w = cur;
    cur = null;
    if (pending) {
      pending.target = w;
      redirs.push(pending);
      pending = null;
    } else words.push(w);
  };
  // Closes the current piece; returns true when it made a simple command.
  const flush = (end) => {
    endWord();
    if (pending) { redirs.push(pending); pending = null; }
    let made = false;
    if (words.length || redirs.length) {
      const stop = cut >= 0 ? cut : end;
      const text = s.slice(segStart, stop).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
      const pipe = joinNext && curPipe >= 0 ? curPipe : ++pipeSeq;
      units.push({ kind: 'cmd', text, words, redirs, subs, pipe });
      curPipe = pipe;
      joinNext = false;
      made = true;
    }
    words = [];
    redirs = [];
    subs = [];
    cut = -1;
    return made;
  };
  const separator = (kind, len) => {
    flush(i);
    if (kind === 'pipe') joinNext = curPipe >= 0;
    else if (kind !== 'nl' && kind !== 'paren') joinNext = false;
    i += len;
    segStart = i;
  };
  const operator = (op, len) => {
    if (cur && cur.plain && /^[0-9]+$/.test(cur.text)) cur = null;
    else endWord();
    if (pending) { redirs.push(pending); pending = null; }
    pending = { op, target: null };
    i += len;
  };

  // `$` at s[i]; returns the new index.
  const dollar = (at) => {
    const nx = s[at + 1];
    if (nx === '(') {
      if (s[at + 2] === '(') {
        const e = findParenEnd(s, at + 2);
        unres(s.slice(at, e < n ? e + 1 : n));
        return e < n ? e + 1 : n;
      }
      const e = findParenEnd(s, at + 2);
      subs.push(s.slice(at + 2, e));
      unres(s.slice(at, e < n ? e + 1 : n));
      return e < n ? e + 1 : n;
    }
    if (nx === '{') {
      if (s.startsWith('${HOME}', at)) {
        if (ctx.home) expanded(ctx.home); else unres('${HOME}');
        return at + 7;
      }
      let depth = 1;
      let j = at + 2;
      while (j < n && depth > 0) {
        if (s[j] === '{') depth += 1;
        else if (s[j] === '}') depth -= 1;
        j += 1;
      }
      if (depth > 0) { unres('${'); return at + 2; }
      unres(s.slice(at, j));
      return j;
    }
    if (nx !== undefined && /[A-Za-z_]/.test(nx)) {
      let j = at + 1;
      while (j < n && /[A-Za-z0-9_]/.test(s[j])) j += 1;
      const name = s.slice(at + 1, j);
      if (name === 'HOME') {
        if (ctx.home) expanded(ctx.home); else unres('$HOME');
      } else unres('$' + name);
      return j;
    }
    if (nx !== undefined && /[0-9?!#$@*-]/.test(nx)) {
      unres('$' + nx);
      return at + 2;
    }
    lit('$', false);
    return at + 1;
  };

  const backtick = (at) => {
    const e = findBacktickEnd(s, at + 1);
    const raw = s.slice(at + 1, e);
    subs.push(raw.replace(/\\([`\\$])/g, '$1'));
    unres(s.slice(at, e < n ? e + 1 : n));
    return e < n ? e + 1 : n;
  };

  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i += 1; continue; }
    if (c === '\n') { separator('nl', 1); continue; }
    if (c === '\\') {
      if (s[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < n) { lit(s[i + 1], true); i += 2; } else { lit('\\', true); i += 1; }
      continue;
    }
    if (c === "'") {
      const k = s.indexOf("'", i + 1);
      const end = k < 0 ? n : k;
      lit(s.slice(i + 1, end), true);
      i = k < 0 ? n : k + 1;
      continue;
    }
    if (c === '"') {
      lit('', true);
      let j = i + 1;
      while (j < n && s[j] !== '"') {
        const ch = s[j];
        if (ch === '\\') {
          const nx = s[j + 1];
          if (nx === '"' || nx === '\\' || nx === '$' || nx === '`') { lit(nx, true); j += 2; }
          else if (nx === '\n') j += 2;
          else { lit('\\', true); j += 1; }
        } else if (ch === '$') {
          const before = j;
          j = dollar(j);
          if (j === before + 1 && s[before] === '$') { /* literal $ already added unquoted-flag; fine */ }
        } else if (ch === '`') j = backtick(j);
        else { lit(ch, true); j += 1; }
      }
      i = j < n ? j + 1 : n;
      continue;
    }
    if (c === '`') { i = backtick(i); continue; }
    if (c === '$') { i = dollar(i); continue; }
    if (c === '~' && !cur) {
      const nx = s[i + 1];
      if (nx === undefined || nx === '/' || /[\s;&|()<>]/.test(nx)) {
        if (ctx.home) expanded(ctx.home); else unres('~');
      } else unres('~');
      i += 1;
      continue;
    }
    if (c === '#' && !cur) {
      if (cut < 0) cut = i;
      const k = s.indexOf('\n', i);
      i = k < 0 ? n : k;
      continue;
    }
    if (c === ';') { separator('semi', 1); continue; }
    if (c === '(' || c === ')') { separator('paren', 1); continue; }
    if (c === '|') {
      if (s[i + 1] === '|') separator('or', 2);
      else if (s[i + 1] === '&') separator('pipe', 2);
      else separator('pipe', 1);
      continue;
    }
    if (c === '&') {
      if (s[i + 1] === '>') {
        if (s[i + 2] === '>') operator('&>>', 3); else operator('&>', 2);
      } else if (s[i + 1] === '&') separator('and', 2);
      else separator('bg', 1);
      continue;
    }
    if (c === '>') {
      const nx = s[i + 1];
      if (nx === '>') operator('>>', 2);
      else if (nx === '|') operator('>|', 2);
      else if (nx === '&') operator('>&', 2);
      else operator('>', 1);
      continue;
    }
    if (c === '<') {
      if (s.startsWith('<<<', i)) operator('<<<', 3);
      else if (s.startsWith('<<-', i)) operator('<<-', 3);
      else if (s.startsWith('<<', i)) operator('<<', 2);
      else if (s[i + 1] === '>') operator('<>', 2);
      else if (s[i + 1] === '&') operator('<&', 2);
      else operator('<', 1);
      continue;
    }
    lit(c, false);
    i += 1;
  }
  flush(n);
  return units;
}

// ---------------------------------------------------------------- the command word

const WRAPPERS = {
  sudo: { short: 'ughpCDRTU', long: ['user', 'group', 'host', 'prompt', 'chdir', 'chroot', 'close-from', 'type', 'role'], assign: true },
  env: { short: 'uCS', long: ['unset', 'chdir', 'split-string'], assign: true },
  nohup: { short: '', long: [] },
  time: { short: 'of', long: ['output', 'format'] },
  nice: { short: 'n', long: ['adjustment'] },
  command: { short: '', long: [] },
  exec: { short: 'a', long: [] },
  timeout: { short: 'sk', long: ['signal', 'kill-after'] },
  xargs: { short: 'InPLEdsa', long: ['max-args', 'max-procs', 'max-lines', 'max-chars', 'delimiter', 'arg-file'] },
};
const SHELLS = new Set(['sh', 'bash', 'zsh']);

function isAssign(w) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.prefix);
}

function skipOptions(ws, i, spec) {
  while (i < ws.length) {
    const w = ws[i].text;
    if (w === '--') { i += 1; break; }
    if (!w.startsWith('-')) break;
    if (w.startsWith('--')) {
      if (!w.includes('=') && spec.long.includes(w.slice(2))) i += 2; else i += 1;
    } else if (w.length > 1 && spec.short.includes(w[w.length - 1])) i += 2;
    else i += 1;
  }
  return Math.min(i, ws.length);
}

function analyze(unit) {
  const words = unit.words;
  let k = 0;
  while (k < words.length && words[k].plain && KEYWORDS.has(words[k].text)) k += 1;
  while (k < words.length && isAssign(words[k])) k += 1;
  const ws = words.slice(k);
  const names = [];
  let sudo = false;
  let name = null;
  let i = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    if (i >= ws.length) break;
    const base = baseName(ws[i].text);
    const spec = Object.hasOwn(WRAPPERS, base) ? WRAPPERS[base] : null;
    if (!spec) { name = base; i += 1; break; }
    names.push(base);
    i += 1;
    if (base === 'sudo') sudo = true;
    if (base === 'command') {
      let j = i;
      let lookup = false;
      while (j < ws.length && ws[j].text.startsWith('-') && ws[j].text !== '--') {
        if (/^-[A-Za-z]*[vV][A-Za-z]*$/.test(ws[j].text)) lookup = true;
        j += 1;
      }
      if (lookup) {
        names.pop();
        name = 'command';
        break;
      }
    }
    i = skipOptions(ws, i, spec);
    if (spec.assign) while (i < ws.length && isAssign(ws[i])) i += 1;
    if (base === 'timeout' && i < ws.length) i += 1;
  }
  const args = ws.slice(i);
  if (name !== null) names.push(name);
  unit.name = name;
  unit.names = names;
  unit.args = args;
  unit.sudo = sudo;
  if (name !== null && SHELLS.has(name)) {
    for (let a = 0; a < args.length; a += 1) {
      const t = args[a].text;
      if (t === '--' || t === '-' || t === '+' || !/^[-+]/.test(t)) break;
      if (/^-[A-Za-z]+$/.test(t) && t.includes('c')) {
        if (a + 1 < args.length) unit.subs.push(args[a + 1].text);
        break;
      }
      if (/[oO]$/.test(t)) a += 1;
    }
  } else if (name === 'eval') {
    unit.subs.push(args.map((w) => w.text).join(' '));
  }
}

const BOMB = ':(){:|:&};:';

// Reads `text` and appends its simple commands to `out`, in reading order.
function readAll(text, ctx, out, depth) {
  if (text.replace(/\s/g, '').includes(BOMB)) out.push({ kind: 'bomb', text: text.trim() });
  if (depth > MAX_DEPTH) return;
  const units = lex(text, ctx);
  for (const u of units) analyze(u);
  const fetched = new Set();
  for (const u of units) {
    if (u.names.some((x) => x === 'sh' || x === 'bash' || x === 'zsh' || x === 'python' || x === 'python3' || x === 'node' || x === 'sudo') && fetched.has(u.pipe)) {
      u.pipeShell = true;
    }
    if (u.names.includes('curl') || u.names.includes('wget')) fetched.add(u.pipe);
  }
  for (const u of units) {
    out.push(u);
    for (const sub of u.subs) readAll(sub, ctx, out, depth + 1);
  }
}

// ---------------------------------------------------------------- rules

const SEVERITY = { allow: 0, ask: 1, deny: 2 };

function oneLine(t) {
  return String(t).replace(/\s*[\r\n]+\s*/g, ' ');
}
const quoted = (t) => `"${oneLine(t)}"`;

// Splits arguments into option texts and non-option words ("--" ends the options).
function splitArgs(args) {
  const opts = [];
  const rest = [];
  let ended = false;
  for (const w of args) {
    if (!ended && w.text === '--') { ended = true; continue; }
    if (!ended && w.text.startsWith('-')) opts.push(w.text); else rest.push(w);
  }
  return { opts, rest };
}
const cluster = (opts, letter) => opts.some((o) => /^-[A-Za-z]+$/.test(o) && o.includes(letter));

function rmRisky(word, ctx) {
  if (word.unres) return true;
  const p = cmdPath(word.text).split('/').map((seg) => (seg === '.*' ? '..' : seg)).join('/');
  const joined = p.startsWith('/') ? p : ctx.project + '/' + p;
  const r = lexNorm(joined);
  if (r === '/' || r === '/*' || r === ctx.project) return true;
  const prefix = ctx.project === '/' ? '/' : ctx.project + '/';
  return !r.startsWith(prefix);
}

function isSecretPath(p) {
  const t = p.replace(/\/+$/, '');
  const last = t.slice(t.lastIndexOf('/') + 1);
  if (last === '.env') return true;
  if (last.startsWith('.env.') && !['.env.example', '.env.sample', '.env.template'].includes(last)) return true;
  if (['id_rsa', 'id_ed25519', 'id_ecdsa', '.netrc', '.npmrc'].includes(last)) return true;
  return t === '.aws/credentials' || t.endsWith('/.aws/credentials');
}

const SECRET_READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'cp', 'scp', 'base64', 'xxd', 'strings', 'nl', 'tac']);

function gitParts(args) {
  let i = 0;
  while (i < args.length) {
    const t = args[i].text;
    if (t === '-C' || t === '-c') i += 2;
    else if (t.startsWith('-')) i += 1;
    else break;
  }
  if (i >= args.length) return { sub: null, rest: [] };
  return { sub: args[i].text, rest: args.slice(i + 1) };
}

const verdict = (decision, rule, reason) => ({ decision, rule, reason });

function builtinDeny(u, ctx) {
  const name = u.name;
  const args = u.args || [];
  if (name === 'rm') {
    const { opts, rest } = splitArgs(args);
    const recursive = opts.includes('--recursive') || cluster(opts, 'r') || cluster(opts, 'R');
    const force = opts.includes('--force') || cluster(opts, 'f');
    if (recursive && force) {
      const bad = rest.find((w) => rmRisky(w, ctx));
      if (bad) {
        return verdict('deny', 'rm-rf', bad.unres
          ? `rm -rf on ${quoted(bad.text)}, a path only known when it runs, could delete far more than this project.`
          : `rm -rf on ${quoted(bad.text)} would delete the project folder itself or something outside it.`);
      }
    }
  }
  if (u.pipeShell) {
    return verdict('deny', 'pipe-to-shell', 'Downloaded content is piped straight into a shell or interpreter, so it runs unread.');
  }
  if (name !== null && (name === 'mkfs' || name.startsWith('mkfs.'))) {
    return verdict('deny', 'mkfs', 'mkfs formats a file system and destroys what is on the device.');
  }
  if (name === 'dd') {
    const hit = args.find((w) => w.text.startsWith('of=/dev/') && !['of=/dev/null', 'of=/dev/stdout', 'of=/dev/stderr'].includes(w.text));
    if (hit) return verdict('deny', 'dd-device', `dd writing to ${quoted(hit.text.slice(3))} overwrites a device.`);
  }
  for (const r of u.redirs) {
    if (!r.target) continue;
    const out = ['>', '>>', '>|', '&>', '&>>'].includes(r.op) || (r.op === '>&' && !/^([0-9]+|-)$/.test(r.target.text));
    if (out && (r.target.text.startsWith('/dev/sd') || r.target.text.startsWith('/dev/nvme'))) {
      return verdict('deny', 'redirect-device', `Redirecting output into ${quoted(r.target.text)} overwrites a disk.`);
    }
  }
  if (name === 'chmod' || name === 'chown') {
    const { opts, rest } = splitArgs(args);
    if (opts.includes('--recursive') || cluster(opts, 'R')) {
      const home = ctx.home ? posix.normalize(ctx.home).replace(/\/+$/, '') : null;
      const hit = rest.find((w) => {
        const n = posix.normalize(cmdPath(w.text));
        if (n === '/' || n === '/*') return true;
        const t = n.replace(/\/+$/, '');
        if (t === '' || t === '/*') return true;
        if (home !== null) return t === home || (home === '' && t === '');
        return t === '~' || t === '$HOME' || t === '${HOME}';
      });
      if (hit) return verdict('deny', 'chmod-chown-recursive', `Recursive ${name} on ${quoted(hit.text)} changes every file under the root or home folder.`);
    }
  }
  if (name !== null && SECRET_READERS.has(name)) {
    const { rest } = splitArgs(args);
    const files = (name === 'cp' || name === 'scp') && rest.length >= 2 ? rest.slice(0, -1) : rest;
    let hit = files.find((w) => isSecretPath(w.text));
    let text = hit ? hit.text : null;
    if (!hit) {
      const r = u.redirs.find((x) => x.op === '<' && x.target && isSecretPath(x.target.text));
      if (r) text = r.target.text;
    }
    if (text !== null) return verdict('deny', 'read-secret', `${name} would put the secret file ${quoted(text)} into the agent's transcript.`);
  }
  if (name === 'git') {
    const { sub, rest } = gitParts(args);
    if (sub === 'push') {
      const { opts, rest: paths } = splitArgs(rest);
      if (opts.includes('--force') || cluster(opts, 'f') || paths.some((w) => w.text.startsWith('+'))) {
        return verdict('deny', 'git-force-push', 'A forced push can overwrite other people\'s commits on the remote.');
      }
    }
  }
  return null;
}

function builtinAsk(u) {
  const name = u.name;
  const args = u.args || [];
  const has = (t) => args.some((w) => w.text === t);
  if (name === 'git') {
    const { sub, rest } = gitParts(args);
    const { opts } = splitArgs(rest);
    if (sub === 'push' && opts.some((o) => o.startsWith('--force-with-lease'))) {
      return verdict('ask', 'git-force-with-lease', 'A push with --force-with-lease can still overwrite commits on the remote.');
    }
    if (sub === 'reset' && opts.includes('--hard')) {
      return verdict('ask', 'git-reset-hard', 'git reset --hard throws away uncommitted changes.');
    }
    if (sub === 'clean' && (opts.includes('--force') || cluster(opts, 'f'))) {
      return verdict('ask', 'git-clean-force', 'git clean with force deletes untracked files for good.');
    }
    if (sub === 'checkout' && rest.some((w) => w.text === '.')) {
      return verdict('ask', 'git-discard', 'git checkout . discards the changes in the working tree.');
    }
    if (sub === 'restore' && rest.some((w) => w.text === '.')) {
      const staged = opts.includes('--staged') || cluster(opts, 'S');
      const worktree = opts.includes('--worktree') || cluster(opts, 'W');
      if (!(staged && !worktree)) return verdict('ask', 'git-discard', 'git restore . discards the changes in the working tree.');
    }
    if (sub === 'branch' && cluster(opts, 'D')) {
      return verdict('ask', 'git-branch-delete', 'git branch -D deletes a branch even if it is not merged.');
    }
  }
  if ((name === 'npm' || name === 'pnpm' || name === 'yarn') && has('publish') && !has('--dry-run')) {
    return verdict('ask', 'publish', `${name} publish releases a package to the registry for everyone.`);
  }
  if (name === 'kubectl' && has('delete')) return verdict('ask', 'kubectl-delete', 'kubectl delete removes cluster resources.');
  if (name === 'terraform' && has('destroy')) return verdict('ask', 'terraform-destroy', 'terraform destroy tears down real infrastructure.');
  if (name === 'docker') {
    for (let i = 0; i + 1 < args.length; i += 1) {
      if (args[i].text === 'system' && args[i + 1].text === 'prune') {
        return verdict('ask', 'docker-prune', 'docker system prune deletes unused containers, networks and images.');
      }
    }
  }
  if (name === 'psql' || name === 'mysql') {
    if (args.some((w) => /DROP\s+(DATABASE|TABLE)\b/i.test(w.text))) {
      return verdict('ask', 'sql-drop', `${name} is asked to drop a database or table.`);
    }
  }
  return null;
}

// The rule that decides one item, or null for allow.
function judge(u, ctx) {
  if (u.kind === 'bomb') return verdict('deny', 'fork-bomb', 'This is the classic fork bomb, which exhausts the machine\'s processes.');
  const cfg = ctx.config;
  if (cfg.allow.some((re) => re.test(u.text))) return null;
  const d = builtinDeny(u, ctx);
  if (d) return d;
  const pd = cfg.deny.find((p) => p.re.test(u.text));
  if (pd) return verdict('deny', 'project', `The command matches the deny pattern ${quoted(pd.src)} in command-guard.json.`);
  const a = builtinAsk(u);
  if (a) return a;
  if (u.sudo) return verdict('ask', 'sudo', 'sudo runs the command with administrator rights.');
  const pa = cfg.ask.find((p) => p.re.test(u.text));
  if (pa) return verdict('ask', 'project', `The command matches the ask pattern ${quoted(pa.src)} in command-guard.json.`);
  return null;
}

// ---------------------------------------------------------------- the project file

function loadConfig(dir) {
  const empty = { allow: [], ask: [], deny: [], error: null };
  let raw;
  try {
    raw = readFileSync(join(dir, 'command-guard.json'), 'utf8');
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return empty;
    return { ...empty, error: `command-guard.json could not be read (${e && e.code ? e.code : 'error'}).` };
  }
  const bad = (why) => ({ ...empty, error: `command-guard.json is not usable: ${oneLine(why)}.` });
  let data;
  try { data = JSON.parse(raw); } catch { return bad('it is not valid JSON'); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return bad('it is not a JSON object');
  const out = { allow: [], ask: [], deny: [], error: null };
  for (const key of ['allow', 'ask', 'deny']) {
    if (!Object.hasOwn(data, key)) continue;
    const list = data[key];
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) return bad(`"${key}" is not a list of strings`);
    for (const src of list) {
      let re;
      try { re = new RegExp(src); } catch { return bad(`${quoted(src)} in "${key}" is not a valid regular expression`); }
      out[key].push(key === 'allow' ? re : { re, src });
    }
  }
  return out;
}

// ---------------------------------------------------------------- deciding

function decide(command, cwd) {
  const nativeCwd = resolve(cwd);
  const ctx = {
    home: toPosixPath(process.env.HOME || ''),
    project: lexNorm(toPosixPath(nativeCwd)),
    config: loadConfig(nativeCwd),
  };
  let best = null;
  if (ctx.config.error) best = { decision: 'ask', rule: 'config-invalid', reason: ctx.config.error, command };
  const items = [];
  readAll(command, ctx, items, 0);
  for (const u of items) {
    const v = judge(u, ctx);
    if (v && (best === null || SEVERITY[v.decision] > SEVERITY[best.decision])) {
      best = { decision: v.decision, rule: v.rule, reason: v.reason, command: u.text };
    }
  }
  if (best === null) return { decision: 'allow', rule: null, reason: null, command };
  best.reason = oneLine(best.reason);
  return best;
}

// ---------------------------------------------------------------- the command line

const CODES = { allow: 0, ask: 1, deny: 3 };

function usageError(message) {
  process.stderr.write(`command-guard: ${message}\nTry: command-guard --help\n`);
  process.exitCode = 2;
}

function runCheck(argv) {
  let json = false;
  let cwd = null;
  const positional = [];
  let optionsEnded = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!optionsEnded && a === '--') { optionsEnded = true; continue; }
    if (!optionsEnded && a.length > 1 && a.startsWith('-')) {
      if (a === '--json') json = true;
      else if (a === '--cwd') {
        if (i + 1 >= argv.length) return usageError('--cwd needs a directory');
        cwd = argv[i + 1];
        i += 1;
      } else return usageError(`unknown option ${a}`);
      continue;
    }
    positional.push(a);
  }
  if (positional.length === 0) return usageError('check needs a command (put it in quotes)');
  if (positional.length > 1) return usageError('check takes exactly one command string (put it in quotes)');
  const r = decide(positional[0], cwd === null ? process.cwd() : cwd);
  let text;
  if (json) text = JSON.stringify({ decision: r.decision, rule: r.rule, reason: r.reason, command: r.command }) + '\n';
  else if (r.decision === 'allow') text = 'allow\n';
  else text = `${r.decision} ${r.rule}: ${r.reason}\ncommand: ${r.command}\n`;
  process.stdout.write(text);
  process.exitCode = CODES[r.decision];
}

async function readStdin() {
  const chunks = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch { /* an unreadable stdin is read as empty */ }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
}

function hookAnswer(decision, rule, reason) {
  const line = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: `${rule}: ${oneLine(reason)}`,
    },
  });
  process.stdout.write(line + '\n');
}

async function runHook() {
  if (process.stdin.isTTY) {
    process.stderr.write('command-guard: hook mode reads one PreToolUse JSON object on stdin (see --help).\n');
  }
  const raw = await readStdin();
  const badInput = (why) => hookAnswer('deny', 'bad-input', `command-guard could not read its input: ${why}.`);
  let obj;
  try { obj = JSON.parse(raw); } catch { return badInput('it is not valid JSON'); }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return badInput('it is not a JSON object');
  if (typeof obj.tool_name !== 'string') return badInput('tool_name is not a string');
  if (obj.tool_name !== 'Bash') return;
  const input = obj.tool_input;
  if (input === null || typeof input !== 'object' || typeof input.command !== 'string') {
    return badInput('tool_input.command is not a string');
  }
  const cwd = typeof obj.cwd === 'string' && obj.cwd !== '' ? obj.cwd : process.cwd();
  const r = decide(input.command, cwd);
  if (r.decision !== 'allow') hookAnswer(r.decision, r.rule, r.reason);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) return runHook();
  const first = argv[0];
  if (first === 'check') return runCheck(argv.slice(1));
  if (first === '--help' || first === '-h') { process.stdout.write(USAGE); return; }
  if (first === '--version') { process.stdout.write(VERSION + '\n'); return; }
  return usageError(`unknown argument ${first}`);
}

await main();
