/**
 * Binds gettext for the app — the only app file that imports it.
 *
 * Split from `i18n.ts` because `gettext` does not exist on Node, and every app-core module that
 * translates imports `i18n.ts`: with the binding in there the Node half of the dual test run died on
 * `@gjsify/node-gi`. Entry points import this file first; everything else imports `i18n.ts`.
 *
 * **Two domains, and this file binds both** ([ADR 0005](../../docs/adr/0005-two-gettext-domains.md)):
 *
 *   · `eu.jumplink.Lotse` — the window, the CLI and the notifications, i.e. everything under
 *     `app/src`. It becomes the process's *default* domain through `textdomain`, which is what
 *     GtkBuilder uses for every `translatable="yes"` string out of `window.blp` — there is no call
 *     site in that path where this app could pass a domain name.
 *   · `lotse` — the strings `@lotse/core` and `@lotse/widget` wrote. The widget binds this itself
 *     when it loads, for a host's sake; the CLI never loads the widget and still renders core's
 *     sentences, so the binding is repeated here. Registering twice is registering the same thing.
 *
 * **Not `@gjsify/adwaita-app`'s `initLocale`, although it does exactly this.** Its barrel imports
 * `Adw`, so the CLI bundle would grow GTK and libadwaita — and `main.ts`'s header records what that
 * costs: a `lotse sessions` over SSH loading a toolkit and dying. The GUI could have used it and the
 * CLI could not, and two surfaces binding their locale two different ways is the bug with two faces.
 *
 * **Call `initI18n()` once, before anything is built.** A label already realised keeps the string it
 * was given, and a yargs `describe` is read while the parser is built.
 *
 * Which language: `setlocale(LC_ALL, "")` reads the usual POSIX chain — `LANGUAGE` (a priority list,
 * ignored while the locale itself is `C`), then `LC_ALL`, `LC_MESSAGES`, `LANG`. A `de_*` session
 * gets `de.po`, everything else English.
 *
 * Missing catalogue is not an error state: `dgettext` returns the msgid, and the msgids are the
 * English source text.
 */

import Gettext from 'gettext';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOTSE_TEXT_DOMAIN, setLibraryTranslator } from '@lotse/core';

import { TEXT_DOMAIN, setAppTranslator } from './i18n.ts';

/**
 * Bind both domains and make {@link TEXT_DOMAIN} the default. Returns the bound directory, or
 * `undefined` when there is none — a diagnostic line, never a lookup.
 */
export function initI18n(): string | undefined {
  Gettext.setlocale(Gettext.LocaleCategory.ALL, '');
  const dir = localeDir();
  if (dir !== undefined) {
    Gettext.bindtextdomain(TEXT_DOMAIN, dir);
    Gettext.bindtextdomain(LOTSE_TEXT_DOMAIN, dir);
  }
  // The default domain, for GtkBuilder. The library's stays a `dgettext` argument — binding it as
  // the default instead would translate the chat and leave the window around it English.
  Gettext.textdomain(TEXT_DOMAIN);
  setLibraryTranslator(
    Object.assign((msgid: string) => Gettext.dgettext(LOTSE_TEXT_DOMAIN, msgid), {
      plural: (singular: string, plural: string, n: number) =>
        Gettext.dngettext(LOTSE_TEXT_DOMAIN, singular, plural, n),
      context: (context: string, msgid: string) => Gettext.dpgettext(LOTSE_TEXT_DOMAIN, context, msgid),
    }),
  );
  setAppTranslator(
    Object.assign((msgid: string) => Gettext.dgettext(TEXT_DOMAIN, msgid), {
      plural: (singular: string, plural: string, n: number) =>
        Gettext.dngettext(TEXT_DOMAIN, singular, plural, n),
      context: (context: string, msgid: string) => Gettext.dpgettext(TEXT_DOMAIN, context, msgid),
    }),
  );
  return dir;
}

/**
 * Where the catalogues are: what the launcher exported, else the build tree, else the system.
 *
 * `GJSIFY_LOCALE_DIR` is set by the `gjsify ship` launcher, which is the only party that knows
 * whether the payload became `/usr`, a `--prefix` tree or `/app`. `gjsify run app/dist/…` sets
 * nothing, so without the `dist/locale` step a German developer sees every converted string in
 * English while the shipped package is correct. Checked for existence, so an installed copy without
 * a build tree keeps the system default.
 */
function localeDir(): string | undefined {
  const fromLauncher = process.env['GJSIFY_LOCALE_DIR'];
  if (fromLauncher) return fromLauncher;
  const dev = devLocaleDir();
  if (dev !== undefined) return dev;
  // Linux only. There is no `/usr/share/locale` on Windows, and on macOS it holds Apple's own data
  // and never an application's catalogues — `@gjsify/adwaita-app`'s `systemLocaleDir` records why
  // binding it there is worse than binding nothing.
  return process.platform === 'darwin' || process.platform === 'win32' ? undefined : '/usr/share/locale';
}

/** `app/dist/locale` when a bundle runs straight from the build tree, else `undefined`. */
function devLocaleDir(): string | undefined {
  const fileUrl = import.meta.url;
  if (!fileUrl.startsWith('file:') || !fileUrl.includes('/dist/')) return undefined;
  // bundled: app/dist/lotse.gjs.mjs or app/dist/lotse-app.gjs.mjs → app/dist/locale
  const dir = join(dirname(fileURLToPath(fileUrl)), 'locale');
  return existsSync(dir) ? dir : undefined;
}

// Bound on first import, so a module that translates while it is evaluated (a yargs `describe` is
// one) never runs ahead of the binding.
initI18n();
