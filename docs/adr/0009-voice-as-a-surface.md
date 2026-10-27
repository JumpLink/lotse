# 9. Voice as a surface

- Status: **Proposed**
- Date: 2026-10-26
- Deciders: Pascal Garber
- Related: [vision](../vision.md), [ADR 0007](0007-profiles-tasks-triggers.md) (profiles),
  [issue #89](https://github.com/JumpLink/lotse/issues/89) (voice mode),
  [ACP content blocks](https://agentclientprotocol.com/protocol/content), [Logging in](../login.md)

## Context

Issue #89 asks for dictation, read-aloud and a hands-free conversation around whatever agent and
model is selected. The owner's phone assistant (sprechstunde, Node + LiveKit) already runs a
STT → LLM → TTS cascade in production with Mistral and KugelAudio, and has tried Kyutai Pocket TTS
on the CPU. Its Pocket server (`deploy/pocket-tts/server.py`) speaks plain HTTP: `POST /tts`
streams 16-bit PCM at 24 kHz, `POST /sessions` reserves a worker, 503 means "all busy".

Measurements on 2026-10-26:

- **opencode has no voice feature.** Its `acp` mode answers `initialize` with
  `promptCapabilities: {"embeddedContext":true,"image":true}`, so it accepts no audio.
- **ACP knows audio only as content.** A prompt may carry `{"type":"audio","mimeType","data"}`
  when the agent advertises `promptCapabilities.audio`. Content blocks may also appear in
  `session/update`. ACP has no streaming voice channel, no turn detection and no barge-in.
  `@lotse/acp` already has the types (`AudioContent`, `PromptCapabilities.audio`) and renders an
  agent's audio block as `[audio]`.
- **The agent's credentials are not ours to read.** opencode stores provider keys itself
  ([login.md](../login.md)); Lotse has no secret store. Chat providers are also not speech
  providers: a Mistral key in opencode gives opencode chat, not Voxtral transcription or Mistral
  TTS.

## Decision

1. **Voice is a surface, not an agent and not a mode.** Like the window, the widget and the
   messenger, it wraps the same ACP session: speech in front, speech behind. The thinking stays
   with the selected agent and model. Nothing in Lotse becomes a "voice agent".
2. **A fast, speakable setup is a profile.** Voice uses an ordinary profile (ADR 0007), for
   example one with a fast model, few or no MCP servers and a preamble asking for short answers
   that read well aloud. No new concept is added.
3. **Two interfaces in `@lotse/core`: `SpeechToText` and `TextToSpeech`.** Pure, no `gi://`;
   providers are plain HTTP/WebSocket clients or local subprocesses, the way Lotse already starts
   agents. Capture and playback (GStreamer over PipeWire) live in the app. First providers:
   - TTS: `pocket` (a configurable server URL, compatible with sprechstunde's server), `mistral`,
     `kugel`, and `spiel`: any voice installed for GNOME's [Spiel](https://project-spiel.org)
     speech-provider standard (D-Bus providers, voices as Flatpak extensions, e.g. Piper with
     German voices), reached through the Web Speech API's `speechSynthesis` that gjsify provides
     (point 12).
   - STT: `mistral` (Voxtral); a local engine (whisper.cpp) later.
4. **Engines are a device setting, not a profile field.** Whether Pocket runs depends on the
   machine, so provider, model, voice and server URL sit in Lotse's settings, with a fallback voice
   as in sprechstunde. A profile may only **narrow** it: `voice: "local-only"` forbids cloud
   engines for that profile. A host app may do the same through its policy, as with free models.
5. **ACP audio is the second path, chosen per agent.** If the agent advertises
   `promptCapabilities.audio`, Lotse may send the recording as an audio block and skip its own STT;
   the agent's model then listens, with the agent's credentials. STT therefore sits behind a seam
   the pipeline can bypass. An audio block in an agent's answer is played instead of shown as
   `[audio]`, and Lotse's TTS speaks only the text. ACP has no speech output, so TTS always stays
   with Lotse.
6. **Cloud speech keys go into the desktop keyring (libsecret), never into a file.** This is the
   first secret Lotse keeps. It amends the "no secret tier" rule in [login.md](../login.md) for
   speech providers only; chat keys keep going to the agent. Local engines and ACP audio need no
   key, so the person enters a cloud key at most once, for Lotse.
7. **Privacy follows the free-model rule.** Cloud STT/TTS and ACP audio send the voice to another
   vendor: Lotse warns once per vendor, and a host or profile can block it (point 4).
8. **A permission request stays a click.** A spoken "yes" is too easy to mishear.
9. **Numbers are spelled out before a TTS that drops them** (Pocket does, for German). The
   provider declares it; Lotse ports the idea of sprechstunde's `spoken-numbers.ts`, not its code.
10. **No shared package with sprechstunde yet.** Different runtimes (Node + LiveKit vs GJS). A
    vendor-neutral package comes only when both need the same core.
11. **Latency target:** first sound ≤ 2.5 s after the person stops speaking, with a voice profile
    and no tool call. Lotse speaks each sentence as soon as the agent has streamed it and
    announces tool calls briefly instead of going silent. Code, diffs and tables are shown, not
    read.
12. **Spiel is the standard for local voices.** Lotse installs no TTS engine of its own: a local
    voice is a Spiel speech provider with its voices, installed through Spiel's Flatpaks or the
    distribution. A local engine Spiel lacks, such as Pocket, is added as a Spiel provider, which
    every Spiel app (Orca too) then gets. Lotse does not bind Spiel itself: gjsify provides the
    W3C Web Speech `speechSynthesis` backed by `libspiel` (`@gjsify/speech-synthesis`), and
    bundles `libspiel` with its typelib as a prebuild (`@gjsify/spiel-native`, the
    `gamepad-native` pattern), because neither Fedora nor the GNOME runtimes ship it. A system
    `libspiel` takes precedence. `@lotse/core` keeps only what is Lotse's own: `speakableText()`,
    the sentence chunker and the `voice` policy. `LotseChat` takes an optional object shaped like
    `speechSynthesis` from its host, so the widget is tested against a fake and runs in a browser
    unchanged. Steuererklärung passes `speechSynthesis` with `voice: "local-only"`.

## Consequences

- Voice works with any ACP agent today, at the cost of a cascade's latency (sprechstunde measured
  ~1.8–2 s to first sound; a coding agent with tools is slower).
- Lotse gains a keyring dependency and a secret it must never log or put in `--json` output.
- Local voices work on this machine without anything Lotse-specific to install. A weaker device
  picks a smaller Spiel voice (Piper's `x_low` voices, 20 MB), a Pocket server elsewhere through
  the `pocket` URL, or a cloud voice. Spiel's eSpeak provider listed no voices when measured on
  2026-10-26, so it is no fallback yet.
- Reading aloud in the app waits for a gjsify release with `@gjsify/speech-synthesis`. Core and
  widget do not: they are built and merged against a fake first.
- Spiel ships providers for Piper, eSpeak and Mimic 3 (checked 2026-10-26), not on Flathub but
  from its own Flatpak repo, whose providers last moved in 2025-12. Lotse depends on that
  small project; a Spiel provider for Pocket would be a contribution to it as well.
- Pocket is large (Python + PyTorch, ~1.5 GB with weights) and is ported only if the listening
  comparison shows it is worth it: the existing Spiel voices (Piper's German ones first) against
  Pocket, Mistral and Kugel. sprechstunde has measured Pocket's speed and memory, but nobody has
  compared German quality yet.
- When an agent starts to advertise audio, Lotse uses it without a code change. For opencode an
  `Upstream (opencode, file by hand)` issue in this repo records the request.
- Hands-free conversation needs voice activity detection, barge-in and echo cancellation
  (`webrtcdsp` or PipeWire's echo-cancel module). That is the hard part on a desktop and comes last.

## Order of work

1. Architecture doc `docs/architecture/voice.md`: components, settings schema, provider contract,
   keyring entries.
2. **Listening comparison** of German voices: Spiel providers that exist (Piper first), Pocket
   through sprechstunde's server, Mistral, Kugel. It sets the default voice. Measured part:
   [voice/hoervergleich.md](../voice/hoervergleich.md).
3. **Spiel in gjsify:** `@girs/spiel-1.0` in ts-for-gir, `@gjsify/spiel-native` and
   `@gjsify/speech-synthesis` with their own gjsify ADR, then a release.
4. **Read aloud:** `speakableText()`, sentence chunker and `voice` policy in `@lotse/core`; the
   `speech` option in `LotseChat` against a fake; the app passes `speechSynthesis` after the
   gjsify release. Then `mistral`, `kugel` and `pocket` (URL), and agent audio blocks.
5. **Dictation:** a microphone button, `SpeechToText` with `mistral`, ACP audio when advertised.
6. **Hands-free:** VAD, barge-in, echo cancellation.
7. **Pocket as a Spiel provider** if step 2 says so; whisper.cpp for local dictation.
