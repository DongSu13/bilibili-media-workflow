# Bilibili Media Workflow

[中文](README.md) | [English](README.en.md)

一套用于 Codex 的 B站媒体技能与命令行辅助脚本：按用户目标选择分集和音视频，检查媒体与字幕，生成本地转写草稿，并为内容分析保留可回查的时间与来源。适用于学习和获授权的媒体处理。

它不是新下载器或新 ASR 模型。下载脚本适配用户提供的 BilibiliVideoDownload 源码；转写调用已有 Whisper 或 SenseVoice 运行环境。多模态理解、音画核对和社区观点复核由执行技能的智能体完成，脚本不会自动认证理解正确。

## 包含内容

| 路径 | 用途 |
|---|---|
| [SKILL.md](SKILL.md) | 目标选择、能力预检、来源对齐、理解与交付规则 |
| [agents/openai.yaml](agents/openai.yaml) | Codex 技能显示信息 |
| [scripts/download.cjs](scripts/download.cjs) | 指定分集的下载适配、媒体检查与来源清单 |
| [scripts/media.py](scripts/media.py) | 媒体检查、音频导出、抽帧、字幕审计、单文件转写 |
| [scripts/asr_batch.py](scripts/asr_batch.py) | 本地 Whisper / SenseVoice 批量转写和已完成结果复用 |
| [references/](references/) | 下载、认证、解析、社区线索和音频运行说明 |
| `scripts/test*` | 离线规则与合成媒体回归测试 |

仓库只包含通用技能、代码、测试和说明，不包含视频、用户会话、字幕/转写结果、模型、运行库或个人配置。

## 安装和依赖

将仓库克隆到尚不存在的 `<SKILL_DIR>`；Codex 默认技能位置为 `~/.codex/skills/bilibili-media-workflow`。已有同名技能时先保留其副本并比较差异，避免覆盖本地定制。

```powershell
git clone https://github.com/DongSu13/bilibili-media-workflow.git '<SKILL_DIR>'
```

仓库若为私有，需要先使用有权限的 GitHub 身份认证。让 Codex 重新加载技能后，可用 `$bilibili-media-workflow` 调用；也可以直接运行脚本。

| 功能 | 需要用户提供 |
|---|---|
| 离线下载规则测试、CLI 帮助 | Node.js 16+；本次使用 Node.js 24 |
| B站下载 | [BilibiliVideoDownload v3.3.3](https://github.com/BilibiliVideoDownload/BilibiliVideoDownload/tree/v3.3.3) 源码、已有 CommonJS `got` 11、TypeScript、`nanoid` 3，以及 ffmpeg |
| 媒体检查、音频与抽帧 | Python 3.9+、ffmpeg；ffprobe 可选 |
| Whisper 转写 | 与解释器匹配的 NumPy、faster-whisper / CTranslate2、本地模型 |
| SenseVoice 转写 | NumPy、sherpa-onnx、本地 SenseVoice ONNX 模型与 token 文件 |

不需要安装下载器的 Electron 界面；传入可信源码目录和已有依赖目录即可。项目不自动安装依赖或下载模型。Python 示例使用 `py -3.9`，其他系统请换成明确指定的 Python 3.9+ 解释器。认证可选，DPAPI 会话仅支持同一 Windows 用户/机器，登录流程由外部授权工具处理。

## 使用示例

先替换所有 `<...>` 占位符。在仓库根目录运行：

```powershell
node scripts/download.cjs --help
py -3.9 scripts/media.py --help
py -3.9 scripts/asr_batch.py --help

# 只查看元数据；不下载媒体、不读取登录会话。
node scripts/download.cjs --url '<BV_ID>' --source '<SOURCE_DIR>' --deps '<DEPENDENCY_ROOT>' --info

# 只下载指定分集的音轨。
node scripts/download.cjs --url '<BV_ID>' --source '<SOURCE_DIR>' --deps '<DEPENDENCY_ROOT>' --output '<OUTPUT_DIR>' --ffmpeg '<FFMPEG_EXE>' --parts '1,3-4' --mode audio

# 检查已有媒体，导出指定区间，或抽取带时间索引的画面。
py -3.9 scripts/media.py inspect --input '<LOCAL_VIDEO>' --ffmpeg '<FFMPEG_EXE>'
py -3.9 scripts/media.py audio --input '<LOCAL_VIDEO>' --output '<NEW_AUDIO.wav>' --format wav --start 0 --end 30 --ffmpeg '<FFMPEG_EXE>'
py -3.9 scripts/media.py frames --input '<LOCAL_VIDEO>' --output '<NEW_FRAME_DIR>' --start 0 --end 30 --interval 5 --ffmpeg '<FFMPEG_EXE>'

# 用已有本地 Whisper 模型转写；输出是待核草稿。
py -3.9 scripts/media.py transcribe --input '<LOCAL_AUDIO>' --output '<NEW_DRAFT.json>' --model '<LOCAL_WHISPER_MODEL_DIR>' --vendor '<ASR_VENDOR_DIR>' --ffmpeg '<FFMPEG_EXE>' --start 0 --end 30 --word-timestamps
```

Codex 请求示例：

> 使用 $bilibili-media-workflow 处理这个 B站链接，仅处理第 2 集，先检查字幕与音画是否匹配，再总结关键步骤并保留时间依据。输出到我指定的目录。

下载/认证详情见 [download.md](references/download.md)，转写批次与模型配置见 [audio-runtime.md](references/audio-runtime.md)，理解与覆盖范围见 [analysis.md](references/analysis.md)。现有脚本不抓取评论或弹幕；[community.md](references/community.md) 适用于已合法获取的社区线索。

## 验证范围与限制

整理时通过 17 项 Node.js 测试（含真实上游解析器的离线适配检查）及 13 项 Python 3.9 测试。Python 测试使用 ffmpeg 生成的合成媒体、真实解码和替代的 ASR 推理，覆盖导出/抽帧、禁止覆盖、时间偏移、静音与结果复用；不是 ASR 模型准确率测试。

```powershell
node scripts/test-download.cjs
py -3.9 -B -m unittest discover -s scripts -p 'test_*.py' -v
```

默认不配置环境变量时，Node.js 运行 16 项纯离线测试；Python 的媒体/ASR 集成测试会跳过。启用相关测试前设置：

```powershell
$env:BILIBILI_CORE_SOURCE = '<SOURCE_DIR>'
$env:BILIBILI_CORE_DEPS = '<DEPENDENCY_ROOT>'
$env:MEDIA_TEST_FFMPEG = '<FFMPEG_EXE>'
$env:MEDIA_TEST_VENDOR = '<NUMPY_VENDOR_DIR>'
```

本次没有重新登录、请求真实视频、下载 CDN 媒体或运行真实 ASR 模型。完整视频下载、合流与发布链仍未验证，未来 B站 API 和不同平台的兼容性需要实际检查。

只处理有权访问的内容；不绕过付费、地域、权限或风控。`--source` 和 `--vendor` 会加载本地代码，必须来自可信来源。下载器信任平台播放 API 返回的媒体地址，媒体转移请求不携带登录 Cookie。一个输出目录只由一个进程写入；媒体脚本的存在性检查不提供并发锁。

生成的清单和转写可能含本地路径、媒体内容及来源信息，应放在仓库之外。`.gitignore` 只是辅助措施。修改 Whisper tokenizer/config 或运行库后请使用新输出版本：当前复用签名不覆盖模型目录中的全部文件和依赖版本。

## 来源与许可

下载适配依据 [BilibiliVideoDownload](https://github.com/BilibiliVideoDownload/BilibiliVideoDownload)；ASR 依据 [Whisper](https://github.com/openai/whisper)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper)、[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 和 [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)。详细引用及上游许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目独立维护，与 Bilibili 及这些上游项目无官方关系。

本仓库尚未为自身代码和文档选择开源许可证；没有统一套用 MIT。上游源码、运行库、模型权重与媒体内容分别受各自许可和使用条件约束，“仅供学习”不替代相应授权。
