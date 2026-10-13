/**
 * The German catalogues load and the domains are bound — measured on the real gettext, which Node
 * does not have, so this is a GJS-only entry point rather than a case in the dual-run suite:
 *
 * ```sh
 * ./node_modules/.bin/gjsify workspace lotse-cli build   # compiles the .mo files
 * ./node_modules/.bin/gjsify build app/tests/probes/i18n-de.ts --app gjs --outfile app/dist/i18n-de.gjs.mjs
 * LANGUAGE=de LANG=de_DE.UTF-8 ./node_modules/.bin/gjsify run app/dist/i18n-de.gjs.mjs
 * ```
 *
 * It must sit under `app/dist/` so `initI18n()` finds `app/dist/locale`.
 */
import { _ as coreGettext } from '@lotse/core';

import { _, fmt } from '../../src/i18n.ts';
import { initI18n } from '../../src/i18n-gettext.ts';

const dir = initI18n();
const checks: [string, string, string][] = [
  ['app domain', _('Preferences'), 'Einstellungen'],
  ['library domain', coreGettext('Stop'), 'Stopp'],
  ['placeholders', fmt(_('Question {label}'), { label: '#A1' }), 'Frage #A1'],
];
let failed = 0;
for (const [name, got, want] of checks) {
  const ok = got === want;
  if (!ok) failed++;
  print(
    `${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (wanted ${JSON.stringify(want)})`}`,
  );
}
print(`locale dir: ${dir ?? 'none'}`);
imports.system.exit(failed === 0 ? 0 : 1);
