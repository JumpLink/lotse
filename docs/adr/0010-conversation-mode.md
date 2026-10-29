# 10. Conversation mode

- Status: **Proposed**
- Date: 2026-10-29
- Deciders: Pascal Garber
- Related: [ADR 0009](0009-voice-as-a-surface.md) (voice as a surface, amended here),
  [speech recognition measurement](../voice/spracherkennung.md),
  [issue #89](https://github.com/JumpLink/lotse/issues/89),
  [Stamped's semantic search](https://github.com/correctiv/stamped) (the machine-fit pattern)

## Context

ADR 0009 makes voice a surface and builds read-aloud first; hands-free conversation is its last
step. The owner wants that conversation as the goal, not a speaker button: Lotse notices when the
person has stopped speaking and answers, as the phone assistant sprechstunde does with Silero VAD
(300 ms silence), LiveKit's turn detector and Voxtral in the cloud.

Three things differ from sprechstunde:

- **The agents are slow.** sprechstunde talks to a fast model directly. Lotse talks to coding
  agents that call tools for seconds or minutes.
- **Recognition must be able to run locally.** A profile with `voice: "local-only"`
  (Steuererklärung) must never send speech to a cloud.
- **The machine varies.** A desktop with a free GPU, a laptop on battery and a desktop whose GPU is
  busy with something else need different engines.

The measurement of 2026-10-28 ([spracherkennung.md](../voice/spracherkennung.md)), taken while
another program held the GPU: whisper.cpp `large-v3-turbo` on Vulkan 412 ms at 7 % WER; on the
CPU, parakeet-tdt-0.6b-v3 240 ms at 12 % and a German streaming zipformer 32 ms at 15 %. whisper.cpp
on the CPU misses 500 ms from `small` up, and Voxtral does not transcribe locally. Every engine
mishears the project's own words (gjsify, Paperless).

Stamped decides per machine whether its local embedding model runs on the GPU, the CPU or not at
all: a Vulkan hint, a guard file that pins the CPU after a GPU crash, a short probe, a one-time
automatic choice that never overrides the person, and no probe on battery.

## Decision

1. **Conversation is a mode of the voice surface, switched on with one toggle ("Conversation").**
   It is built in four stages, each usable on its own:
   1. **Read aloud**: answers are spoken sentence by sentence; Esc or a new prompt stops it.
   2. **Push to talk**: hold a key, speak, release; local recognition.
   3. **Hands-free**: voice activity detection and end-of-turn detection decide when the person
      has finished. The microphone is closed while Lotse speaks (half duplex).
   4. **Barge-in**: the person interrupts Lotse mid-sentence. Needs echo cancellation (PipeWire's
      `echo-cancel` module); without a working canceller Lotse stays at stage 3.
2. **A slow agent must not sound dead.** Lotse acknowledges the turn itself at once with a short
   local phrase, speaks the first sentence as soon as it is streamed (0009, point 11), and
   announces tool calls briefly. The voice profile (0009, point 2) asks the agent for short,
   speakable answers.
   A turn that takes longer than the person's patience can be cancelled by voice or Esc.
3. **Permission requests are asked aloud in conversation mode.** This amends 0009, point 8. Only a
   closed answer counts: "ja" grants the request **once**, "nein" denies it, anything else asks
   again. "Always allow" stays a click. A profile or a host policy can turn spoken answers off.
4. **Every building block has a candidate list, best first.** Recognition, voice and the turn
   detector each list engines with the device they run on:
   - recognition: `large-v3-turbo` on the GPU, parakeet on the CPU, the streaming zipformer on the
     CPU, then the cloud (Voxtral, as in sprechstunde);
   - voice: as in 0009 (Spiel voices; the device is the speech provider's business, not Lotse's);
   - VAD and turn detection are small and run on the CPU everywhere.
   Hands-free may combine two: the streaming engine for partial text and the turn decision, a more
   accurate one to re-read the finished turn.
5. **The machine picks the candidate, as Stamped does.** The GPU is tried only when Vulkan is
   present, the guard has not pinned the CPU and enough video memory is free. A short probe with
   bundled sentences, run when the mode starts (a GPU free at install time can be busy later),
   takes the first candidate under the budget: **500 ms from the end of speech to text**. The probe
   does not run on battery, and a choice the person made is never overridden. If no local
   candidate reaches the budget, hands-free is not offered and push to talk remains.
6. **The cloud is the last candidate, never a silent fallback.** It is used only when the profile
   allows `any`, a key is stored (0009, point 6) and the person has agreed once that speech leaves
   the machine. While a cloud engine listens, the surface says so. A person may move the cloud
   ahead of a slow local engine; that is a setting, not the default.
7. **The building blocks belong to gjsify.** Next to `speechSynthesis` (0009, point 12), gjsify gets
   the W3C `SpeechRecognition` with local engines and voice activity detection, decided in its own
   ADR. The machine-fit parts that are not Lotse's (Vulkan hint, GPU guard, battery check, trying
   candidates in order) move there from Stamped, which becomes their second user. The candidate
   tables and the budget stay in Lotse. This replaces "whisper.cpp later" in 0009, points 3 and 7
   of its order of work.
8. **Lotse does not take over sprechstunde's stack.** LiveKit is a server; Lotse has no HTTP port.
   It ports the ideas (VAD threshold, turn detection, spoken numbers), not the code (0009,
   point 10).
9. **The person's own words are taught, not hoped for.** A term list (project names, tools) goes
   to the engines that accept hints and is shown to the agent with the transcript, which it may
   correct. The list is a device setting, like the engines.

## Consequences

- With a free GPU or the measured CPU engines, the recogniser adds 30–400 ms; the end of a turn
  (VAD silence plus turn detection) adds about 300 ms more. The 2.5 s to first sound from 0009
  stays reachable for answers without tools.
- A busy GPU is a normal case, not an error: the probe at start moves recognition to the CPU.
- Parakeet needs 1.1 GB RAM and 640 MB on disk, `large-v3-turbo` 550 MB. Models are downloaded on
  first use of a stage, not shipped; a device that never enables the mode pays nothing.
- Spoken permission answers trade safety for flow. Limiting them to "once" and to a closed answer
  keeps a misheard word from granting anything lasting.
- The extraction from Stamped touches a second repository and a CORRECTIV project; it waits until
  stage 2 needs it.
- The WER was measured on synthetic speech. Ten recordings of a real voice confirm or move the
  candidate order before stage 2 ships.

## Order of work

This replaces steps 5–7 of 0009's order of work.

1. **Stage 1 in the widget**, against a fake `speechSynthesis`: the toggle, sentence-by-sentence
   speaking, stop on Esc or a new prompt, German strings. The app follows after the gjsify release.
2. **Re-measure** the latencies on an idle machine, with `--audio-ctx` for whisper.cpp on the CPU,
   plus ten real recordings.
3. **gjsify**: ADR and packages for `SpeechRecognition` with the measured engines, VAD, and the
   machine-fit parts extracted from Stamped.
4. **Stage 2**: push to talk, the probe and the candidate choice, the term list.
5. **Stage 3**: hands-free with VAD and turn detection, the acknowledgement, spoken permission
   answers.
6. **Stage 4**: barge-in with echo cancellation.
7. Cloud recognition (`mistral`) as the last candidate, any time after stage 2.
