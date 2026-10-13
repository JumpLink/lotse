#!/usr/bin/env bash
# Extract translatable strings and compile the catalogues — for BOTH of lotse's domains.
#
#   dev/i18n.sh extract    refresh each po/<domain>.pot and merge it into every po/*.po
#   dev/i18n.sh compile    build app/dist/locale/<lang>/LC_MESSAGES/<domain>.mo
#
# Two domains, because lotse is an app AND a library — docs/adr/0005-two-gettext-domains.md:
#
#   eu.jumplink.Lotse   app/po/              ← app/src (the window, the CLI, the notifications)
#   lotse               packages/widget/po/  ← packages/core/src + packages/widget/src
#
# ONE xgettext invocation per domain covers TypeScript and Blueprint, which is not obvious: xgettext
# has no Blueprint parser at all (0.26 rejects `--language=Blueprint` outright), but Blueprint's
# `_("…")` and `C_("ctx", "…")` are lexically function calls -- exactly what the JavaScript scanner
# collects.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_DOMAIN='eu.jumplink.Lotse'
LIB_DOMAIN='lotse'
BUGS='https://github.com/JumpLink/lotse/issues'

# A generated `.d.blp.ts` holds the compiled template as a string literal, so scanning it would
# collect every widget msgid a second time under a path nobody edits. A `.test.ts` is not shipped.
sources() {
    local podir="$1"
    shift
    find "$@" -type f \( -name '*.ts' -o -name '*.blp' \) \
        -not -name '*.d.blp.ts' -not -name '*.test.ts' -not -name '*.spec.ts' |
        sort >"$podir/POTFILES.in"
}

extract() {
    local domain="$1" podir="$2"
    shift 2
    sources "$podir" "$@"
    # `--from-code` matters: without it xgettext refuses any non-ASCII msgid, and an English source
    # string is full of them the moment somebody writes an ellipsis or an em dash.
    xgettext \
        --files-from="$podir/POTFILES.in" \
        --output="$podir/$domain.pot" \
        --from-code=UTF-8 \
        --language=JavaScript \
        --keyword=_ \
        --keyword=_n:1,2 \
        --keyword=_p:1c,2 \
        --keyword=C_:1c,2 \
        --add-comments=TRANSLATORS \
        --package-name="$domain" \
        --msgid-bugs-address="$BUGS"
    while read -r lang; do
        [ -n "$lang" ] || continue
        # `--previous` keeps the old msgid next to a fuzzy match, which is the only thing that makes
        # a reworded string reviewable instead of guesswork.
        msgmerge --quiet --update --previous --backup=none "$podir/$lang.po" "$podir/$domain.pot"
    done <"$podir/LINGUAS"
    printf '%-20s %4s msgids  (%s)\n' "$domain" "$(grep -c '^msgid "' "$podir/$domain.pot")" "$podir"
}

compile() {
    local domain="$1" podir="$2"
    while read -r lang; do
        [ -n "$lang" ] || continue
        out="app/dist/locale/$lang/LC_MESSAGES"
        mkdir -p "$out"
        # `--check` refuses a catalogue whose format specifiers do not match its msgid: a `%s`
        # dropped in translation is a crash at the call site, not a cosmetic defect.
        msgfmt --check --output-file="$out/$domain.mo" "$podir/$lang.po"
        printf 'compiled %-20s %-3s -> %s\n' "$domain" "$lang" "$out/$domain.mo"
    done <"$podir/LINGUAS"
}

case "${1:-}" in
extract)
    extract "$APP_DOMAIN" app/po app/src
    extract "$LIB_DOMAIN" packages/widget/po packages/core/src packages/widget/src
    ;;
compile)
    compile "$APP_DOMAIN" app/po
    compile "$LIB_DOMAIN" packages/widget/po
    ;;
*)
    printf 'usage: %s <extract|compile>\n' "$0" >&2
    exit 2
    ;;
esac
