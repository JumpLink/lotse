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
     German voices), reached through `libspiel`'s GObject introspection from the app.
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

## Consequences

- Voice works with any ACP agent today, at the cost of a cascade's latency (sprechstunde measured
  ~1.8–2 s to first sound; a coding agent with tools is slower).
- Lotse gains a keyring dependency and a secret it must never log or put in `--json` output.
- Pocket is the first local engine and runs on this machine, not on a server. It is too large to
  ship in the base package (Python + PyTorch, ~1.5 GB with weights), so it is **installed on
  request**: an optional Flatpak extension, and outside Flatpak a per-user install the way
  [ADR 0006](0006-per-user-agent-install.md) installs the pinned agent. The alternative to weigh
  first: Pocket as a **Spiel speech provider** (`libspeechprovider`). No such provider exists
  (checked 2026-10-26: Spiel ships Piper, eSpeak and Mimic 3), but one would serve every Spiel app
  (Orca too), and Lotse would need no Pocket-specific install path. Spiel's Flatpak repo is its own,
  not Flathub, and last moved in 2025-12; that maintenance risk is part of the choice. Lotse starts it as a
  subprocess on a local port and stops it with the session. The `pocket` provider also accepts a
  server URL, so a weaker device can use a Pocket server elsewhere or pick a cloud voice.
- Whether Pocket is the best local voice is not measured yet: sprechstunde has a speed and memory
  measurement, but no German quality comparison. A listening comparison (sprechstunde's settings
  UI has an A/B view) decides the default before the extension is built.
- When an agent starts to advertise audio, Lotse uses it without a code change. For opencode an
  `Upstream (opencode, file by hand)` issue in this repo records the request.
- Hands-free conversation needs voice activity detection, barge-in and echo cancellation
  (`webrtcdsp` or PipeWire's echo-cancel module). That is the hard part on a desktop and comes last.

## Order of work

1. Architecture doc `docs/architecture/voice.md`: components, settings schema, provider contract,
   keyring entries.
2. **Read aloud:** `TextToSpeech`, providers `pocket`, `mistral`, `kugel`, sentence streaming,
   playback, play agent audio blocks.
3. **Dictation:** a microphone button, `SpeechToText` with `mistral`, ACP audio when advertised.
4. **Hands-free:** VAD, barge-in, echo cancellation.
5. **Local engines installed on request:** Pocket first (Flatpak extension or per-user install),
   then whisper.cpp.
