/**
 * Install a catalog agent for ONE person, on request: the same pinned archive a Flatpak ships as
 * `extra-data`, fetched at runtime into the app's own data directory.
 *
 * **Why it exists.** The shipped copy (`BUNDLED_PREFIX`) is a Flatpak thing. A .deb, an AppImage or a
 * source install has no such directory, so without this the person lands on "no agent" until they install
 * one by hand. A per-user copy gives every package the same answer without every package bundling 90 MB.
 *
 * **What it trusts.** Nothing but the catalog. The URL, the size and the sha256 are the pins in
 * `bundled-agents.json`; the bytes are measured against both BEFORE anything is unpacked, and a mismatch
 * leaves no trace. There is deliberately no "latest": a newer opencode arrives with a lotse release that
 * moves the pin, so what runs next to tax data was read by someone. See ADR 0006.
 *
 * **What it never does.** It does not decide that an install happens — the caller asks the person first
 * (it is a network download of a program) and then calls {@link installAgent}. It does not run the agent
 * and it writes nowhere outside `<dataDir>/agent-binaries`. In a Flatpak that directory is inside the sandbox, and
 * the copy runs there, under the same finish-args as the app: nothing is widened.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BUNDLED_AGENTS,
  bundledProgram,
  type BundledAgent,
  type BundledArch,
  type BundledDist,
} from './catalog.ts';

/**
 * Where per-user copies live: `<dataDir>/agent-binaries`. NOT `<dataDir>/agents` — `isolationDirs` keeps the
 * agent's HOME, config and login under `agents/<id>/`, and pruning old versions there would delete them.
 */
export function installRoot(dataDir: string): string {
  return join(dataDir, 'agent-binaries');
}

/** The directory one pinned version unpacks into. A version in the path lets an update sit beside the old one. */
export function installedPath(dataDir: string, agent: BundledAgent): string {
  return join(installRoot(dataDir), agent.id, agent.version);
}

/** The entry as it is when its per-user copy is the one to run: only `installPath` differs. */
export function installedEntry(agent: BundledAgent, dataDir: string): BundledAgent {
  return { ...agent, installPath: installedPath(dataDir, agent) };
}

/** Whether the per-user copy of exactly this pinned version is complete. */
export function isInstalled(agent: BundledAgent, dataDir: string): boolean {
  return existsSync(join(installedPath(dataDir, agent), agent.binary));
}

/** The pin for this machine, or `null` when the catalog has none (a platform without a pinned archive). */
export function distFor(
  agent: BundledAgent,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): BundledDist | null {
  if (platform !== 'linux') return null;
  const pinned: BundledArch | null = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : null;
  return pinned === null ? null : (agent.dist.find((dist) => dist.arch === pinned) ?? null);
}

/**
 * The catalog as this machine can run it: an entry whose shipped copy exists stays as it is, one with
 * only a per-user copy points at that copy, one with neither stays as it is (and is "not available").
 * Every reader of a bundled path takes this list instead of `BUNDLED_AGENTS`, so a per-user copy is not a
 * third kind of agent anywhere downstream — it is a bundled one that lives somewhere else.
 */
export function effectiveCatalog(
  dataDir: string,
  catalog: readonly BundledAgent[] = BUNDLED_AGENTS,
): BundledAgent[] {
  return catalog.map((entry) =>
    existsSync(bundledProgram(entry)) || !isInstalled(entry, dataDir)
      ? entry
      : installedEntry(entry, dataDir),
  );
}

export type InstallFailure = 'unsupported' | 'download' | 'size' | 'checksum' | 'unpack' | 'write';

/** A failed install. `kind` is for the caller's wording; nothing from a failed attempt stays on disk. */
export class AgentInstallError extends Error {
  readonly kind: InstallFailure;

  constructor(kind: InstallFailure, message: string) {
    super(message);
    this.name = 'AgentInstallError';
    this.kind = kind;
  }
}

export interface InstallOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  /** Unpacks `archive` into `into`. Defaults to `tar -xzf`; injected for tests. */
  readonly unpack?: (archive: string, into: string) => Promise<void>;
}

function tarUnpack(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', into], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) =>
      reject(new AgentInstallError('unpack', `could not run tar: ${error.message}`)),
    );
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new AgentInstallError('unpack', `tar exited with ${code}${stderr ? `: ${stderr.trim()}` : ''}`),
          ),
    );
  });
}

function removeQuietly(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Drop every other version of this agent, and any half-finished attempt a crash left behind. */
function pruneOthers(dataDir: string, agent: BundledAgent): void {
  const root = join(installRoot(dataDir), agent.id);
  for (const name of readdirSync(root)) {
    if (name !== agent.version) removeQuietly(join(root, name));
  }
}

/**
 * Download, verify, unpack and move the pinned archive into place. Resolves with the program's path.
 * Idempotent: a complete copy of this version is returned without a request.
 *
 * Order matters and is the whole security argument: size, then sha256, both on the downloaded bytes, and
 * only then `tar`. The unpack goes to a scratch directory beside the target and is renamed in, so a copy
 * that exists is a complete one.
 *
 * @throws {AgentInstallError}
 */
export async function installAgent(
  agent: BundledAgent,
  dataDir: string,
  options: InstallOptions = {},
): Promise<string> {
  const target = installedPath(dataDir, agent);
  const program = join(target, agent.binary);
  if (isInstalled(agent, dataDir)) return program;

  const dist = distFor(agent, options.platform, options.arch);
  if (dist === null) {
    throw new AgentInstallError(
      'unsupported',
      `${agent.title} ${agent.version} has no pinned download for ${options.platform ?? process.platform}/${options.arch ?? process.arch}`,
    );
  }

  const get = options.fetch ?? fetch;
  let bytes: Uint8Array;
  try {
    const response = await get(dist.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new AgentInstallError('download', `could not download ${dist.url}: ${(error as Error).message}`);
  }
  if (bytes.byteLength !== dist.size) {
    throw new AgentInstallError('size', `expected ${dist.size} bytes, received ${bytes.byteLength}`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== dist.sha256) {
    throw new AgentInstallError('checksum', `sha256 is ${digest}, the catalog pins ${dist.sha256}`);
  }

  const agentRoot = join(installRoot(dataDir), agent.id);
  const scratch = join(agentRoot, `.partial-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const archive = join(scratch, 'archive.tar.gz');
    writeFileSync(archive, bytes, { mode: 0o600 });
    const unpacked = join(scratch, 'files');
    mkdirSync(unpacked);
    await (options.unpack ?? tarUnpack)(archive, unpacked);
    if (!existsSync(join(unpacked, agent.binary))) {
      throw new AgentInstallError('unpack', `the archive has no ${agent.binary}`);
    }
    chmodSync(join(unpacked, agent.binary), 0o755);
    removeQuietly(target);
    renameSync(unpacked, target);
  } catch (error) {
    if (error instanceof AgentInstallError) throw error;
    throw new AgentInstallError('write', `could not install under ${agentRoot}: ${(error as Error).message}`);
  } finally {
    removeQuietly(scratch);
  }
  pruneOthers(dataDir, agent);
  return program;
}
