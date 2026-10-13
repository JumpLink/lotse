import { describe, expect, it } from '@gjsify/unit';

import { _, _n, fmt, setLibraryTranslator } from '@lotse/core';

export default async () => {
  await describe('i18n (core, runs on Node and GJS)', async () => {
    await it('returns the msgid when no translator is registered', async () => {
      setLibraryTranslator(null);
      expect(_('A string nobody translated')).toBe('A string nobody translated');
    });

    await it('fills {name} placeholders', async () => {
      expect(fmt('{a} and {b}', { a: 'x', b: 'y' })).toBe('x and y');
    });

    await it('picks the plural form by count', async () => {
      setLibraryTranslator(null);
      expect(_n('{n} model', '{n} models', 1)).toBe('{n} model');
      expect(_n('{n} model', '{n} models', 2)).toBe('{n} models');
    });

    await it('routes through a registered translator', async () => {
      setLibraryTranslator(
        Object.assign((s: string) => `<${s}>`, {
          plural: (s: string, p: string, n: number) => (n === 1 ? s : p),
          context: (_c: string, s: string) => s,
        }),
      );
      expect(_('Close')).toBe('<Close>');
      setLibraryTranslator(null);
    });
  });
};
