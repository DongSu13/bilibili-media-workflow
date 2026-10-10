import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import wave


class BatchTests(unittest.TestCase):
    def setUp(self):
        script=Path(__file__).with_name('asr_batch.py')
        self.assertTrue(script.exists(),'Batch runner is not implemented')
        spec=importlib.util.spec_from_file_location('batch',script)
        self.api=importlib.util.module_from_spec(spec); spec.loader.exec_module(self.api)

    def test_modified_source_invalidates_completed_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source.m4a'; source.write_bytes(b'first')
            output=Path(directory)/'draft.json'
            job={'input':str(source),'output':str(output),'language':'zh'}
            signature=self.api.job_signature(job,{'modelSha256':'a','vad':'off'})
            output.write_text(json.dumps({'complete':True,'jobSignature':signature,'segments':[]}))
            self.assertTrue(self.api.completed_matches(output,signature))
            source.write_bytes(b'changed')
            changed=self.api.job_signature(job,{'modelSha256':'a','vad':'off'})
            self.assertFalse(self.api.completed_matches(output,changed))

    def test_different_model_or_language_never_reuses_stale_result(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source.m4a'; source.write_bytes(b'audio')
            job={'input':str(source),'language':'en'}
            first=self.api.job_signature(job,{'modelSha256':'small'})
            self.assertNotEqual(first,self.api.job_signature(job,{'modelSha256':'medium'}))
            self.assertNotEqual(first,self.api.job_signature(dict(job,language='zh'),{'modelSha256':'small'}))

    def test_partial_or_corrupt_output_is_not_completed(self):
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/'draft.json'
            output.write_text('{bad')
            self.assertFalse(self.api.completed_matches(output,'expected'))

    @unittest.skipUnless(os.environ.get('MEDIA_TEST_FFMPEG'),'Set MEDIA_TEST_FFMPEG')
    def test_digital_silence_keeps_time_range_without_inventing_words(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/'silence.wav'; output=root/'draft.json'
            with wave.open(str(source),'wb') as stream:
                stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(16000)
                stream.writeframes(b'\0\0'*32000)
            class NeverInferSilence:
                def create_stream(self): raise AssertionError('Digital silence must not produce model words')
            args=SimpleNamespace(input=str(source),output=str(output),start=.5,end=1.5,
                ffmpeg=os.environ['MEDIA_TEST_FFMPEG'],model='local.onnx')
            self.api.sensevoice_transcribe(args,NeverInferSilence(),25,1)
            data=json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(data['segments'][0]['text'],'')
            self.assertEqual(data['segments'][0]['start'],.5)
            self.assertEqual(data['segments'][0]['end'],1.5)
            self.assertIn('digital_silence_no_lexical_inference',data['segments'][0]['reviewFlags'])
            output.write_text(json.dumps({'complete':False,'jobSignature':'expected','segments':[]}))
            self.assertFalse(self.api.completed_matches(output,'expected'))


if __name__=='__main__': unittest.main()
