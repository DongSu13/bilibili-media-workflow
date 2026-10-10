"""ASR boundary regressions: real decoding, only inference is replaced."""
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave


@unittest.skipUnless(os.environ.get('MEDIA_TEST_FFMPEG') and os.environ.get('MEDIA_TEST_VENDOR'),
                     'Set MEDIA_TEST_FFMPEG and MEDIA_TEST_VENDOR')
class AsrControlsTests(unittest.TestCase):
    def exercise(self, reuse_model=False, **overrides):
        spec=importlib.util.spec_from_file_location('media_asr_test',Path(__file__).with_name('media.py'))
        api=importlib.util.module_from_spec(spec); spec.loader.exec_module(api)
        sys.path.insert(0,os.environ['MEDIA_TEST_VENDOR'])
        import numpy
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/'input.wav'; output=root/'draft.json'
            with wave.open(str(source),'wb') as audio:
                audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000)
                audio.writeframes(struct.pack('<h',1000)*16000*3)
            model=root/'model'; model.mkdir()
            captured={}
            class Inference:
                def __init__(self,*args,**kwargs):
                    captured['model']=kwargs
                    captured['loads']=captured.get('loads',0)+1
                def transcribe(self,waveform,**kwargs):
                    captured.update(kwargs); captured['samples']=len(waveform)
                    word=SimpleNamespace(start=.1,end=.4,word=' example',probability=.8)
                    segment=SimpleNamespace(start=.1,end=.7,text=' example',avg_logprob=-.3,no_speech_prob=.1,words=[word])
                    return iter([segment]),SimpleNamespace(language='en',language_probability=.99,duration_after_vad=1.5)
            args=SimpleNamespace(input=str(source),output=str(output),model=str(model),
                vendor=os.environ['MEDIA_TEST_VENDOR'],ffmpeg=os.environ['MEDIA_TEST_FFMPEG'],
                start=1,end=2.5,device='cpu',compute_type='int8',threads=2,beam=5,
                language='en',vad='off',word_timestamps=True,condition_on_previous_text=False)
            for key,value in overrides.items(): setattr(args,key,value)
            with patch.dict(sys.modules,{'faster_whisper':SimpleNamespace(WhisperModel=Inference)}):
                if reuse_model:
                    api.transcribe(args,inference_model=Inference())
                else:
                    api.transcribe(args)
            return json.loads(output.read_text(encoding='utf-8')),captured

    def test_explicit_no_vad_preserves_decoder_range(self):
        _,captured=self.exercise()
        self.assertFalse(captured['vad_filter'])
        self.assertEqual(captured['samples'],24000)

    def test_word_times_are_shifted_to_source_not_clip(self):
        result,captured=self.exercise()
        self.assertTrue(captured.get('word_timestamps'))
        word=result['segments'][0]['words'][0]
        self.assertAlmostEqual(word['start'],1.1)
        self.assertAlmostEqual(word['end'],1.4)
        self.assertAlmostEqual(word['probability'],.8)

    def test_draft_completion_does_not_validate_audio_interpretation(self):
        result,captured=self.exercise()
        self.assertFalse(captured.get('condition_on_previous_text',True))
        self.assertEqual(result.get('audioInterpretationStatus'),'not_verified_by_asr')
        self.assertEqual(result['contentStatus'],'automatic_draft_unverified')
        self.assertTrue(result['complete'])

    def test_batch_can_reuse_one_model_without_reloading(self):
        _,captured=self.exercise(reuse_model=True)
        self.assertEqual(captured['loads'],1)


if __name__=='__main__': unittest.main()
