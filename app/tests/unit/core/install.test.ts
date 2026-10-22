/**
 * The per-user agent install: what it refuses to unpack, what it leaves behind when it fails, and that a
 * finished copy is what the effective catalog points at. Synthetic bytes and an injected `unpack` — the
 * real thing is a 90 MB download and `tar`, neither of which a unit test needs.
 */

import { describe, expect, it } from '@gjsify/unit';

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AgentInstallError,
  BUNDLED_PREFIX,
  distFor,
  effectiveCatalog,
  installAgent,
  installedPath,
  isInstalled,
  type BundledAgent,
} from '@lotse/core';

const BYTES = new TextEncoder().encode('pretend this is a tarball');
const SHA = createHash('sha256').update(BYTES).digest('hex');

function agent(over: Partial<BundledAgent> = {}): BundledAgent {
  return {
    id: 'demo',
    title: 'Demo',
    version: '1.0.0',
    license: 'MIT',
    dist: [
      { arch: 'x86_64', url: 'https://example.invalid/demo.tgz', sha256: SHA, size: BYTES.byteLength },
      { arch: 'aarch64', url: 'https://example.invalid/demo-arm.tgz', sha256: SHA, size: BYTES.byteLength },
    ],
    command: ['acp'],
    env: {},
    refreshed: '2026-01-01',
    installPath: `${BUNDLED_PREFIX}/demo`,
    binary: 'bin/demo-cli',
    ...over,
  };
}

const respond =
  (body: Uint8Array, status = 200): typeof fetch =>
  async () =>
    new Response(body as BodyInit, { status });

/** Stands in for tar: puts the agent's binary where the archive would. */
const unpackBinary = (binary: string) => async (_archive: string, into: string) => {
  const file = join(into, binary);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '#!/bin/sh\n');
};

const LINUX = { platform: 'linux' as const, arch: 'x64' };

async function withDataDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lotse-install-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function failure(promise: Promise<unknown>): Promise<AgentInstallError> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof AgentInstallError).toBe(true);
    return error as AgentInstallError;
  }
  throw new Error('expected the install to fail');
}

const leftovers = (dir: string, id = 'demo'): string[] => {
  const root = join(dir, 'agent-binaries', id);
  return existsSync(root) ? readdirSync(root) : [];
};

export default async () => {
  await describe('distFor', async () => {
    await it('maps node architectures onto the catalog labels', async () => {
      expect(distFor(agent(), 'linux', 'x64')!.arch).toBe('x86_64');
      expect(distFor(agent(), 'linux', 'arm64')!.arch).toBe('aarch64');
    });

    await it('has no pin for another platform or architecture', async () => {
      expect(distFor(agent(), 'win32', 'x64')).toBe(null);
      expect(distFor(agent(), 'darwin', 'arm64')).toBe(null);
      expect(distFor(agent(), 'linux', 'ia32')).toBe(null);
    });
  });

  await describe('installAgent', async () => {
    await it('verifies, unpacks and returns the program path', async () => {
      await withDataDir(async (dir) => {
        const entry = agent();
        const program = await installAgent(entry, dir, {
          ...LINUX,
          fetch: respond(BYTES),
          unpack: unpackBinary(entry.binary),
        });
        expect(program).toBe(join(installedPath(dir, entry), entry.binary));
        expect(existsSync(program)).toBe(true);
        expect(isInstalled(entry, dir)).toBe(true);
        expect(leftovers(dir).join()).toBe('1.0.0');
      });
    });

    await it('refuses a download whose sha256 differs and leaves nothing behind', async () => {
      await withDataDir(async (dir) => {
        const tampered = new TextEncoder().encode('pretend this is a tarbal!');
        let unpacked = false;
        const error = await failure(
          installAgent(agent(), dir, {
            ...LINUX,
            fetch: respond(tampered),
            unpack: async () => {
              unpacked = true;
            },
          }),
        );
        expect(error.kind).toBe('checksum');
        expect(unpacked).toBe(false);
        expect(leftovers(dir).join()).toBe('');
      });
    });

    await it('refuses a download of the wrong size before hashing it', async () => {
      await withDataDir(async (dir) => {
        const error = await failure(
          installAgent(agent(), dir, { ...LINUX, fetch: respond(BYTES.slice(0, 5)), unpack: async () => {} }),
        );
        expect(error.kind).toBe('size');
        expect(leftovers(dir).join()).toBe('');
      });
    });

    await it('reports an HTTP error and a network error as a download failure', async () => {
      await withDataDir(async (dir) => {
        const http = await failure(installAgent(agent(), dir, { ...LINUX, fetch: respond(BYTES, 404) }));
        expect(http.kind).toBe('download');
        const offline = await failure(
          installAgent(agent(), dir, {
            ...LINUX,
            fetch: async () => {
              throw new Error('offline');
            },
          }),
        );
        expect(offline.kind).toBe('download');
        expect(leftovers(dir).join()).toBe('');
      });
    });

    await it('fails without a request where the catalog has no pin', async () => {
      await withDataDir(async (dir) => {
        let requested = false;
        const error = await failure(
          installAgent(agent(), dir, {
            platform: 'win32',
            arch: 'x64',
            fetch: async () => {
              requested = true;
              return new Response(BYTES as BodyInit);
            },
          }),
        );
        expect(error.kind).toBe('unsupported');
        expect(requested).toBe(false);
      });
    });

    await it('fails when the archive does not contain the binary', async () => {
      await withDataDir(async (dir) => {
        const error = await failure(
          installAgent(agent(), dir, { ...LINUX, fetch: respond(BYTES), unpack: async () => {} }),
        );
        expect(error.kind).toBe('unpack');
        expect(leftovers(dir).join()).toBe('');
      });
    });

    await it('is idempotent: a complete copy is returned without a request', async () => {
      await withDataDir(async (dir) => {
        const entry = agent();
        const options = { ...LINUX, fetch: respond(BYTES), unpack: unpackBinary(entry.binary) };
        const first = await installAgent(entry, dir, options);
        const second = await installAgent(entry, dir, {
          ...LINUX,
          fetch: async () => {
            throw new Error('must not be called');
          },
        });
        expect(second).toBe(first);
      });
    });

    await it("never touches the agent's isolated state when it prunes", async () => {
      await withDataDir(async (dir) => {
        const login = join(dir, 'agents', 'demo', 'data', 'auth.json');
        mkdirSync(dirname(login), { recursive: true });
        writeFileSync(login, '{}');
        const old = agent({ version: '0.9.0' });
        await installAgent(old, dir, { ...LINUX, fetch: respond(BYTES), unpack: unpackBinary(old.binary) });
        const current = agent();
        await installAgent(current, dir, {
          ...LINUX,
          fetch: respond(BYTES),
          unpack: unpackBinary(current.binary),
        });
        expect(existsSync(login)).toBe(true);
      });
    });

    await it('prunes the version it replaces', async () => {
      await withDataDir(async (dir) => {
        const old = agent({ version: '0.9.0' });
        await installAgent(old, dir, { ...LINUX, fetch: respond(BYTES), unpack: unpackBinary(old.binary) });
        const current = agent();
        await installAgent(current, dir, {
          ...LINUX,
          fetch: respond(BYTES),
          unpack: unpackBinary(current.binary),
        });
        expect(leftovers(dir).join()).toBe('1.0.0');
      });
    });
  });

  await describe('effectiveCatalog', async () => {
    await it('leaves an entry alone when nothing is installed', async () => {
      await withDataDir(async (dir) => {
        const entry = agent();
        expect(effectiveCatalog(dir, [entry])[0]!.installPath).toBe(entry.installPath);
      });
    });

    await it('points an entry at its per-user copy once that exists', async () => {
      await withDataDir(async (dir) => {
        const entry = agent();
        await installAgent(entry, dir, {
          ...LINUX,
          fetch: respond(BYTES),
          unpack: unpackBinary(entry.binary),
        });
        expect(effectiveCatalog(dir, [entry])[0]!.installPath).toBe(installedPath(dir, entry));
      });
    });
  });
};
