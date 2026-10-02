# codex-at

Schedule Codex CLI jobs to run later in a specific directory — then get out of the way.

`codex-at` is a tiny zero-dependency TypeScript CLI for scheduling one-shot Codex runs. It keeps a lightweight detached scheduler in the background, launches `codex exec` when a task becomes due, detaches from the Codex process, and exits automatically when there are no pending jobs left.

A common use case is resuming unfinished Codex work after your usage limit resets.

## Features

- Schedule Codex at an exact time with `--at`
- Schedule Codex after a delay with `--in`
- Run in any working directory
- Resume the latest Codex session with `--resume-last`
- Run new prompts with `codex exec`
- Detached execution: Codex keeps running after the scheduler exits
- List, remove, and manually run scheduled tasks
- Per-task log files
- No runtime npm dependencies
- Local JSON task storage

## Requirements

- Node.js 22+
- Codex CLI installed and authenticated

Verify Codex first:

```bash
codex --version
```

## Installation

Clone the repository and link the CLI globally:

```bash
git clone https://github.com/xiao333ma/codex-at.git
cd codex-at
npm link
```

Then verify:

```bash
codex-at --help
```

## Quick start

Resume the most recent Codex session in five hours:

```bash
codex-at add \
  --in 5h \
  --dir ~/projects/my-app \
  --resume-last \
  --name "resume-after-limit"
```

This launches approximately:

```bash
cd ~/projects/my-app
codex exec --full-auto resume --last \
  "Continue the unfinished task from where you left off. Finish it and verify the result."
```

You can provide your own continuation prompt:

```bash
codex-at add \
  --in 5h \
  --dir ~/projects/my-app \
  --resume-last \
  --prompt "Continue exactly where you stopped. Inspect the current diff first, then finish implementation and tests."
```

## Schedule at an exact time

```bash
codex-at add \
  --at "2026-10-03 03:00" \
  --dir ~/projects/my-app \
  --prompt "Fix the remaining TypeScript errors, run the tests, and finish the task." \
  --name "finish-ts-errors"
```

A date without an explicit timezone is interpreted in the machine's local timezone.

ISO 8601 offsets are also supported:

```bash
codex-at add \
  --at "2026-10-03T03:00:00+08:00" \
  --dir ~/projects/my-app \
  --prompt "Finish the task"
```

## Relative times

The `--in` option accepts combinations of days, hours, minutes, and seconds:

```bash
codex-at add --in 30m --dir . --prompt "Review the repository"
codex-at add --in 5h --dir . --resume-last
codex-at add --in 1h30m --dir . --resume-last
codex-at add --in 1d --dir . --prompt "Run the release checklist"
```

## Manage tasks

List pending tasks:

```bash
codex-at list
```

List all tasks, including launched and failed tasks:

```bash
codex-at list --all
```

Remove a task:

```bash
codex-at remove <id>
```

Run a task immediately:

```bash
codex-at run <id>
```

View a task log:

```bash
codex-at logs <id>
```

Check scheduler status:

```bash
codex-at status
```

Task IDs may be shortened as long as the prefix is unique.

## Full-auto mode

Scheduled tasks use `codex exec --full-auto` by default because unattended jobs may otherwise stop and wait for routine approval.

Disable it when needed:

```bash
codex-at add \
  --in 1h \
  --dir . \
  --prompt "Review this repository" \
  --no-full-auto
```

## Pass extra Codex arguments

Use repeated `--codex-arg` options:

```bash
codex-at add \
  --in 1h \
  --dir . \
  --prompt "Finish the task" \
  --codex-arg=-m \
  --codex-arg=gpt-6.1-codex
```

## How it works

Tasks are stored locally. When a pending task exists, `codex-at` starts a detached scheduler process.

When the task becomes due, the scheduler:

1. Opens a log file for the task.
2. Starts `codex exec` in the configured working directory.
3. Detaches from the Codex process.
4. Marks the task as launched.
5. Continues waiting for any remaining tasks.
6. Exits automatically when no pending tasks remain.

The launched Codex process is independent of the scheduler and continues running on its own.

## Local data

`codex-at` stores its state under:

```text
~/.codex-at/
├── tasks.json
├── daemon.pid
├── daemon.lock
└── logs/
    └── <task-id>.log
```

## Development

The project intentionally has no runtime dependencies. Node.js 22 runs the TypeScript source using built-in type stripping.

```bash
npm run check
```

Run directly:

```bash
npm start -- --help
```

## License

MIT
