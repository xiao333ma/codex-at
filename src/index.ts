#!/usr/bin/env -S node --no-warnings --experimental-strip-types

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const APP_DIR = resolve(homedir(), '.codex-at');
const TASKS_FILE = resolve(APP_DIR, 'tasks.json');
const PID_FILE = resolve(APP_DIR, 'daemon.pid');
const LOCK_FILE = resolve(APP_DIR, 'daemon.lock');
const LOG_DIR = resolve(APP_DIR, 'logs');
const POLL_MS = 1000;

type TaskStatus = 'pending' | 'launched' | 'failed';
type Task = {
  id: string;
  name?: string;
  cwd: string;
  runAt: string;
  prompt: string;
  resumeLast: boolean;
  fullAuto: boolean;
  extraArgs: string[];
  status: TaskStatus;
  createdAt: string;
  launchedAt?: string;
  launchPid?: number;
  error?: string;
  logFile?: string;
};
type Store = { version: 1; tasks: Task[] };

function ensureAppDir(): void {
  mkdirSync(LOG_DIR, { recursive: true });
  if (!existsSync(TASKS_FILE)) writeStore({ version: 1, tasks: [] });
}

function readStore(): Store {
  ensureAppDir();
  const parsed = JSON.parse(readFileSync(TASKS_FILE, 'utf8')) as Store;
  if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
    throw new Error(`Invalid task store: ${TASKS_FILE}`);
  }
  return parsed;
}

function writeStore(store: Store): void {
  mkdirSync(APP_DIR, { recursive: true });
  const tmp = `${TASKS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  renameSync(tmp, TASKS_FILE);
}

function parseAbsoluteTime(value: string): Date {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(value)
    ? value.replace(' ', 'T')
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid time: ${value}`);
  return date;
}

function parseDuration(value: string): number {
  const compact = value.toLowerCase().replace(/\s+/g, '');
  const re = /(\d+(?:\.\d+)?)(d|h|m|s)/g;
  let total = 0;
  let consumed = '';
  for (const match of compact.matchAll(re)) {
    consumed += match[0];
    const n = Number(match[1]);
    const factor = match[2] === 'd' ? 86400000 : match[2] === 'h' ? 3600000 : match[2] === 'm' ? 60000 : 1000;
    total += n * factor;
  }
  if (!total || consumed !== compact) {
    throw new Error(`Invalid duration: ${value}. Use 30m, 5h, 1h30m, 1d, etc.`);
  }
  return total;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function resolveTask(idOrPrefix: string, tasks: Task[]): Task {
  const exact = tasks.find((t) => t.id === idOrPrefix);
  if (exact) return exact;
  const matches = tasks.filter((t) => t.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`Task not found: ${idOrPrefix}`);
  throw new Error(`Ambiguous task id prefix: ${idOrPrefix}`);
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function getDaemonPid(): number | undefined {
  if (!existsSync(PID_FILE)) return undefined;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) {
    rmSync(PID_FILE, { force: true });
    return undefined;
  }
  return pid;
}

function ensureDaemon(): void {
  ensureAppDir();
  if (getDaemonPid()) return;
  const child = spawn(process.execPath, ['--experimental-strip-types', process.argv[1], '__daemon'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function codexBinary(): string {
  return process.platform === 'win32' ? 'codex.cmd' : 'codex';
}

function codexArgs(task: Task): string[] {
  const args = ['exec'];
  if (task.fullAuto) args.push('--full-auto');
  args.push(...task.extraArgs);
  if (task.resumeLast) args.push('resume', '--last', task.prompt);
  else args.push(task.prompt);
  return args;
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=+\-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function launchTask(task: Task): Promise<{ pid: number; logFile: string }> {
  const logFile = resolve(LOG_DIR, `${task.id}.log`);
  const fd = openSync(logFile, 'a');
  writeFileSync(
    fd,
    `\n=== launch ${new Date().toISOString()} ===\n` +
      `cwd: ${task.cwd}\n` +
      `command: ${codexBinary()} ${codexArgs(task).map(shellQuote).join(' ')}\n\n`,
    'utf8',
  );

  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(codexBinary(), codexArgs(task), {
      cwd: task.cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
      windowsHide: true,
    });
    let done = false;
    child.once('spawn', () => {
      done = true;
      closeSync(fd);
      child.unref();
      resolveLaunch({ pid: child.pid!, logFile });
    });
    child.once('error', (error) => {
      if (!done) {
        closeSync(fd);
        rejectLaunch(error);
      }
    });
  });
}

async function daemon(): Promise<void> {
  ensureAppDir();
  let lockFd: number;
  try { lockFd = openSync(LOCK_FILE, 'wx'); } catch { return; }
  writeFileSync(PID_FILE, `${process.pid}\n`, 'utf8');

  const cleanup = () => {
    try { closeSync(lockFd); } catch {}
    rmSync(LOCK_FILE, { force: true });
    rmSync(PID_FILE, { force: true });
  };
  process.once('SIGTERM', () => { cleanup(); process.exit(0); });
  process.once('SIGINT', () => { cleanup(); process.exit(0); });

  try {
    while (true) {
      const store = readStore();
      const pending = store.tasks
        .filter((t) => t.status === 'pending')
        .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
      if (pending.length === 0) return;

      const now = Date.now();
      const due = pending.filter((t) => Date.parse(t.runAt) <= now);
      if (due.length === 0) {
        await sleep(Math.min(POLL_MS, Math.max(50, Date.parse(pending[0].runAt) - now)));
        continue;
      }

      for (const dueTask of due) {
        const latest = readStore();
        const current = latest.tasks.find((t) => t.id === dueTask.id);
        if (!current || current.status !== 'pending') continue;
        try {
          const launched = await launchTask(current);
          current.status = 'launched';
          current.launchedAt = new Date().toISOString();
          current.launchPid = launched.pid;
          current.logFile = launched.logFile;
          current.error = undefined;
        } catch (error) {
          current.status = 'failed';
          current.error = error instanceof Error ? error.message : String(error);
        }
        writeStore(latest);
      }
    }
  } finally {
    cleanup();
  }
}

function help(): void {
  console.log(`codex-at - schedule detached Codex CLI runs\n\n` +
`Commands:\n` +
`  add --at <time>|--in <duration> --dir <path> [--prompt <text>] [--resume-last]\n` +
`      [--name <name>] [--no-full-auto] [--codex-arg <arg> ...]\n` +
`  list [--all]\n` +
`  remove <id>\n` +
`  run <id>\n` +
`  logs <id>\n` +
`  status\n\n` +
`Examples:\n` +
`  codex-at add --in 5h --dir ~/app --resume-last\n` +
`  codex-at add --at "2026-10-03 03:00" --dir ~/app --prompt "Finish tests"\n`);
}

function commonValues(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      at: { type: 'string' },
      in: { type: 'string' },
      dir: { type: 'string', short: 'd' },
      prompt: { type: 'string', short: 'p' },
      'resume-last': { type: 'boolean', default: false },
      name: { type: 'string' },
      'no-full-auto': { type: 'boolean', default: false },
      'codex-arg': { type: 'string', multiple: true },
      all: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help') { help(); return; }
  if (command === '__daemon') { await daemon(); return; }

  if (command === 'add') {
    const { values } = commonValues(rest);
    const at = values.at as string | undefined;
    const after = values.in as string | undefined;
    const dir = values.dir as string | undefined;
    if (!!at === !!after) throw new Error('Use exactly one of --at or --in');
    if (!dir) throw new Error('--dir is required');

    const cwd = resolve(dir);
    if (!existsSync(cwd)) throw new Error(`Directory does not exist: ${cwd}`);
    const runAt = at ? parseAbsoluteTime(at) : new Date(Date.now() + parseDuration(after!));
    if (runAt.getTime() <= Date.now()) throw new Error('Scheduled time must be in the future');

    const resumeLast = Boolean(values['resume-last']);
    const promptRaw = values.prompt as string | undefined;
    const prompt = promptRaw?.trim() || (resumeLast
      ? 'Continue the unfinished task from where you left off. Finish it and verify the result.'
      : '');
    if (!prompt) throw new Error('--prompt is required unless --resume-last is used');

    const store = readStore();
    const task: Task = {
      id: randomUUID().replaceAll('-', '').slice(0, 12),
      name: values.name as string | undefined,
      cwd,
      runAt: runAt.toISOString(),
      prompt,
      resumeLast,
      fullAuto: !Boolean(values['no-full-auto']),
      extraArgs: (values['codex-arg'] as string[] | undefined) ?? [],
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    store.tasks.push(task);
    writeStore(store);
    ensureDaemon();
    console.log(`Added ${task.id}`);
    console.log(`  when: ${formatDate(task.runAt)}`);
    console.log(`  dir:  ${task.cwd}`);
    console.log(`  mode: ${task.resumeLast ? 'resume-last' : 'exec'}`);
    return;
  }

  if (command === 'list' || command === 'ls') {
    const { values } = commonValues(rest);
    const tasks = readStore().tasks
      .filter((t) => Boolean(values.all) || t.status === 'pending')
      .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
    if (!tasks.length) { console.log('No tasks.'); return; }
    console.table(tasks.map((t) => ({
      id: t.id,
      name: t.name ?? '',
      status: t.status,
      when: formatDate(t.runAt),
      mode: t.resumeLast ? 'resume-last' : 'exec',
      dir: t.cwd,
    })));
    return;
  }

  if (command === 'remove' || command === 'rm') {
    const id = rest[0];
    if (!id) throw new Error('Usage: codex-at remove <id>');
    const store = readStore();
    const task = resolveTask(id, store.tasks);
    store.tasks = store.tasks.filter((t) => t.id !== task.id);
    writeStore(store);
    console.log(`Removed ${task.id}`);
    return;
  }

  if (command === 'run') {
    const id = rest[0];
    if (!id) throw new Error('Usage: codex-at run <id>');
    const store = readStore();
    const task = resolveTask(id, store.tasks);
    if (task.status !== 'pending') throw new Error(`Task is ${task.status}, not pending`);
    task.runAt = new Date().toISOString();
    writeStore(store);
    ensureDaemon();
    console.log(`Queued ${task.id} to run now.`);
    return;
  }

  if (command === 'logs') {
    const id = rest[0];
    if (!id) throw new Error('Usage: codex-at logs <id>');
    const task = resolveTask(id, readStore().tasks);
    const logFile = task.logFile ?? resolve(LOG_DIR, `${task.id}.log`);
    console.log(logFile);
    if (!existsSync(logFile)) { console.log('(log file does not exist yet)'); return; }
    console.log(readFileSync(logFile, 'utf8').split('\n').slice(-120).join('\n'));
    return;
  }

  if (command === 'status') {
    const pid = getDaemonPid();
    const pending = readStore().tasks.filter((t) => t.status === 'pending').length;
    console.log(`scheduler: ${pid ? `running (pid ${pid})` : 'idle'}`);
    console.log(`pending:   ${pending}`);
    console.log(`data:      ${APP_DIR}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
