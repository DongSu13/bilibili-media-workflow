"""Offline, resumable ASR jobs. No login, model download or cloud upload."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace

import media


def file_sha256(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''): digest.update(block)
    return digest.hexdigest()


def job_signature(job,settings):
    payload={'source':str(media.local_file(job['input'])),'sourceSha256':file_sha256(job['input']),
             'start':job.get('start',0),'end':job.get('end'),
             'language':job.get('language'),'settings':settings}
    return hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False).encode('utf-8')).hexdigest()


def completed_matches(output,signature):
    try:
        data=json.loads(Path(output).read_text(encoding='utf-8'))
        return data.get('complete') is True and data.get('jobSignature')==signature and isinstance(data.get('segments'),list)
    except (OSError,ValueError,AttributeError): return False


def sensevoice_transcribe(args,recognizer,chunk_seconds,overlap_seconds):
    import numpy as np
    source=media.local_file(args.input); info=media.inspect_media(source,ffmpeg=args.ffmpeg)
    start,end=media.selected_range(info['duration'],args.start,args.end)
    output=media.fresh_output(args.output); partial=output.with_suffix('.partial.jsonl')
    if partial.exists(): raise FileExistsError('Partial exists; choose a new output version')
    records=[]; cursor=start; clock_start=time.perf_counter()
    with partial.open('x',encoding='utf-8') as stream:
        while cursor<end-.001:
            finish=min(cursor+chunk_seconds,end)
            decoded=media.run_ffmpeg(['-ss',str(cursor),'-i',str(source),'-t',str(finish-cursor),
                    '-vn','-ac','1','-ar','16000','-f','f32le','pipe:1'],args.ffmpeg)
            samples=np.frombuffer(decoded.stdout,dtype=np.float32)
            if not len(samples): raise ValueError('Decoder emitted no audio samples')
            peak=float(np.max(np.abs(samples))); rms=float(np.sqrt(np.mean(samples.astype(np.float64)**2)))
            flags=['overlapping_window_check_boundary'] if records and overlap_seconds else []
            if peak==0:
                text=''; flags.append('digital_silence_no_lexical_inference')
            else:
                request=recognizer.create_stream(); request.accept_waveform(16000,samples)
                recognizer.decode_stream(request); text=request.result.text
                if rms<.001: flags.append('low_energy_review_not_automatically_removed')
            record={'start':cursor,'end':finish,'text':text,
                    'rmsDbfs':float(20*np.log10(rms)) if rms else None,
                    'timestampMethod':'input_window_not_word_or_phoneme_alignment',
                    'reviewFlags':flags}
            records.append(record); stream.write(json.dumps(record,ensure_ascii=False)+'\n'); stream.flush()
            if finish>=end: break
            cursor=finish-overlap_seconds
    result={'source':str(source),'start':start,'end':end,'complete':True,
            'contentStatus':'automatic_draft_unverified','audioInterpretationStatus':'not_verified_by_asr',
            'engine':'sensevoice','model':Path(args.model).name,'device':'cpu',
            'chunkSeconds':chunk_seconds,'overlapSeconds':overlap_seconds,
            'inferenceSeconds':round(time.perf_counter()-clock_start,3),'segments':records}
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    return {'file':str(output),'segments':len(records),'contentStatus':result['contentStatus']}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jobs',required=True,help='JSON array: input, output, optional start/end/language')
    parser.add_argument('--report',required=True,help='New per-run progress JSON, never overwrites an old report')
    parser.add_argument('--engine',choices=['whisper','sensevoice'],default='whisper')
    parser.add_argument('--vendor',required=True)
    parser.add_argument('--numpy-vendor',help='Separate NumPy directory for a standalone SenseVoice install')
    parser.add_argument('--model',required=True,help='Local CTranslate2 model dir or SenseVoice ONNX file')
    parser.add_argument('--tokens',help='SenseVoice token file')
    parser.add_argument('--ffmpeg',required=True)
    parser.add_argument('--threads',type=int,default=6)
    parser.add_argument('--beam',type=int,default=5)
    parser.add_argument('--vad',choices=['on','off'],default='off')
    parser.add_argument('--chunk-seconds',type=float,default=25)
    parser.add_argument('--overlap-seconds',type=float,default=1)
    config=parser.parse_args()
    if config.threads<1 or config.beam<1: parser.error('Threads and beam must be positive')
    if not 0<=config.overlap_seconds<config.chunk_seconds<=60: parser.error('Require 0 <= overlap < chunk <= 60')
    jobs=json.loads(media.local_file(config.jobs).read_text(encoding='utf-8-sig'))
    if not isinstance(jobs,list) or not jobs: parser.error('Jobs must be a non-empty JSON array')
    outputs=[str(Path(job['output']).resolve()) for job in jobs]
    if len(set(outputs))!=len(outputs): parser.error('Duplicate output paths')
    if any(Path(job['input']).resolve()==Path(job['output']).resolve() for job in jobs): parser.error('Cannot replace source media')
    report_file=media.fresh_output(config.report)
    if config.numpy_vendor: sys.path.insert(0,str(Path(config.numpy_vendor).resolve()))
    sys.path.insert(0,str(Path(config.vendor).resolve()))
    model_file=Path(config.model)/'model.bin' if config.engine=='whisper' else Path(config.model)
    settings={'engine':config.engine,'modelSha256':file_sha256(model_file),'threads':config.threads,
              'beam':config.beam,'vad':config.vad,'wordTimestamps':config.engine=='whisper',
              'conditionOnPreviousText':False,'chunkSeconds':config.chunk_seconds,'overlapSeconds':config.overlap_seconds,
              'runnerSchema':2}
    if config.engine=='whisper':
        from faster_whisper import WhisperModel
        model=WhisperModel(config.model,device='cpu',compute_type='int8',cpu_threads=config.threads,local_files_only=True)
        settings['runtimeVersion']=__import__('faster_whisper').__version__
    else:
        if not config.tokens: parser.error('SenseVoice requires --tokens')
        import sherpa_onnx
        settings['tokensSha256']=file_sha256(config.tokens); settings['runtimeVersion']=sherpa_onnx.__version__
        model=sherpa_onnx.OfflineRecognizer.from_sense_voice(model=config.model,tokens=config.tokens,
                num_threads=config.threads,provider='cpu',language='',use_itn=True)
    report={'complete':False,'settings':settings,'jobs':[],'status':'running'}
    report_file.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    failures=0
    for number,job in enumerate(jobs,1):
        clock_start=time.perf_counter(); row={'input':job['input'],'output':job['output']}
        try:
            signature=job_signature(job,settings)
            if completed_matches(job['output'],signature): row['status']='reused_matching_complete_draft'
            else:
                if Path(job['output']).exists(): raise FileExistsError('Existing result differs; choose a new version')
                args=SimpleNamespace(input=job['input'],output=job['output'],start=job.get('start',0),end=job.get('end'),
                    model=config.model,vendor=config.vendor,ffmpeg=config.ffmpeg,device='cpu',compute_type='int8',
                    language=job.get('language'),threads=config.threads,beam=config.beam,vad=config.vad,
                    word_timestamps=True,condition_on_previous_text=False)
                if config.engine=='whisper': result=media.transcribe(args,inference_model=model)
                else: result=sensevoice_transcribe(args,model,config.chunk_seconds,config.overlap_seconds)
                artifact=Path(job['output']); data=json.loads(artifact.read_text(encoding='utf-8'))
                data['jobSignature']=signature; data['runtimeSettings']=settings
                artifact.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
                row.update(status='automatic_draft_complete',segments=result['segments'])
        except Exception as error:
            failures+=1; row.update(status='failed',error=f'{type(error).__name__}: {error}')
        row['wallSeconds']=round(time.perf_counter()-clock_start,3); report['jobs'].append(row)
        report_file.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({'job':number,'total':len(jobs),**row},ensure_ascii=False),flush=True)
    report.update(complete=failures==0,status='complete' if failures==0 else 'partial_failure',failures=failures)
    report_file.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return 1 if failures else 0


if __name__=='__main__': sys.exit(main())
