/**
 * `lotse agents` — the launchers, and whether their binary is there.
 *
 * A small command with one job: make "not installed" and "broken" different sentences. Both look
 * identical from the outside until you know whether the binary exists, and the fix for each is
 * nothing alike. The SOURCE column says where a usable one came from — the person's own install
 * (`host`) or the copy shipped inside this build (`bundled`) — and the last line names the one lotse
 * would start now.
 */

import { createInterface } from 'node:readline/promises';

import { _, fmt } from '../../i18n.ts';
import type { CommandModule } from 'yargs';

import {
  AgentInstallError,
  BUNDLED_AGENTS,
  DEFAULT_AGENT,
  LAUNCHERS,
  NO_AGENT_REMEDY,
  describeChoice,
  detectAgents,
  distFor,
  effectiveCatalog,
  gatherAgentFacts,
  installAgent,
  isInstalled,
  launcherIds,
  resolveAgent,
  type AgentCommand,
  type AgentDetection,
  type LotsePaths,
} from '@lotse/core';
import {
  parseChoiceSpec,
  readSettings,
  saveSettings,
  withAgent,
  type Settings,
} from '../../core/settings.ts';

import { err, out, pickArgv } from './output.ts';

const SOURCE_LABEL = { host: 'host', bundled: 'bundled', none: 'not found' } as const;

/** The table and the closing line, as text. Pure: the detections are an argument. */
export function agentsReport(
  launchers: readonly AgentCommand[],
  detections: readonly AgentDetection[],
  chosen: AgentDetection | null,
): string[] {
  const rows = [['AGENT', 'PROGRAM', 'SOURCE', 'STATE', 'COMMAND']];
  for (const launcher of launchers) {
    const found = detections.find((entry) => entry.id === launcher.id);
    rows.push([
      `${launcher.id === DEFAULT_AGENT ? '*' : ' '}${launcher.id}`,
      launcher.program,
      SOURCE_LABEL[found?.source ?? 'none'],
      found?.path ?? 'NOT FOUND',
      launcher.args.join(' '),
    ]);
  }
  // Header and rows share one width per column, taken from the data: STATE holds a full path whose
  // length nothing bounds. The marker rides inside the AGENT cell, so the header's cell is indented to match.
  rows[0]![0] = ` ${rows[0]![0]}`;
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  const lines = rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join(' ')
      .trimEnd(),
  );
  lines.push('');
  lines.push(
    chosen
      ? `lotse would use: ${chosen.id} (${SOURCE_LABEL[chosen.source]}, ${chosen.path}${chosen.version ? `, ${chosen.version}` : ''})`
      : `lotse would use: none — no agent is available — ${NO_AGENT_REMEDY}`,
  );
  return lines;
}

/** Where the setting lives and what it says, as text. Pure: the file's content is an argument. */
export function settingsReport(file: string, settings: Settings, problem: string | null): string[] {
  const lines = [`setting: ${settings.agent ? describeChoice(settings.agent) : 'none (host, else bundled)'}`];
  lines.push(`settings file: ${file}`);
  if (problem) lines.push(`settings problem: ${problem}`);
  return lines;
}

/** Ask on the terminal; anything but an explicit yes is a no, and so is a closed stdin. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes|j|ja)$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/**
 * `--install [id]`: fetch the pinned copy of a catalog agent into the data directory. The download is a
 * program, so the person is asked first with its size; `--yes` is the explicit way to skip the question.
 * Returns the exit code.
 */
async function installFromCatalog(paths: LotsePaths, id: string, yes: boolean): Promise<number> {
  const entry = BUNDLED_AGENTS.find((candidate) => candidate.id === id);
  if (!entry) {
    err(fmt(_('no agent called {id} in the catalog'), { id }));
    return 1;
  }
  if (isInstalled(entry, paths.dataDir)) {
    out(fmt(_('{title} {version} is already installed'), { title: entry.title, version: entry.version }));
    return 0;
  }
  const dist = distFor(entry);
  if (dist === null) {
    err(fmt(_('{title} has no download for this platform'), { title: entry.title }));
    return 1;
  }
  const megabytes = Math.round(dist.size / 1_000_000);
  const question = fmt(_('Download {title} {version} ({megabytes} MB) from {url}?'), {
    title: entry.title,
    version: entry.version,
    megabytes: String(megabytes),
    url: dist.url,
  });
  if (!yes && !(await confirm(question))) {
    err(_('nothing was downloaded; pass --yes to confirm without asking'));
    return 1;
  }
  try {
    const program = await installAgent(entry, paths.dataDir);
    out(fmt(_('installed {program}'), { program }));
    return 0;
  } catch (error) {
    err(
      error instanceof AgentInstallError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error),
    );
    return 1;
  }
}

const command = (paths: LotsePaths): CommandModule => ({
  command: 'agents',
  describe: _('list the agent launchers lotse knows how to start'),
  builder: (yargs) =>
    yargs
      .option('use', {
        type: 'string',
        describe: _('remember which agent to start: <id>, <id>:host, <id>:bundled, or none to clear'),
      })
      .option('install', {
        type: 'string',
        describe: _('download the pinned copy of a catalog agent for this user (default: opencode)'),
      })
      .option('yes', {
        type: 'boolean',
        describe: _('do not ask before downloading'),
      })
      .strict(),
  handler: async (argv) => {
    const file = paths.settingsFile;
    const install = pickArgv<string>(argv as Record<string, unknown>, 'install');
    if (install !== undefined) {
      const code = await installFromCatalog(
        paths,
        install === '' ? DEFAULT_AGENT : install,
        pickArgv<boolean>(argv as Record<string, unknown>, 'yes') === true,
      );
      if (code !== 0) {
        process.exitCode = code;
        return;
      }
    }
    const use = pickArgv<string>(argv as Record<string, unknown>, 'use');
    if (use !== undefined) {
      const parsed = parseChoiceSpec(use, launcherIds());
      if ('problem' in parsed) {
        err(parsed.problem);
        process.exitCode = 1;
        return;
      }
      try {
        const { backup } = saveSettings(file, withAgent(readSettings(file).settings, parsed.choice));
        if (backup) err(fmt(_('the earlier settings file was moved to {backup}'), { backup }));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        err(
          code ? `could not write ${file}: ${code}` : error instanceof Error ? error.message : String(error),
        );
        process.exitCode = 1;
        return;
      }
    }
    const { settings, problem } = readSettings(file);
    const catalog = effectiveCatalog(paths.dataDir);
    const facts = gatherAgentFacts(LAUNCHERS, undefined, undefined, catalog);
    const detections = detectAgents(facts, catalog);
    const { detection: chosen, note } = resolveAgent({
      setting: settings.agent,
      detections,
      catalog,
      bundledAvailable: (id) => facts.find((fact) => fact.id === id)?.bundledExists === true,
    });
    for (const line of agentsReport(LAUNCHERS, detections, chosen)) out(line);
    for (const line of settingsReport(file, settings, problem)) out(line);
    if (note) err(note);
    err(_('* the default for --agent'));
  },
});

export const agentsCommand = command;
