# 可复用的本地音频路径

用于已授权的本地ASR依赖/模型配置、短片预检和批量语言转写。先遵循 `analysis.md` 的模态与证据边界；这里不是发音认证，也不包含云端上传。

相关实现与模型来源：[OpenAI Whisper](https://github.com/openai/whisper)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper)、[CTranslate2](https://github.com/OpenNMT/CTranslate2)、[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)、[SenseVoice](https://github.com/FunAudioLLM/SenseVoice)。本项目仅调用用户提供的本地运行库和模型，不包含这些实现或权重；具体模型的使用、下载和再分发权限须分别查看其模型卡及许可证。完整依赖与许可边界见 [第三方说明](../THIRD_PARTY_NOTICES.md)。

## 运行隔离与预检

- 将运行库、模型放在用户批准的独立运行目录，技能目录只保存脚本与说明；使用指定解释器和显式 `--vendor`，不覆盖全局依赖。
- ABI须与解释器匹配；仅有轮包、依赖可导入、模型文件齐全都不足以通过。实际加载原生模型并转写目标语种/语言切换/短声音样本。
- 可在受限硬件上使用 CPU/int8。CTranslate2模型与whisper.cpp模型格式不同；AMD显卡不等于能直接使用CUDA。
- 调整模型须依据实际样本的漏句、术语/例词错误、时间定位和耗时；不要把更大模型、跨识别器一致或低置信分数当正确率。

## 两种本地语言入口

`scripts/media.py transcribe` 保留原有单文件接口。可用 `--vad off --word-timestamps --no-condition-on-previous-text` 处理短音较多的素材；也可对同一代表片段测试VAD开/关。关闭VAD不能保证没有静音幻觉。词时间戳属于模型对齐结果，不是音素精密边界。

`scripts/asr_batch.py --help` 支持已存本地模型：

- `--engine whisper`：CTranslate2 Whisper目录；模型在进程中复用，输出段/词时间索引。
- `--engine sensevoice`：SenseVoice ONNX文件和 `--tokens`；识别器自动处理语言，以重叠短窗口保存草稿。窗口起止是**输入范围**，不是每句话或词的真实边界；保留重复/截断线索，合并须复查接缝。jobs的language用于Whisper；SenseVoice仍自动识别，不按该字段强制语种。

示例jobs文件（路径按当前任务替换）：

```json
[
  {"input":"/absolute/media/part.m4a","output":"/absolute/analysis/v3/part.json","start":0,"end":120,"language":"en"}
]
```

命令参数包括 `--jobs --report --engine --vendor --model --ffmpeg`；SenseVoice加 `--tokens`，其独立目录缺NumPy时加 `--numpy-vendor`。提供本地模型，不触发下载。报告选择新路径。

重复执行只复用原音SHA256、模型SHA256、识别设置与语言/范围完全匹配的已完成草稿；既有文件不匹配或仅部分完成时拒绝覆盖，另选版本。批次失败保留原件/部分结果并报告，不把部分失败标为全部成功。

## 转写后的理解

先读语言草稿，与视频、图片、清晰硬字幕和可信软字幕按单集时间及上下文交叉核验，再形成语义段记录。按 `analysis.md` 的逐项核验区分内容、事实评价和声音实现：原图可解决术语、例词拼写、符号及明确展示的要点；不必等待全部声音示范听核才记录这些结论。软字幕被隔离时仍检查可用硬字幕；未展示的口头信息不能由图片补造。纠正保留依据，不同ASR结果是疑点定位工具，不是多数表决。

实测SenseVoice可能对静音产生词。批处理对**全零解码样本**不做词语推理，保留空文本、输入时间窗及标记；其他低能量声音只标记待核，不自动删掉。不要把这个保护推广成所有背景噪声/静音幻觉已解决。

普通ASR会把不同声音示范写成同一单词，或把孤立音素省略/猜成词。声音事件另建来源索引，保留原音片段；需要原音理解时采用实际可用的听取路径。声学分析记录方法/参数/区间和不确定性，不能用数值替代全部声音理解。

输出的 `complete` 仅表示程序跑完；`automatic_draft_unverified` 与 `not_verified_by_asr` 不因翻译、换格式或批量完成而升级。经过实际交叉核验的内容另存关联理解记录，给出已核项与局部待核项，不改原始机器状态。云端上传、付费调用或更换大型模型需符合当前任务授权。
