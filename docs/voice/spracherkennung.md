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
- **A GPU workload (ComfyUI) was loaded during the whole measurement**: 7.1 of 8 GB VRAM used,
  system load around 9. The WER is not affected. The times were measured again with the GPU under
  load and idle; see [Re-measure](#re-measure-2026-10-29-and-30).

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

- **The GPU reaches the budget of 500 ms only while it is free.** `large-v3-turbo` on Vulkan is
  the most accurate and takes about 430 ms on an idle GPU, 1.2 s while an image generator
  computes on it (see the re-measure).
- **The CPU reaches it too, with the right engine.** Parakeet (240 ms) is the most accurate CPU
  engine, robust against noise, and writes digits and dates (`2394`, `14. November um 10 Uhr`).
  The streaming zipformer is done 32 ms after the last word and gives partial text while the
  person speaks; it writes numbers as words.
- **whisper.cpp on the CPU misses the budget** from `small` up (2–18 s). A smaller audio window
  (`--audio-ctx`) does not rescue it; see the re-measure.
- **Voxtral does not run locally.** As a chat model in llama.cpp it answered the audio instead of
  transcribing it. The realtime variant has no GGUF support. Voxtral stays a cloud engine.
- **Every engine mishears the project's own words**: gjsify, Paperless, Merge-Queue, GNOME. Only
  `large-v3-turbo` gets Flatpak, TypeScript and `Pull-Request 2394` right throughout.

## Re-measure (2026-10-29 and 30)

Latency only, three passes over the 100 files per engine, `nice -n 10`. On 2026-10-29 an image
generator (ComfyUI) computed on the GPU on and off; on 2026-10-30 it was not running and the GPU
was idle (two passes for the Vulkan engines).

| Engine, device | GPU idle: median / p90 | GPU computing: median / p90 | WER clean / noisy |
|---|---|---|---|
| whisper.cpp `large-v3-turbo`, Vulkan | 428 / 457 ms | 1170 / 1420 ms | 7.3 % / 10.8 % |
| whisper.cpp `small`, Vulkan | 167 / 206 ms | 426 / 562 ms | 15.5 % / 19.6 % |
| whisper.cpp `base`, Vulkan | 77 / 93 ms | 185 / 245 ms | 23.3 % / 28.2 % |
| parakeet, CPU, 4 threads | – | 265 / 435 ms | 12.0 % / 13.1 % |
| streaming zipformer, CPU, 4 threads | – | 34 / 53 ms | 15.3 % / 16.5 % |
| Vosk `small-de-0.15`, CPU | – | 42 / 68 ms | 23.1 % / 26.1 % |
| whisper.cpp `small`, CPU, `--audio-ctx 512` | – | 863 / 1375 ms | 15.9 % / 19.8 % |
| whisper.cpp `large-v3-turbo`, CPU, `--audio-ctx 768` | – | 5692 / 6992 ms | 26.7 % / 13.3 % |

- **A GPU that holds memory is not slow; a GPU that computes is.** The first run, with ComfyUI
  loaded but apparently not generating during the Vulkan passes, matches the idle numbers. While it generated images, every Vulkan
  engine took 2.5 to 3 times as long, and `large-v3-turbo` missed the budget.
- **The CPU engines do not notice the GPU.** Their spread comes from the CPU load of the rest of
  the machine, not from the image generator.
- **`--audio-ctx` trades accuracy for speed on whisper.cpp's CPU path.** `small` gets 2.7 times
  faster at the same WER and still misses 500 ms; `large-v3-turbo` loses most of its accuracy.
- **Consequence for ADR 0010:** free video memory alone does not show that the GPU is usable. The
  probe at mode start, which measures time, is what catches a computing GPU.

## Real voice (2026-11-11)

Twelve recordings of one real voice from the sentence list (ten without noise, two with), on a
USB dynamic microphone (Shure MV7) in a quiet room. The same files again through a simulated
phone line: band-passed to 300–3400 Hz, G.711 µ-law at 8 kHz, back to 16 kHz. Then the same
sentences recorded anew on a phone and sent as Telegram voice messages (Opus in Ogg), fetched
through curlew and decoded to 16 kHz. GPU idle, `nice -n 10`, four threads on the CPU engines.
WER counts the ten recordings without noise; latency is the microphone pass.

| Engine, device | WER microphone | WER phone line | WER Telegram | median / p90 |
|---|---|---|---|---|
| whisper.cpp `large-v3-turbo`, Vulkan | 12.9 % | 11.8 % | 14.0 % | 428 / 507 ms |
| streaming zipformer, CPU | 21.5 % | 26.9 % | 24.7 % | 37 / 73 ms |
| whisper.cpp `small`, Vulkan | 21.5 % | 35.5 % | 25.8 % | 186 / 205 ms |
| parakeet, CPU | 31.2 % | 49.5 % | 23.7 % | 434 / 592 ms |

- **A real voice roughly doubles the error rate**, and the order changes: `large-v3-turbo` stays
  first, parakeet falls from second to last. It hears "Pool Request" for "Pull-Request" and
  collapses on the phone line, so it is no longer a candidate.
- **`large-v3-turbo` does not lose accuracy on the phone line.** It stays the push-to-talk
  choice, and the same model can serve a phone surface.
- **The zipformer beats parakeet on a real voice** at a tenth of the latency and a sixth of the
  memory, which supports building gjsify's first `SpeechRecognition` backend on it.
- Part of the zipformer's WER is the scoring: it writes numbers as words ("zwei, drei, neun,
  vier" for "2394") and times as speech ("halb vier" for "15 Uhr 30"), each counted as several
  errors.
- **A messenger voice message is closer to the microphone than to the phone line.** Opus keeps
  the full speech band, so `large-v3-turbo` loses about one point, and it stays the choice for a
  messenger surface too. Parakeet recovers on Telegram, but ties the zipformer within noise and
  still fails the phone line.
- Two noisy recordings are too few for a noisy WER, so the table leaves it out.

## Caveats

- Synthetic speech has no accent, hesitation, microphone or room, so the WER is optimistic. The
  real-voice section above is one speaker and twelve sentences, a check rather than a benchmark.
  The phone-line column is simulated; a real call through Asterisk is not measured yet.
- 25 sentences: differences under two points are noise.

## Reproduce

The scripts live outside the repository (`~/.cache/spike/stt/` on the measuring machine):
`bench_whisper.py <name> <build> <model> <threads>`, `bench_sherpa.py parakeet|zipformer
<threads>`, `bench_vosk.py <model>`, run with `nice -n 10`. Models: whisper.cpp ggml from
`huggingface.co/ggerganov/whisper.cpp`; `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` and
`sherpa-onnx-streaming-zipformer-de-kroko-2025-08-06` from the sherpa-onnx releases; Vosk from
`alphacephei.com/vosk/models`. The real-voice pass sets `STT_D` to the recording directory (`run_eigene.sh`).
