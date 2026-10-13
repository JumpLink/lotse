/**
 * Translation for the strings `@lotse/core` and `@lotse/widget` hand to a person.
 *
 * **English is the source language.** Every msgid in this repository is English and German arrives
 * as a catalogue (`packages/widget/po/de.po`). That direction is the one a stranger can read, and
 * the one gettext is built for: a lookup that resolves nothing returns its msgid, so a missing
 * catalogue is correct English rather than an empty label.
 *
 * **No gettext import here, and that is structural.** `@lotse/core` runs on Node as well as on GJS
 * — the dual test run is the whole point of the package split (`AGENTS.md`) — and GJS's built-in
 * `gettext` module does not exist on Node. So this file declares the four call sites and nothing
 * else: a translator is *registered* by whoever has one. `@lotse/widget`'s `i18n.ts` does it on
 * load (see [ADR 0005](../../../docs/adr/0005-two-gettext-domains.md)), which is what makes a host
 * get German chat strings without writing a line.
 *
 * **Call `_()` where the string is BUILT, never at module level.** A module-level call runs before
 * anything could have registered, and the English it captured then would outlive the catalogue.
 * The table-shaped cases in here (`permission.ts`'s kind words, `tool-line.ts`'s statuses) are
 * therefore functions rather than frozen objects.
 */

/**
 * The gettext domain of `@lotse/core` + `@lotse/widget`.
 *
 * A literal and not an application id: these strings are rendered inside *somebody else's* process,
 * whose `textdomain` is its own. ADR 0005 has the failure this avoids.
 */
export const LOTSE_TEXT_DOMAIN = 'lotse';

/** A domain-bound lookup, the shape `@gjsify/adwaita-app`'s `Translator` already has. */
export interface LibraryTranslator {
  (msgid: string): string;
  /** `n`-aware lookup. Pass the untranslated singular and plural. */
  plural(singular: string, plural: string, n: number): string;
  /** Disambiguating lookup, for a msgid whose meaning depends on where it appears. */
  context(context: string, msgid: string): string;
}

/**
 * What every lookup does until something registers: hand the msgid back.
 *
 * The plural rule here is English's, which is what gettext itself falls back to for a domain with
 * no catalogue. It is a fallback, never a decision — the real rule is a property of the target
 * language and lives in the catalogue's `Plural-Forms`.
 */
const IDENTITY: LibraryTranslator = Object.assign((msgid: string) => msgid, {
  plural: (singular: string, plural: string, n: number) => (n === 1 ? singular : plural),
  context: (_context: string, msgid: string) => msgid,
});

let translate: LibraryTranslator = IDENTITY;

/**
 * Register the translator for {@link LOTSE_TEXT_DOMAIN}; `null` restores the identity.
 *
 * Called once by `@lotse/widget` when it loads. A host does not call it — and an application that
 * wanted to route lotse's strings through its own catalogue could, which is the one reason this is
 * exported rather than internal.
 */
export function setLibraryTranslator(translator: LibraryTranslator | null): void {
  translate = translator ?? IDENTITY;
}

/** The registered translator, for a diagnostic or a test that wants to restore it. */
export function libraryTranslator(): LibraryTranslator {
  return translate;
}

/**
 * Mark a msgid that has to stay a constant (an exported one, or one a test compares against) and
 * translate it where it is shown: `_(CONSTANT)`. Identity at run time; `dev/i18n.sh` collects it.
 */
export function N_(msgid: string): string {
  return msgid;
}

/** Translate one string. */
export function _(msgid: string): string {
  return translate(msgid);
}

/**
 * Translate a counted string, letting the target language pick its own plural form.
 *
 * Never build this from an `n === 1` check at the call site: German agrees with English here, but
 * the rule belongs to the language and therefore to the catalogue.
 */
export function _n(singular: string, plural: string, n: number): string {
  return translate.plural(singular, plural, n);
}

/**
 * Translate with a disambiguating context, for one English word that is two different German ones —
 * which a translator cannot resolve from the string alone.
 */
export function _p(context: string, msgid: string): string {
  return translate.context(context, msgid);
}

/**
 * Fill `{name}` placeholders in an already translated string.
 *
 * Named and not `%s`, so a translation can reorder them — German puts the verb last and the count
 * elsewhere than English. `dev/check-i18n.js` verifies that every msgstr keeps the msgid's names,
 * because a dropped placeholder is a sentence with a hole in it and gettext will not notice.
 *
 * The same substitution `messenger/strings.ts`'s `msg` does, and now the only one: that file's
 * header said switching on gettext would be "this one function and a catalogue", and this is it.
 */
export function fmt(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}
