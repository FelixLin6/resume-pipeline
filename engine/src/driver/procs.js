// WIP — Phase 1 scaffold. Process lifecycle: pidfile + cmdline-checked kill.
// Design: engine/design/architecture.md §6.
//
// NEVER a pattern sweep. Two recorded reasons:
//  1. `pkill -f <pat>` matches full command lines, so it kills the CALLER
//     whose own command mentions the pattern — a Stage 3 teardown killed its
//     own shell mid-run (exit 144, 2026-09-02).
//  2. A bare "Chrome" pattern could hit Felix's personal browser. The user's
//     normal Chrome is untouchable, always (Felix 2026-09-17).
//
// So: we kill a pid we ourselves recorded, and only after confirming the
// live process really is the thing we started.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function writePidfile(file, pid) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(pid), 'utf8');
  return file;
}

/**
 * Read the live command line of `pid`.
 * Linux: /proc/<pid>/cmdline (NUL-separated). macOS has no /proc, so: ps.
 * @returns {string|null} null when the pid does not exist.
 */
export function readCmdline(pid) {
  if (process.platform === 'linux') {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch { return null; }
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

/**
 * Kill the process named by a pidfile, but ONLY if its live command line
 * still contains `expect` (normally the distinctive --user-data-dir).
 *
 * @returns {'killed'|'stale'|'absent'|'mismatch'}
 */
export function killByPidfile(file, expect, { graceMs = 3000 } = {}) {
  if (!fs.existsSync(file)) return 'absent';
  const pid = Number(fs.readFileSync(file, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 1) { fs.rmSync(file, { force: true }); return 'stale'; }

  const cmd = readCmdline(pid);
  if (cmd === null) { fs.rmSync(file, { force: true }); return 'stale'; }

  // The pid was recycled onto some unrelated process — do NOT signal it, and
  // do NOT widen the search to find "the real one".
  if (!cmd.includes(expect)) return 'mismatch';

  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (readCmdline(pid) === null) break;
    try { execFileSync('sleep', ['0.1']); } catch { break; }
  }
  if (readCmdline(pid) !== null) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* raced */ }
  }
  fs.rmSync(file, { force: true });
  return 'killed';
}
