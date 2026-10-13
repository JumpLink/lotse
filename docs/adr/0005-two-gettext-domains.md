# 5. Two gettext domains: the app's and the library's

- Status: **Accepted**
- Date: 2026-10-12
- Deciders: Pascal Garber
- Related: [ADR 0001](0001-lotse-as-an-embeddable-widget.md) (the split this follows),
  [docs/embedding.md](../embedding.md) (what a host does with it)

## Context

Every app of the suite is multilingual: gettext, English msgids, a German catalogue. lotse is the
first of them that is **also a library**. `@lotse/widget` renders a conversation inside somebody
else's window, and `@lotse/core` writes the sentences it renders — so lotse's strings have to be
translated in a process lotse does not own.

gettext has exactly one global default domain per process. `textdomain("eu.jumplink.Steuererklaerung")`
is what a host calls at startup, and after that:

- a bare `gettext()` in lotse's code looks up **the host's** catalogue, where no lotse msgid exists;
- every `translatable="yes"` string out of a `.blp` is resolved **inside GtkBuilder**, which uses the
  interface's own `domain` attribute and falls back to the default domain — so the widget's
  Blueprint strings land in the host's catalogue too.

Both failures are silent: gettext answers a miss with the msgid, which is correct English. A German
host would show a German window with an English chat in it, and nothing anywhere would say so.

## Decision

1. **Two domains, and the library has its own.** The app's domain is its application id,
   `eu.jumplink.Lotse`; the domain of `@lotse/core` + `@lotse/widget` is the literal **`lotse`**.
   A package name is not available at runtime and an application id would be a lie in a host's
   process, so the library's domain is a short constant — `LOTSE_TEXT_DOMAIN` in
   `packages/core/src/i18n.ts`, the one place it is written.
2. **The library never calls `textdomain`, only `dgettext`.** `packages/widget/src/i18n.ts` binds
   `lotse` with `bindtextdomain` and registers a translator that is `dgettext`-bound to it. The
   process default stays whatever the host set. lotse's own app calls `initLocale` with the *app*
   domain, so its `textdomain` and the library's `dgettext` do not compete.
3. **Blueprint pins the domain in the file.** Each `.blp` under `packages/widget/src` declares
   `translation-domain "lotse";`, which compiles to `<interface domain="lotse">`. That is the only
   way a widget's Blueprint string survives a host's `textdomain`, and it is one line per file
   rather than a rule somebody has to remember at every call site.
4. **The core has no gettext import at all.** `@lotse/core` runs on Node — that dual run is the
   point of the package split — and GJS's `gettext` module does not exist there. So core declares
   `_`, `_n`, `_p` and `fmt` over a **registered** translator that starts as the identity, and
   `@lotse/widget` registers the real one when it loads. Until something registers, every lookup
   returns its msgid: correct English, which is what an untranslated application is supposed to do.
   `_` is also the keyword `dev/i18n.sh` collects, so a core msgid lands in the catalogue like any
   widget one.
5. **The `.po` files ship in the packages; the `.mo` files are the host's to install.** A compiled
   catalogue belongs in a locale directory, and only the host knows where its own is — `/usr/share/locale`,
   a Flatpak's `/app/share/locale`, a `dist/locale` in a build tree. So `packages/widget` ships
   `po/` (the `.pot` and every `.po`) in its npm `files`, and a host compiles them into its own
   locale directory with one `msgfmt` per language. [docs/embedding.md](../embedding.md) has the
   three lines; lotse's own `i18n:compile` does exactly the same thing into `app/dist/locale`.

   *Weighed:* shipping prebuilt `.mo` files in the tarball. Rejected — a `.mo` is a build artefact
   of a text file we already ship, it would have to be regenerated on every string change anyway,
   and it still would not be in a directory gettext looks in.

## Consequences

- A host gets German chat strings for **one** build step (`msgfmt` per language into the locale
  directory it already has), and nothing else: no `textdomain` call, no domain name in its code, no
  change to how it calls the widget. Without that step it gets correct English.
- A string added to `@lotse/core` or `@lotse/widget` must go through `_()`; `dev/check-i18n.js`
  fails the build when the committed catalogues and the sources disagree.
- Two `po/` directories: `app/po/` for `eu.jumplink.Lotse` (sources under `app/src`) and
  `packages/widget/po/` for `lotse` (sources under `packages/core/src` and `packages/widget/src`).
  The library catalogue lives in the widget rather than in core because the widget is the package a
  host installs and the package that binds the domain — core arrives with it either way.
- Log lines, protocol strings and the ACP wire stay English and unwrapped. A translated log is a log
  nobody can search, and a translated protocol string is a bug.
