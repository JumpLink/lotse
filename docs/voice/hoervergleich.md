# Listening comparison: German voices

Step 2 of [ADR 0009](../adr/0009-voice-as-a-surface.md): which local voice is Lotse's default, and
whether Pocket is worth porting as a Spiel provider.

## Setup (2026-10-26)

- Fedora 44, Intel i9-10900K (20 threads), no GPU use.
- Spiel providers from Spiel's own Flatpak repo (`flatpak remote-add --user spiel
  https://project-spiel.org/flatpaks/spiel-repo.flatpakrepo`): `ai.piper.Speech.Provider` with the
  German voices below, and `org.espeak.Speech.Provider`.
- `libspiel` built from git (meson version 1.0.5, upstream's newest tag is `SPIEL_1_0_4`), used
  from GJS through `gi://Spiel`. Each sentence was synthesised into a WAV file through the
  speaker's `sink` property, so the times are synthesis times, not playback.

## Sentence catalogue

Fixed, public, no real data. It covers greetings, amounts, dates and times, `PR #107`, umlauts,
paths and versions, abbreviations, a question, a warning and a long answer of about 25 seconds.

1. Guten Morgen! Ich habe drei neue Nachrichten für dich gefunden.
2. Die Rechnung über 1.234,56 Euro ist am 15. März 2026 fällig.
3. Der Termin ist am Dienstag, den 3. November, um 19:00 Uhr, für 4 Personen.
4. Ich habe PR #107 geprüft: zwei Kommentare, ein fehlgeschlagener Test.
5. Über die Brücke führt ein schmaler Weg; Größe, Höhe und Länge stimmen.
6. Die Datei liegt unter docs/voice/hoervergleich.md, Version 0.5.1.
7. Das kostet ca. 12 % mehr als im Vorjahr, z. B. wegen der MwSt.
8. Kurz gesagt: Der Build ist grün. Allerdings dauert der Test auf arm64 noch 7 Minuten länger
   als auf x64, weil die Typelib dort erst gebaut werden muss. Soll ich den Cache aktivieren?
9. Achtung, das lässt sich nicht rückgängig machen. Willst du wirklich alle 27 Einträge löschen?
10. Zusammengefasst habe ich heute drei Dinge erledigt. Erstens habe ich die Stimmen installiert
    und getestet. Zweitens habe ich einen Satzkatalog geschrieben, der Zahlen, Daten, Beträge und
    Abkürzungen enthält. Drittens habe ich gemessen, wie lange jede Stimme bis zum ersten Ton
    braucht und wie schnell sie im Verhältnis zur Sprechdauer rechnet. Morgen geht es mit den
    Typen für gjsify weiter.

## Measured: size and speed

| Piper voice | Download | Real-time factor | Sentence 10 (~25 s audio) | First sentence after loading |
|---|---|---|---|---|
| `de_DE-eva_k-x_low` | 20 MB | 0.019 | 0.49 s | ~0.09 s |
| `de_DE-kerstin-low` | 61 MB | 0.034 | 0.43 s | ~1.1 s |
| `de_DE-ramona-low` | 61 MB | 0.034 | 0.52 s | ~1.1 s |
| `de_DE-thorsten-medium` | 61 MB | 0.027 | 0.56 s | ~0.09 s |
| `de_DE-thorsten-high` | 109 MB | 0.115 | 2.51 s | ~0.45 s |

Real-time factor = synthesis time / audio length, summed over all ten sentences. One run each,
not a benchmark.

What follows from it:

- Piper renders a whole utterance before the first sound. The time to first sound is therefore
  the synthesis time of the first sentence, which is why Lotse speaks sentence by sentence.
- Every `low` and `medium` voice stays far below the 2.5 s budget of ADR 0009 point 11, even for
  the long answer. `thorsten-high` needs 2.5 s for the long answer in one piece, so it only fits
  if answers are split into sentences.
- `eva_k-x_low` is the voice for weaker devices: 20 MB and the fastest.
- **Spiel's eSpeak provider lists no voices**: its D-Bus `Voices` property stays empty, even after
  `Init`. It is no fallback until that is fixed upstream.

## Open: what it sounds like

Speed decides nothing among these five, so the default comes down to how they sound. That needs a
human listener and is open:

- [ ] Rate the five Piper voices on sentences 2, 3, 6 and 7 (numbers, dates, paths, abbreviations)
      and on sentence 10 (does it stay pleasant over 25 seconds?).
- [ ] The same sentences through sprechstunde's A/B view: Pocket, Mistral, Kugel. Pocket is known
      to drop German digits (sprechstunde README), so sentences 2, 3 and 9 are the test.
- [ ] Decide the default voice and whether Pocket becomes a Spiel provider.

Until then, the proposed default is `thorsten-medium` (fast, 61 MB, no cold-start delay), with
`eva_k-x_low` for weaker devices.
