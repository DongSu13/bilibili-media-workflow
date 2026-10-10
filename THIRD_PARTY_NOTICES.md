# Third-Party References and License Boundaries

This repository contains a locally maintained workflow, adapter/helpers and tests. It does not bundle the downloader's source, ffmpeg, ASR libraries, model weights or media. Consult the selected upstream versions and model cards for applicable permissions. This file does not license this repository's own work under MIT or under any other license.

## Download adapter

- [BilibiliVideoDownload/BilibiliVideoDownload](https://github.com/BilibiliVideoDownload/BilibiliVideoDownload), [v3.3.3](https://github.com/BilibiliVideoDownload/BilibiliVideoDownload/tree/v3.3.3), tag commit `a60f6b81459cf6938c37695e1214edf0385497d4`.
- Original copyright: `Copyright (c) 2021 blogwy`.
- [Original MIT license](https://github.com/BilibiliVideoDownload/BilibiliVideoDownload/blob/v3.3.3/LICENSE).
- `scripts/download.cjs` loads the user-supplied `src/core/bilibili.ts` parser/task builder in place, provides a CLI/network bridge, and handles selected streams, preservation and verification. It is not a redistributed Electron application or an official upstream release.
- Runtime dependencies: [got](https://github.com/sindresorhus/got/tree/v11.8.6) (11.x, at least 11.8.5), [TypeScript](https://github.com/microsoft/TypeScript), [nanoid](https://github.com/ai/nanoid/tree/3.3.3). These are supplied separately; CommonJS compatibility matters. The fixed-version floor addresses [CVE-2022-33987](https://github.com/advisories/GHSA-pfrx-2q88-qq97); it is not a comprehensive dependency security audit.

The following upstream notice applies to BilibiliVideoDownload, not to unrelated original files in this repository:

```text
MIT License

Copyright (c) 2021 blogwy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Media processing and ASR

| Component | Official source / paper | Role |
|---|---|---|
| FFmpeg | [Project](https://ffmpeg.org/) · [License/build conditions](https://ffmpeg.org/legal.html) | Inspection, decoding, extraction and stream-copy remux |
| NumPy | [Project](https://numpy.org/) · [Repository](https://github.com/numpy/numpy) | Local audio sample arrays |
| Whisper | [OpenAI implementation](https://github.com/openai/whisper) · [Robust Speech Recognition via Large-Scale Weak Supervision](https://arxiv.org/abs/2212.04356) | Underlying speech recognition model |
| faster-whisper | [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) | Local Whisper inference wrapper |
| CTranslate2 | [OpenNMT/CTranslate2](https://github.com/OpenNMT/CTranslate2) | Runtime and converted Whisper model format |
| sherpa-onnx | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Local SenseVoice ONNX inference |
| SenseVoice | [FunAudioLLM/SenseVoice](https://github.com/FunAudioLLM/SenseVoice) · [FunAudioLLM paper](https://arxiv.org/abs/2407.04051) | Speech recognition through user-supplied model/token files |

Library licenses do not automatically apply to every checkpoint or converted model. Check the exact model card, original provider and distribution conditions. FFmpeg licensing depends on the supplied build. Bilibili access and rights in videos, audio, subtitles and community material remain separate from software licenses.
