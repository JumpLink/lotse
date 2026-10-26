/**
 * The one private-file writer: a sibling temp file, fsync, rename — so a crash leaves the old file or the
 * new one. File `0600`, a directory lotse creates `0700`. An existing directory is left alone: an
 * override variable may point into a shared one, and narrowing its mode is not ours to do.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Create `dir` `0700` when it is not there; an existing one is left alone. */
export function ensureDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function writePrivateFile(path: string, text: string, tempPrefix: string): void {
  const dir = dirname(path);
  ensureDir(dir);
  const temp = join(dir, `.${tempPrefix}-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    const handle = openSync(temp, 'r+');
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
