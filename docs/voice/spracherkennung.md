# Speech recognition: local German engines

Measured for [ADR 0010](../adr/0010-conversation-mode.md): which local speech-to-text engine is
fast and accurate enough for a German conversation, on which hardware.

## Setup (2026-10-28)

- Fedora 44, Intel i9-10900K (20 threads), 62 GB RAM, AMD Radeon RX 6600 (8 GB, Vulkan, no CUDA).
- 25 German sentences in the style of a desktop assistant (mail, calendar, `Pull-Request 2394`,
  Flatpak, Paperless, TypeScript, dates and numbers), synthesised with two Piper voices
  (`thorsten-medium`, `kerstin-low`), 16 kHz mono. Each also with pink noise at 15 dB SNR: 50 clean
  and 50 noisy files.
- WER on lowercased words without punctuation. Latency: end of utterance to final text, model
  warm. Streaming engines get 100 ms chunks; latency is the time from the last chunk.
- **A GPU workload (ComfyUI) ran during the whole measurement**: the GPU at 97 %, 7.1 of 8 GB VRAM
  used, system load around 9. The times are therefore pessimistic, the WER is not affected. The
  times are re-measured on an idle machine before stage 2 is built.

## Results

| Engine, model, device | WER clean / noisy | Latency median / p90 | Peak RSS | Model on disk |
|---|---|---|---|---|
| whisper.cpp `large-v3-turbo` q5_0, Vulkan | 7.3 % / 10.8 % | 412 / 422 ms | 173 MB | 548 MB |
| whisper.cpp `small`, Vulkan | 15.5 % / 19.6 % | 151 / 173 ms | 153 MB | 466 MB |
| whisper.cpp `base`, Vulkan | 23.3 % / 28.2 % | 68 / 86 ms | 168 MB | 142 MB |
| sherpa-onnx `parakeet-tdt-0.6b-v3` int8, CPU, 4 threads | 12.0 % / 13.1 % | 239 / 339 ms | 1.1 GB | 641 MB |
| sherpa-onnx streaming `zipformer-de-kroko`, CPU, 4 threads | 15.3 % / 16.5 % | 32 / 53 ms | 183 MB | 68 MB |
| Vosk `small-de-0.15`, CPU | 23.1 % / 26.1 % | 39 / 57 ms | 255 MB | 92 MB |
| Vosk `de-0.21`, CPU | 17.8 % / 21.6 % | 302 / 576 ms | 5.3 GB | 3.2 GB |
| whisper.cpp `base`, CPU, 8 threads | 23.3 % / 28.2 % | 505 / 684 ms | 300 MB | 142 MB |
| whisper.cpp `small`, CPU, 8 threads | 15.5 % / 19.8 % | 2095 / 2709 ms | 695 MB | 466 MB |
| whisper.cpp `large-v3-turbo`, CPU, 8 threads | 7.1 % / 11.0 % | 9889 / 10621 ms | 785 MB | 547 MB |
| Voxtral Mini 3B q4_K_M, llama.cpp Vulkan | 99–400 % | 830–1486 ms | 3.5 GB | 2.5 GB |

## Findings

- **The GPU reaches the budget of 500 ms even while busy.** `large-v3-turbo` on Vulkan is the most
  accurate and stays at 412 ms for short commands. Its latency grows with the utterance: about
  1.1 s for 10 s of speech.
- **The CPU reaches it too, with the right engine.** Parakeet (240 ms) is the most accurate CPU
  engine, robust against noise, and writes digits and dates (`2394`, `14. November um 10 Uhr`).
  The streaming zipformer is done 32 ms after the last word and gives partial text while the
  person speaks; it writes numbers as words.
- **whisper.cpp on the CPU misses the budget** from `small` up (2–18 s). Part of that is the
  30-second window whisper.cpp pads every utterance to; `--audio-ctx` is tried in the re-measure.
- **Voxtral does not run locally.** As a chat model in llama.cpp it answered the audio instead of
  transcribing it. The realtime variant has no GGUF support. Voxtral stays a cloud engine.
- **Every engine mishears the project's own words**: gjsify, Paperless, Merge-Queue, GNOME. Only
  `large-v3-turbo` gets Flatpak, TypeScript and `Pull-Request 2394` right throughout.

## Caveats

- Synthetic speech has no accent, hesitation, microphone or room, so the WER is optimistic. Ten
  recordings of a real voice, read from the same sentence list, are the check.
- 25 sentences: differences under two points are noise.

## Reproduce

The scripts live outside the repository (`~/.cache/spike/stt/` on the measuring machine):
`bench_whisper.py <name> <build> <model> <threads>`, `bench_sherpa.py parakeet|zipformer
<threads>`, `bench_vosk.py <model>`, run with `nice -n 10`. Models: whisper.cpp ggml from
`huggingface.co/ggerganov/whisper.cpp`; `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` and
`sherpa-onnx-streaming-zipformer-de-kroko-2025-08-06` from the sherpa-onnx releases; Vosk from
`alphacephei.com/vosk/models`.
