/**
 * The library's own gettext domain, bound here so a host does not have to know it exists.
 *
 * [ADR 0005](../../../docs/adr/0005-two-gettext-domains.md): `@lotsman/core` and `@lotsman/widget` speak
 * the domain `lotsman`, never the process's default one. A host sets its own `textdomain` at startup,
 * and a bare `gettext()` in here would then look up a catalogue with no lotsman msgid in it — silently,
 * because gettext answers a miss with the msgid, which is correct English. A German host would show
 * a German window with an English chat in it.
 *
 * So: `bindtextdomain('lotsman', …)` and a translator that is `dgettext`-bound to it. The default
 * domain is never touched. The widget's Blueprint strings do the same thing one layer down, through
 * `translation-domain "lotsman";` in each `.blp` — GtkBuilder resolves those inside GTK, where no call
 * site of ours could pass a domain name.
 *
 * **Binding happens when this module loads**, which is what makes a host's "nothing to do" true:
 * importing `@lotsman/widget` is the host's only act. {@link initWidgetI18n} is exported for a test
 * and for a host that compiles its catalogues somewhere unusual.
 *
 * This file imports GJS's built-in `gettext`, so it is GJS-only — like every other file in this
 * package. `@lotsman/core` stays importable on Node because the lookup it calls is the *registered*
 * one (`core/i18n.ts`), which is the identity until this runs.
 */

import Gettext from 'gettext';

import { LOTSMAN_TEXT_DOMAIN, hasLibraryTranslator, setLibraryTranslator } from '@lotsman/core';

/**
 * Bind {@link LOTSMAN_TEXT_DOMAIN} and register its translator with `@lotsman/core`.
 *
 * `localeDir` wins when given; otherwise `GJSIFY_LOCALE_DIR` (what a `gjsify ship` launcher exports),
 * then the platform's system directory. Nothing to bind is not an error — every lookup then returns
 * its msgid, which is what an untranslated application is supposed to do.
 *
 * Idempotent: a second call rebinds the same domain and replaces the same translator.
 */
export function initWidgetI18n(localeDir?: string): string | undefined {
  const dir = localeDir ?? process.env['GJSIFY_LOCALE_DIR'] ?? systemLocaleDir();
  if (dir !== undefined) Gettext.bindtextdomain(LOTSMAN_TEXT_DOMAIN, dir);
  setLibraryTranslator(
    Object.assign((msgid: string) => Gettext.dgettext(LOTSMAN_TEXT_DOMAIN, msgid), {
      plural: (singular: string, plural: string, n: number) =>
        Gettext.dngettext(LOTSMAN_TEXT_DOMAIN, singular, plural, n),
      context: (context: string, msgid: string) => Gettext.dpgettext(LOTSMAN_TEXT_DOMAIN, context, msgid),
    }),
  );
  return dir;
}

/**
 * `/usr/share/locale` on Linux, nothing on macOS or Windows.
 *
 * Not a constant: `/usr/share/locale` does not exist on Windows, and on macOS it exists and holds
 * Apple's own data rather than an application's catalogues — so binding it there reports a plausible
 * path that can never resolve a msgid. `@gjsify/adwaita-app`'s `systemLocaleDir` records the
 * measurement; this is the same answer without that package's `Adw` import.
 */
function systemLocaleDir(): string | undefined {
  return process.platform === 'darwin' || process.platform === 'win32' ? undefined : '/usr/share/locale';
}

// An app that bound the domain before this module loaded (lotsman's own does) keeps its binding:
// rebinding here would point the domain at the system directory and show English in a dev build.
if (!hasLibraryTranslator()) initWidgetI18n();
