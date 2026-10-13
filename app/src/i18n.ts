/**
 * The app's translation calls — pure, so app-core modules stay importable on Node.
 *
 * Without a registered translator every call returns its msgid, which is the English source text.
 * `i18n-gettext.ts` registers the real gettext-backed one; the entry points import it first.
 * [ADR 0005](../../docs/adr/0005-two-gettext-domains.md) records the two domains.
 */

import { fmt as coreFmt } from '@lotse/core';

/** The app's gettext domain: the literal application id, not `APP_ID` (a devtools instance may override that). */
export const TEXT_DOMAIN = 'eu.jumplink.Lotse';

export interface AppTranslator {
  (msgid: string): string;
  plural(singular: string, plural: string, n: number): string;
  context(context: string, msgid: string): string;
}

const IDENTITY: AppTranslator = Object.assign((msgid: string) => msgid, {
  plural: (singular: string, plural: string, n: number) => (n === 1 ? singular : plural),
  context: (_context: string, msgid: string) => msgid,
});

let translate: AppTranslator = IDENTITY;

export function setAppTranslator(translator: AppTranslator | null): void {
  translate = translator ?? IDENTITY;
}

/** Translate one string. */
export function _(msgid: string): string {
  return translate(msgid);
}

/** Translate a counted string; the target language picks its own plural form. */
export function _n(singular: string, plural: string, n: number): string {
  return translate.plural(singular, plural, n);
}

/** Translate with a disambiguating context, for one English word that is two different German ones. */
export function _p(context: string, msgid: string): string {
  return translate.context(context, msgid);
}

/** Fill `{name}` placeholders in an already translated string. `@lotse/core`'s `fmt`, re-exported. */
export const fmt = coreFmt;
