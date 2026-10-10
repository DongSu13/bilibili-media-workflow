"""Local media inspection, extraction and draft evidence. No network/model download."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time


def local_file(value):
    path=Path(value).resolve()
    if not path.is_file():
        raise FileNotFoundError('Local input file not found')
    return path


def fresh_output(value):
    path=Path(value).resolve()
    if path.exists():
        raise FileExistsError('Output exists; choose a new name/version')
    path.parent.mkdir(parents=True,exist_ok=True)
    return path


def run_ffmpeg(args, ffmpeg):
    result=subprocess.run([str(ffmpeg),'-hide_banner','-v','error',*args],capture_output=True)
    if result.returncode:
        raise RuntimeError('ffmpeg failed; check input, codec/container and available build capabilities')
    return result


def inspect_media(source, ffmpeg='ffmpeg', ffprobe=None):
    source=local_file(source)
    if ffprobe:
        result=subprocess.run([str(ffprobe),'-v','error','-show_format','-show_streams','-of','json',str(source)],capture_output=True,text=True)
        if result.returncode:
            raise RuntimeError('ffprobe failed')
        data=json.loads(result.stdout)
        video=[{'codec':s.get('codec_name'),'width':s.get('width'),'height':s.get('height')} for s in data['streams'] if s['codec_type']=='video']
        audio=[{'codec':s.get('codec_name'),'sampleRate':s.get('sample_rate'),'channels':s.get('channels')} for s in data['streams'] if s['codec_type']=='audio']
        duration=float(data['format']['duration'])
        method='ffprobe'
    else:
        # ffmpeg -i deliberately exits nonzero when no output is requested.
        result=subprocess.run([str(ffmpeg),'-hide_banner','-i',str(source)],capture_output=True,text=True,errors='replace')
        text=result.stderr
        stamp=re.search(r'Duration: (\d+):(\d+):(\d+(?:\.\d+)?)',text)
        if not stamp:
            raise RuntimeError('Cannot read media duration')
        duration=int(stamp[1])*3600+int(stamp[2])*60+float(stamp[3])
        video=[]; audio=[]
        for line in text.splitlines():
            match=re.search(r'Video: ([\w]+)',line)
            if match:
                size=re.search(r'\b([1-9]\d{1,4})x([1-9]\d{1,4})\b',line)
                video.append({'codec':match[1],'width':int(size[1]) if size else None,'height':int(size[2]) if size else None})
            match=re.search(r'Audio: ([\w]+)',line)
            if match:
                audio.append({'codec':match[1]})
        method='ffmpeg header probe'
    if not math.isfinite(duration) or duration<=0 or not (video or audio):
        raise ValueError('Invalid media duration or missing streams')
    return {'file':str(source),'bytes':source.stat().st_size,'duration':duration,'video':video,'audio':audio,'method':method,'fullDecodeVerified':False}


def selected_range(duration,start=0,end=None):
    end=duration if end is None else end
    if not all(math.isfinite(x) for x in [start,end]) or start<0 or end<=start or end>duration+.25:
        raise ValueError('Invalid source time range')
    return start,min(end,duration)


def export_audio(source, output, ffmpeg='ffmpeg', output_format='copy', start=0,end=None):
    info=inspect_media(source,ffmpeg=ffmpeg)
    if not info['audio']:
        raise ValueError('Source has no audio')
    start,end=selected_range(info['duration'],start,end)
    output=fresh_output(output)
    suffix=output.suffix.lower()
    if output_format=='copy':
        compatible={'aac':{'.m4a','.mp4'},'mp3':{'.mp3'},'opus':{'.ogg','.opus'},'vorbis':{'.ogg'},'flac':{'.flac'}}
        if suffix not in compatible.get(info['audio'][0]['codec'],set()):
            raise ValueError('Copy output container is incompatible; choose WAV/MP3 or a matching extension')
        codec=['-c:a','copy']
    elif output_format=='wav' and suffix=='.wav':
        codec=['-c:a','pcm_s16le','-ac','1','-ar','16000']
    elif output_format=='mp3' and suffix=='.mp3':
        codec=['-c:a','libmp3lame','-q:a','2']
    else:
        raise ValueError('Format and output extension do not match')
    run_ffmpeg(['-n','-ss',str(start),'-i',str(local_file(source)),'-t',str(end-start),'-map','0:a:0','-vn',*codec,str(output)],ffmpeg)
    result=inspect_media(output,ffmpeg=ffmpeg)
    if not result['audio'] or abs(result['duration']-(end-start))>1:
        raise ValueError('Extracted audio failed duration/stream check; output preserved for diagnosis')
    result.update({'source':str(local_file(source)),'start':start,'end':end,'boundaryAccuracy':'approximate' if output_format=='copy' else 'reencoded'})
    return result


def extract_frames(source, output, ffmpeg='ffmpeg', interval=15,start=0,end=None,width=1280):
    if not math.isfinite(interval) or interval<=0 or width<2:
        raise ValueError('Frame interval and width must be positive')
    info=inspect_media(source,ffmpeg=ffmpeg)
    if not info['video']:
        raise ValueError('Source has no video')
    start,end=selected_range(info['duration'],start,end)
    folder=fresh_output(output); folder.mkdir()
    index=[]; count=math.ceil((end-start)/interval)
    for number in range(count):
        timestamp=start+number*interval
        frame=folder/f'frame-{number+1:05d}.jpg'
        run_ffmpeg(['-n','-ss',str(timestamp),'-i',str(local_file(source)),'-frames:v','1','-vf',f'scale={width}:-2','-q:v','3',str(frame)],ffmpeg)
        if not frame.exists():
            raise RuntimeError('Frame was not emitted; partial folder preserved')
        index.append({'time':timestamp,'file':str(frame),'source':str(local_file(source)),'timeMethod':'requested seek, subject to decoder accuracy'})
    (folder/'index.json').write_text(json.dumps(index,ensure_ascii=False,indent=2),encoding='utf-8')
    return index


def audit_subtitles(paths,expected_duration=None):
    if expected_duration is not None and (not math.isfinite(expected_duration) or expected_duration<=0):
        raise ValueError('Expected duration must be positive')
    results=[]; hashes={}; text_hashes={}
    for path in paths:
        path=local_file(path); data=json.loads(path.read_text(encoding='utf-8-sig'))
        body=data.get('body') if isinstance(data,dict) else None
        entry={'file':str(path),'contentStatus':'unverified','issues':[],'duplicateWith':[],'duplicateTextWith':[],'incomplete':None}
        if not isinstance(body,list):
            entry['issues'].append('invalid_body'); results.append(entry); continue
        if not body:
            entry['issues'].append('empty')
        normalized=[]; last=0
        for row in body:
            if not isinstance(row,dict):
                entry['issues'].append('invalid_row'); continue
            begin,finish=row.get('from'),row.get('to')
            text=row.get('content','')
            if not isinstance(text,str) or not text.strip():
                entry['issues'].append('empty_text')
            if any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) for x in [begin,finish]):
                entry['issues'].append('invalid_timestamp'); continue
            if begin<0 or finish<begin or (expected_duration is not None and finish>expected_duration+2):
                entry['issues'].append('timestamp_out_of_range')
            last=max(last,finish)
            normalized.append([begin,finish,text])
        entry.update({'lineCount':len(body),'lastTimestamp':last,'incomplete':last<expected_duration-30 if expected_duration else None})
        digest=hashlib.sha256(json.dumps(normalized,ensure_ascii=False).encode()).hexdigest()
        entry['contentSha256']=digest
        if normalized:
            hashes.setdefault(digest,[]).append(entry)
            text_only='\n'.join(re.sub(r'\s+',' ',str(row[2])).strip() for row in normalized)
            text_digest=hashlib.sha256(text_only.encode()).hexdigest()
            entry['textSha256']=text_digest
            text_hashes.setdefault(text_digest,[]).append(entry)
        entry['issues']=sorted(set(entry['issues'])); results.append(entry)
    for group in hashes.values():
        if len(group)>1:
            for entry in group:
                entry['duplicateWith']=[other['file'] for other in group if other is not entry]
    for group in text_hashes.values():
        if len(group)>1:
            for entry in group:
                entry['duplicateTextWith']=[other['file'] for other in group if other is not entry]
    return results


def flag_transcript(records):
    for index,record in enumerate(records):
        flags=record.setdefault('reviewFlags',[])
        text=record['text'].strip()
        if index>=2 and text and all(text==records[i]['text'].strip() for i in [index-1,index-2]):
            if 'repeated_text' not in flags: flags.append('repeated_text')
        if record.get('avg_logprob',0)<-1 or record.get('no_speech_prob',0)>.6:
            if 'low_confidence' not in flags: flags.append('low_confidence')
        if record['end']-record['start']>30:
            if 'long_segment' not in flags: flags.append('long_segment')


def transcribe(args,inference_model=None):
    if args.vendor:
        sys.path.insert(0,str(Path(args.vendor).resolve()))
    import numpy as np
    from faster_whisper import WhisperModel
    source=local_file(args.input); output=fresh_output(args.output)
    partial=output.with_suffix('.partial.jsonl')
    if partial.exists(): raise FileExistsError('Partial transcript exists; choose new output')
    if not Path(args.model).is_dir(): raise ValueError('Provide an existing local Whisper model directory')
    info=inspect_media(source,ffmpeg=args.ffmpeg)
    start,end=selected_range(info['duration'],args.start,args.end)
    if end-start>1800:
        raise ValueError('Select segments up to 30 minutes; merge time-indexed outputs afterwards')
    decoded=run_ffmpeg(['-ss',str(start),'-i',str(source),'-t',str(end-start),'-vn','-ac','1','-ar','16000','-f','f32le','pipe:1'],args.ffmpeg)
    waveform=np.frombuffer(decoded.stdout,dtype=np.float32)
    model=inference_model if inference_model is not None else WhisperModel(args.model,device=args.device,compute_type=args.compute_type,cpu_threads=args.threads,local_files_only=True)
    options={'language':args.language,'beam_size':args.beam,
             'vad_filter':getattr(args,'vad','on')=='on',
             'word_timestamps':getattr(args,'word_timestamps',False),
             'condition_on_previous_text':getattr(args,'condition_on_previous_text',True)}
    clock_start=time.perf_counter()
    segments,detected=model.transcribe(waveform,**options)
    records=[]
    with partial.open('x',encoding='utf-8') as stream:
        for segment in segments:
            record={'start':segment.start+start,'end':segment.end+start,'text':segment.text.strip(),'avg_logprob':segment.avg_logprob,'no_speech_prob':segment.no_speech_prob}
            if options['word_timestamps']:
                record['words']=[{'start':w.start+start,'end':w.end+start,
                                  'word':w.word,'probability':w.probability} for w in segment.words or []]
            records.append(record); flag_transcript(records)
            stream.write(json.dumps(record,ensure_ascii=False)+'\n'); stream.flush()
    result={'source':str(source),'start':start,'end':end,'complete':True,'contentStatus':'automatic_draft_unverified',
            'audioInterpretationStatus':'not_verified_by_asr','model':Path(args.model).name,
            'device':args.device,'computeType':args.compute_type,'language':detected.language,
            'options':options,'inferenceSeconds':round(time.perf_counter()-clock_start,3),'segments':records}
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    return {'file':str(output),'segments':len(records),'contentStatus':result['contentStatus']}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    for name in ['inspect','audio','frames','transcribe']:
        p=commands.add_parser(name); p.add_argument('--input',required=True); p.add_argument('--ffmpeg',default='ffmpeg')
        if name=='inspect': p.add_argument('--ffprobe')
        else:
            p.add_argument('--output',required=True); p.add_argument('--start',type=float,default=0); p.add_argument('--end',type=float)
        if name=='audio': p.add_argument('--format',choices=['copy','wav','mp3'],default='copy')
        if name=='frames': p.add_argument('--interval',type=float,default=15); p.add_argument('--width',type=int,default=1280)
        if name=='transcribe':
            p.add_argument('--model',required=True); p.add_argument('--vendor'); p.add_argument('--device',choices=['cpu','cuda','auto'],default='cpu'); p.add_argument('--compute-type',default='int8'); p.add_argument('--language'); p.add_argument('--threads',type=int,default=4); p.add_argument('--beam',type=int,default=3)
            p.add_argument('--vad',choices=['on','off'],default='on',help='Disable for short sounds; test both on representative material')
            p.add_argument('--word-timestamps',action='store_true')
            p.add_argument('--condition-on-previous-text',action=argparse.BooleanOptionalAction,default=True)
    p=commands.add_parser('audit'); p.add_argument('--subtitles',nargs='+',required=True); p.add_argument('--duration',type=float); p.add_argument('--output')
    args=parser.parse_args()
    if args.command=='inspect': result=inspect_media(args.input,args.ffmpeg,args.ffprobe)
    elif args.command=='audio': result=export_audio(args.input,args.output,args.ffmpeg,args.format,args.start,args.end)
    elif args.command=='frames': result=extract_frames(args.input,args.output,args.ffmpeg,args.interval,args.start,args.end,args.width)
    elif args.command=='transcribe': result=transcribe(args)
    else:
        result=audit_subtitles(args.subtitles,args.duration)
        if args.output: fresh_output(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':
    try: main()
    except Exception as error:
        print(f'{type(error).__name__}: {error}',file=sys.stderr); sys.exit(1)
