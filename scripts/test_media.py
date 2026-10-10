import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('media.py')


class MediaWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.exists(), 'Reusable media helper has not been implemented')
        spec = importlib.util.spec_from_file_location('media_workflow', SCRIPT)
        self.api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.api)

    def test_near_duration_and_duplicates_never_auto_validate_content(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory)/'a.json', Path(directory)/'b.json'
            a.write_text(json.dumps({'body':[{'from':0,'to':99,'content':'different video'}]}))
            b.write_text(json.dumps({'type':1,'body':[{'from':0,'to':99,'content':'different video'}]}))
            result = self.api.audit_subtitles([a,b], expected_duration=100)
            self.assertEqual(result[0]['contentStatus'], 'unverified')
            self.assertEqual(result[0]['duplicateWith'], [str(b)])
            self.assertFalse(result[0]['incomplete'])

    def test_bad_timestamps_and_empty_subtitles_are_not_usable(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory)/'bad.json', Path(directory)/'empty.json'
            a.write_text(json.dumps({'body':[{'from':12,'to':11,'content':'wrong'}]}))
            b.write_text(json.dumps({'body':[]}))
            result = self.api.audit_subtitles([a,b], expected_duration=10)
            self.assertTrue(result[0]['issues'])
            self.assertIn('empty', result[1]['issues'])

    def test_same_text_with_shifted_times_is_a_duplicate_content_signal(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory)/'a.json', Path(directory)/'b.json'
            a.write_text(json.dumps({'body':[{'from':0,'to':9,'content':'Same content'}]}))
            b.write_text(json.dumps({'body':[{'from':.1,'to':9.1,'content':'Same content'}]}))
            result=self.api.audit_subtitles([a,b], expected_duration=10)
            self.assertNotEqual(result[0]['contentSha256'],result[1]['contentSha256'])
            self.assertEqual(result[0]['duplicateTextWith'],[str(b)])
            self.assertEqual(result[0]['contentStatus'],'unverified')

    def test_asr_repetitions_are_flagged_not_silently_deleted(self):
        records=[{'start':0,'end':2,'text':'same words'}, {'start':2,'end':4,'text':'same words'}, {'start':4,'end':6,'text':'same words'}]
        self.api.flag_transcript(records)
        self.assertIn('repeated_text', records[2]['reviewFlags'])
        self.assertEqual(len(records),3)

    @unittest.skipUnless(os.environ.get('MEDIA_TEST_FFMPEG'), 'Set MEDIA_TEST_FFMPEG for real integration checks')
    def test_real_probe_extract_frames_and_no_overwrite(self):
        ffmpeg=os.environ['MEDIA_TEST_FFMPEG']
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/'fixture.mp4'; audio=root/'sample.m4a'
            subprocess.run([ffmpeg,'-v','error','-f','lavfi','-i','color=c=blue:s=320x240:d=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','mpeg4','-c:a','aac','-shortest',str(source)],check=True,capture_output=True)
            measured=self.api.inspect_media(source,ffmpeg=ffmpeg)
            self.assertAlmostEqual(measured['duration'],3,delta=.2)
            self.assertEqual(measured['video'][0]['width'],320)
            self.api.export_audio(source,audio,ffmpeg=ffmpeg,output_format='copy')
            measured_audio=self.api.inspect_media(audio,ffmpeg=ffmpeg)
            self.assertTrue(measured_audio['audio']); self.assertFalse(measured_audio['video'])
            with self.assertRaises(FileExistsError):
                self.api.export_audio(source,audio,ffmpeg=ffmpeg,output_format='copy')
            shots=self.api.extract_frames(source,root/'frames',ffmpeg=ffmpeg,interval=1,start=0,end=2,width=320)
            self.assertEqual([s['time'] for s in shots], [0,1])
            self.assertTrue(all(Path(s['file']).exists() for s in shots))
            with self.assertRaises(ValueError):
                self.api.extract_frames(source,root/'other',ffmpeg=ffmpeg,interval=0)


if __name__=='__main__':
    unittest.main()
