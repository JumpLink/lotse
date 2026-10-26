/**
 * The `lotse` binary.
 *
 * The yargs chrome is copied from curlew's entrypoint, including the three comments that explain
 * the non-obvious options — they are not decoration, each one fixes a failure that a plain yargs
 * setup produces *on GJS specifically*:
 *
 * - `strictCommands()`, because an unmatched command on GJS leaves the main loop running forever
 *   (a hang), where on Node it would exit 0. Two different bugs for one typo.
 * - `locale('en')`, because yargs otherwise translates its own chrome from `$LANG` while every
 *   `describe` string stays English, so a German shell got a half-German help screen.
 * - `fail(false)` plus the `try`/`catch` around `parse()`, because yargs can throw
 *   synchronously for a nested `demandCommand` failure; on GJS that surfaces as an opaque "Module
 *   threw an exception" and the hint would be printed twice.
 */

import './i18n-gettext.ts';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  agentsCommand,
  answerCommand,
  runCommand,
  statusCommand,
  tasksCommand,
  authCommand,
  cancelCommand,
  loginCommand,
  messengerCommand,
  providerCommand,
  questionsCommand,
  resumeCommand,
  serveCommand,
  sessionsCommand,
  startCommand,
} from './frontends/cli/index.ts';
import { gjsMainLoop, runMain } from './core/main.ts';
import { migratedPaths } from './core/migrate.ts';
import { servePaths } from './core/paths.ts';

// The one place the process environment becomes paths; everything below is handed them. The
// one-time move from the directories lotse wrote happens here too (`core/migrate.ts`), and its
// notes go to stderr: a directory that moved — or could not be moved — is something *about* the
// answer, never the answer a pipe is reading.
const { paths, notes } = migratedPaths();
const serve = servePaths();
for (const note of notes) console.error(`lotse: ${note}`);

function reportError(err: unknown): void {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

const parseArgs = () =>
  yargs(hideBin(process.argv))
    .command(startCommand(paths))
    .command(sessionsCommand(paths))
    .command(resumeCommand(paths))
    .command(cancelCommand(paths))
    .command(authCommand(paths))
    .command(loginCommand(paths))
    .command(providerCommand(paths))
    .command(agentsCommand(paths))
    .command(messengerCommand(paths))
    .command(serveCommand(paths, serve))
    .command(questionsCommand(paths, serve))
    .command(answerCommand(paths, serve))
    .command(runCommand(paths, serve))
    .command(tasksCommand(paths, serve))
    .command(statusCommand(paths, serve))
    .demandCommand(1, 'Please provide a command — `lotse --help` lists them all.')
    .strictCommands()
    .scriptName('lotse')
    .locale('en')
    .help()
    .fail(false)
    .exitProcess(false)
    .parseAsync();

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs();
} catch (err) {
  // yargs threw instead of rejecting — see the note in the file header.
  reportError(err);
  process.exit(1);
}

// No top-level `await`: on GJS it makes the entry module spin a core while a command only waits.
runMain(parsed, {
  loop: gjsMainLoop(),
  exit: (code) => process.exit(code),
  report: reportError,
  exitCode: () => (typeof process.exitCode === 'number' ? process.exitCode : undefined),
});
