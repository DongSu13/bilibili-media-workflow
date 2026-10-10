# Bilibili Media Workflow

[中文](README.md) | [English](README.en.md)

A Codex skill and local CLI helpers for authorized Bilibili media work: select relevant pages and modalities, inspect media and subtitles, produce local transcript drafts, and preserve source/time evidence for content analysis and downstream tasks.

The downloader adapts a user-supplied BilibiliVideoDownload checkout. Transcription uses existing Whisper or SenseVoice runtimes and local models. The agent performs multimodal interpretation and evidence review; the scripts do not automatically establish that content has been understood or verified.

## Contents

| Path | Purpose |
|---|---|
| [SKILL.md](SKILL.md) | Goal selection, capability checks, alignment, interpretation and delivery rules |
| [agents/openai.yaml](agents/openai.yaml) | Codex skill display metadata |
| [scripts/download.cjs](scripts/download.cjs) | Selected-page download adapter, media verification and manifests |
| [scripts/media.py](scripts/media.py) | Inspection, audio extraction, frames, subtitle audits and transcription |
| [scripts/asr_batch.py](scripts/asr_batch.py) | Local Whisper / SenseVoice batch drafts and completed-result reuse |
| [references/](references/) | Download/authentication, analysis, community and audio-runtime guidance |
| `scripts/test*` | Offline rules and synthetic media regression tests |

Only generic instructions, code, tests and documentation are included. Media, sessions, transcripts, weights, binaries, dependencies and personal runtime configurations are excluded. The skill body and most references are currently in Chinese; the CLI and this guide are in English.

## Install and prerequisites

Clone into a new `<SKILL_DIR>`, normally `~/.codex/skills/bilibili-media-workflow`. Preserve and compare any existing skill before replacing local customizations. A private repository requires an authorized GitHub identity.

```powershell
git clone https://github.com/DongSu13/bilibili-media-workflow.git '<SKILL_DIR>'
```

Reload Codex skills and invoke `$bilibili-media-workflow`, or run the scripts directly.

| Feature | User-supplied prerequisites |
|---|---|
| Offline downloader tests/help | Node.js 16+; tested here with Node.js 24 |
| Downloads | [BilibiliVideoDownload v3.3.3](https://github.com/BilibiliVideoDownload/BilibiliVideoDownload/tree/v3.3.3) source, installed CommonJS `got` 11, TypeScript, `nanoid` 3, and ffmpeg |
| Media inspection/extraction | Python 3.9+, ffmpeg; optional ffprobe |
| Whisper drafts | Compatible NumPy, faster-whisper / CTranslate2, local model directory |
| SenseVoice drafts | NumPy, sherpa-onnx, local SenseVoice ONNX model and token file |

The Electron UI is unnecessary. Pass trusted source/dependency directories; scripts do not install dependencies or download models. Use an explicit compatible Python interpreter; `py -3.9` below is the Windows launcher. Optional DPAPI authentication requires the same Windows user/machine; login is handled separately.

## Examples

Replace every `<...>` placeholder and run from the repository root:

```powershell
node scripts/download.cjs --help
py -3.9 scripts/media.py --help
py -3.9 scripts/asr_batch.py --help

node scripts/download.cjs --url '<BV_ID>' --source '<SOURCE_DIR>' --deps '<DEPENDENCY_ROOT>' --info
node scripts/download.cjs --url '<BV_ID>' --source '<SOURCE_DIR>' --deps '<DEPENDENCY_ROOT>' --output '<OUTPUT_DIR>' --ffmpeg '<FFMPEG_EXE>' --parts '1,3-4' --mode audio

py -3.9 scripts/media.py inspect --input '<LOCAL_VIDEO>' --ffmpeg '<FFMPEG_EXE>'
py -3.9 scripts/media.py audio --input '<LOCAL_VIDEO>' --output '<NEW_AUDIO.wav>' --format wav --start 0 --end 30 --ffmpeg '<FFMPEG_EXE>'
py -3.9 scripts/media.py frames --input '<LOCAL_VIDEO>' --output '<NEW_FRAME_DIR>' --start 0 --end 30 --interval 5 --ffmpeg '<FFMPEG_EXE>'
py -3.9 scripts/media.py transcribe --input '<LOCAL_AUDIO>' --output '<NEW_DRAFT.json>' --model '<LOCAL_WHISPER_MODEL_DIR>' --vendor '<ASR_VENDOR_DIR>' --ffmpeg '<FFMPEG_EXE>' --start 0 --end 30 --word-timestamps
```

Example request:

> Use $bilibili-media-workflow for this Bilibili link, page 2 only. Check subtitle/audio/video alignment, summarize the key steps with time evidence, and save the results to my chosen directory.

See [download.md](references/download.md) for adapter/authentication details, [audio-runtime.md](references/audio-runtime.md) for batch jobs, and [analysis.md](references/analysis.md) for evidence and coverage rules. No comment/danmaku scraper is included; [community.md](references/community.md) describes reviewing lawfully obtained community material.

## Verification and limits

Packaging checks passed 17 Node.js tests, including an offline integration with the actual upstream parser, and 13 Python 3.9 tests. Python tests used synthetic media, actual ffmpeg decoding and substituted ASR inference. They verify extraction, output preservation, timestamps, silence handling and reuse, rather than model accuracy.

```powershell
node scripts/test-download.cjs
py -3.9 -B -m unittest discover -s scripts -p 'test_*.py' -v
```

Without configuration, Node.js runs 16 offline tests and Python skips optional integration tests. To enable those checks with existing local installations:

```powershell
$env:BILIBILI_CORE_SOURCE = '<SOURCE_DIR>'
$env:BILIBILI_CORE_DEPS = '<DEPENDENCY_ROOT>'
$env:MEDIA_TEST_FFMPEG = '<FFMPEG_EXE>'
$env:MEDIA_TEST_VENDOR = '<NUMPY_VENDOR_DIR>'
```

This packaging review did not perform login, live video/API/CDN downloads or real ASR model inference. The complete video-download/remux/publication chain remains unverified. Future platform APIs and other operating systems require fresh compatibility checks.

Process only content you may access; do not bypass payment, regional restrictions, permissions or risk controls. Source/vendor paths execute local code and must be trusted. Downloads trust media URLs returned by the platform playback API; media transfers do not send the login cookie. Use one writer per output directory; existence checks are not concurrent-write locks.

Generated manifests/transcripts may contain local paths, media content and source details. Keep them outside this repository; ignore rules alone cannot prevent every accidental upload. Select new output versions after changing Whisper tokenizer/config files or runtime dependencies: the current reuse signature does not hash the entire model directory or dependency versions.

## Attribution and licensing

The adapter uses [BilibiliVideoDownload](https://github.com/BilibiliVideoDownload/BilibiliVideoDownload). ASR uses [Whisper](https://github.com/openai/whisper), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and [SenseVoice](https://github.com/FunAudioLLM/SenseVoice). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for references and upstream license notices. This is an independently maintained workflow, unaffiliated with Bilibili or those projects.

No open-source license has yet been selected for this repository's own code and documentation. No blanket MIT license is asserted. Upstream source, runtimes, weights and media retain their respective licensing and access conditions; a learning-use statement does not grant redistribution rights.
