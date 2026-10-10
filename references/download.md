# Configurable download adapter

Use `scripts/download.cjs` when a user supplies a BilibiliVideoDownload source checkout and requests local media from a public BV video. It is an adapter, not a copy of the original downloader, an authentication utility, or a general Bilibili URL resolver. It does not bypass paid content or regional/account restrictions.

Upstream: [BilibiliVideoDownload/BilibiliVideoDownload](https://github.com/BilibiliVideoDownload/BilibiliVideoDownload), [v3.3.3](https://github.com/BilibiliVideoDownload/BilibiliVideoDownload/tree/v3.3.3), tag commit `a60f6b81459cf6938c37695e1214edf0385497d4`. Its original copyright is `Copyright (c) 2021 blogwy`; see [the upstream MIT license](https://github.com/BilibiliVideoDownload/BilibiliVideoDownload/blob/v3.3.3/LICENSE) and [third-party notices](../THIRD_PARTY_NOTICES.md). This workflow is independently maintained and is not an official Bilibili or upstream release. API compatibility can change.

## Existing prerequisites

- Node.js 16 or newer; tested with Node 24.
- User-supplied BilibiliVideoDownload **3.3.3** source layout, including `src/core/bilibili.ts` and its local imports. Other layouts need inspection before use.
- Existing CommonJS `got` 11.8.5 or newer within the 11.x series, TypeScript, and `nanoid` 3 dependencies. Pass `--deps` to an existing package root containing their `node_modules` when the source checkout has no installed dependencies. Do not install the full Electron/Vue application just to run this adapter, or install new dependencies automatically.
- A configured ffmpeg executable that can inspect MP4/AAC and, for video mode, remux the selected codecs. CPU processing is sufficient; CUDA is not required. A cut-down ffmpeg may lack codecs or containers. The adapter checks the executable before downloading media but cannot guarantee all codec capabilities from its version alone.

The original project's MIT license permits reuse with its copyright and license notice retained when copying substantial source. This adapter loads the supplied core in place. The original source, dependency licenses, ffmpeg build license, and rights in downloaded media remain separate; an MIT source license does not grant media redistribution rights. No ffmpeg or original source binary is bundled here.

Check the actual installed `got` version before network use: releases before 11.8.5 are affected by [CVE-2022-33987 / GHSA-pfrx-2q88-qq97](https://github.com/advisories/GHSA-pfrx-2q88-qq97), a redirect-to-UNIX-socket vulnerability. The adapter checks CommonJS interfaces but does not enforce this minimum version. API requests follow redirects by default; media transfers disable redirects. Offline test success does not establish that supplied dependencies are patched.

## Arguments and examples

Replace the angle-bracket placeholders before executing these PowerShell commands. All directories are supplied by the user; there is no fixed account, video, output folder, runtime, or ffmpeg location.

```powershell
$mediaAdapter = Join-Path $env:USERPROFILE '.codex\skills\bilibili-media-workflow\scripts\download.cjs'
node $mediaAdapter --help
node $mediaAdapter --url '<BV_ID>' --source '<SOURCE_DIR>' --deps '<EXISTING_DEPENDENCY_ROOT>' --parts '1,3-4' --info
node $mediaAdapter --url '<BV_ID>' --source '<SOURCE_DIR>' --deps '<EXISTING_DEPENDENCY_ROOT>' --output '<OUTPUT_DIR>' --ffmpeg '<FFMPEG_EXE>' --parts '1,3-4' --mode audio
node $mediaAdapter --url '<BV_ID>' --source '<SOURCE_DIR>' --deps '<EXISTING_DEPENDENCY_ROOT>' --output '<OUTPUT_DIR>' --ffmpeg '<FFMPEG_EXE>' --parts '2' --mode video --quality 80 --session-file '<DPAPI_SESSION_FILE>'
```

`--url` accepts a BV ID or canonical HTTPS `bilibili.com/video/BV...` URL. Short links, episodes, foreign hosts, credentials in URLs, and malformed page selectors are rejected. A URL `p=` selects that one page; otherwise use `--parts`, not both. Ranges use positive integers, are checked against metadata, sorted and deduplicated. **Downloads require an explicit selector**: `--parts 1,3-4`, a URL `p=`, or `--parts all` when the user requested every page. `--info` may list all pages without a selector. Video quality defaults to request ID 80, not a guaranteed delivered resolution. It selects the best available ID at or below the request and records both requested and actual IDs. Audio mode ignores video quality for byte selection.

`--info` performs a small public metadata request, prints title/page/CID/duration and selected pages, then stops. It requires source/dependency locations, but not ffmpeg/output, does not load the TypeScript core, decrypt a session or create an output directory, and does not request or download media streams. `--help` is entirely offline and loads no third-party packages. Parameters are named and strict; unknown or duplicate switches are errors.

## Authentication and transfer behavior

Authentication is resolved separately. A browser being logged in does not imply a new automation context or this CLI has that identity. Prefer an already authorized session route; never bulk-export browser cookies or print credentials. This script does not launch a browser, generate QR codes, or start downloads after login.

Optional `--session-file` reads a Windows PowerShell DPAPI-encrypted session created by a separate authorized login process. It only decrypts within the same Windows user/machine context, never treats the file as a portable plaintext configuration, and never prints the result. Without it, requests use public access; entitlement or API errors stop the task. Login expiration and API risk controls require a separately handled user/identity step, not bypass attempts.

For downloads, the adapter supplies current metadata/playback data to the actual source `parseHtml`. Video mode uses the actual per-page `getDownloadList` to refresh playback; audio mode avoids the original downloader's unconditional video step and takes only the AAC/MP4 DASH audio stream. Each retry obtains fresh temporary playback URLs. Audio output is `.m4a` without transcoding; if no compatible AAC stream exists, the adapter stops rather than guessing a container. Subtitle requests inside the original video task builder are suppressed because this media-only adapter does not acquire subtitles. Covers and danmaku are not fetched.

Downloads are sequential with at most three attempts for temporary network errors or HTTP 500/502/503/504. Authorization/risk-control HTTP 403/412/429, API rejection, invalid media, local errors and known validation failures stop without repeated downloads. A failed video transfer never forces a lower-quality retry; downgrade selection happens only from a successful playback response containing a valid lower stream. Media requests use the video Referer, source User-Agent, a bounded timeout and exclusive file creation. The CLI does not print source parser objects, upstream error stacks, cookies, headers or signed media URLs. It stores no signed URLs in the manifest.

## Preservation and verification

The output manifest is `download-manifest.json`. It binds the directory to one BV and records per-page, per-mode status, CID, expected duration, actual quality, file size, local SHA-256 and retained stream files. A different BV manifest or changed existing CID is rejected. Existing successful legacy records can be reused after fresh local verification. Mode-specific output records coexist; switching audio/video does not discard the other mode's files.

Filenames are sanitized for Windows and constrained to the output directory. Existing symlink outputs and traversal names are rejected. Existing output files are freshly inspected for required tracks and duration (within five seconds of page metadata), and hashed; changed recorded hashes or invalid media stop without overwriting. Media inspection uses `ffmpeg -i`, not ffprobe or a full decode. It establishes basic structure/duration, not flawless audibility or semantic subtitle validity. For important outputs, additionally listen to opening/ending and relevant sections; use a full decode check when the installed tools support it.

Fresh streams have unique names and are written exclusively. Video is remuxed with stream copy. Verified output is published using an exclusive hard link within the same output filesystem, so an existing or concurrently created user file cannot be overwritten. The filesystem must support hard links (for example NTFS); unsupported filesystems require a separately reviewed publication strategy. No user files or caches are automatically deleted. Intermediate streams and failed-attempt files remain and are listed in mode state when created; the final output can share disk data with its retained temporary file. If cleanup is requested later, resolve exactly these task-created paths and preserve the verified final output.

Manifest updates replace only the task's same-BV manifest through a unique temporary file. This is not byte-range download resumption: valid final files are reused, interrupted streams are retained, and another attempt starts a new stream. Do not run multiple writers in the same output directory concurrently; there is no manifest lock.

Previous validation, before this packaging review, covered public metadata and an authenticated audio-only workflow using an explicit URL page selector and an existing Windows DPAPI session. Session decryption, playback API access, CDN AAC transfer, media inspection, SHA-256 hashing, final publication, and fresh verification/reuse on a second invocation succeeded. A video-mode request at quality ID 16 stopped after one attempt on HTTP 412 before any media transfer and recorded no retained streams. No risk-control bypass or automatic retry was attempted. These live checks were not repeated for packaging. The adapter's complete video download/remux/publication chain remains unverified; successful video downloads by the older runner are separate evidence, not validation of this adapter. Offline tests exercise parameter/stream/manifest rules and the actual supplied source parser/task builder without real authentication or CDN access.

## Offline tests

```powershell
node '<SKILL_DIR>\scripts\test-download.cjs'
# Optional: exercise the actual supplied source with synthetic metadata and no network.
$env:BILIBILI_CORE_SOURCE = '<SOURCE_DIR>'
$env:BILIBILI_CORE_DEPS = '<EXISTING_DEPENDENCY_ROOT>'
node '<SKILL_DIR>\scripts\test-download.cjs'
```

The tests cover public URL parsing, page ranges, filenames/output containment, different-BV rejection and output preservation, audio-only transfer planning, AAC/bitrate selection and video downgrade, strict arguments, log redaction, media inspection, offline CLI help, and optionally the real source `parseHtml`/`getDownloadList` behavior. They do not contact a CDN, test a real login/session, or prove that future Bilibili API changes remain compatible.
