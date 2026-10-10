'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const adapterPath = path.join(__dirname, 'download.cjs');
assert.ok(fs.existsSync(adapterPath), 'Download adapter must exist before its behavior can pass');
const api = require(adapterPath);
let passed = 0;
function test(name, run) {
  try { run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
}
const bv = 'BV0000000000';
test('BV and canonical public video URLs identify one video', () => {
  assert.deepEqual(api.parseVideoInput(bv), { bvid: bv, page: null });
  assert.deepEqual(api.parseVideoInput(`https://www.bilibili.com/video/${bv}/?p=3`), { bvid: bv, page: 3 });
});
test('foreign hosts, credentials, non-BV paths and malformed page values are rejected', () => {
  for (const value of [`https://evil.example/video/${bv}`, `https://www.bilibili.com.evil.example/video/${bv}`, `https://user:pass@www.bilibili.com/video/${bv}`, 'BV../file', `https://www.bilibili.com/video/${bv}?p=0`, `https://www.bilibili.com/video/${bv}?p=1.5`, `https://www.bilibili.com/video/${bv}?p=1&p=2`]) assert.throws(() => api.parseVideoInput(value));
});
test('parts are sorted, deduplicated and bounded by metadata', () => {
  assert.deepEqual(api.parseParts('4,1,3-4', [1, 2, 3, 4]), [1, 3, 4]);
  for (const value of ['0', '-1', '2-1', '1,,2', '1.2', '99', '1-100000000']) assert.throws(() => api.parseParts(value, [1, 2, 3, 4]));
});
test('all pages require an explicit selector for downloads but not public info', () => {
  const args = ['--url', bv, '--source', 'source', '--output', 'out', '--ffmpeg', 'ffmpeg'];
  assert.throws(() => api.parseArgs(args));
  assert.equal(api.parseArgs([...args, '--parts', 'all']).parts, 'all');
  assert.deepEqual(api.parseParts('all', [1, 2, 3]), [1, 2, 3]);
  assert.equal(api.parseArgs(['--url', bv, '--source', 'source', '--info']).info, true);
  const result = spawnSync(process.execPath, [adapterPath, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 2, 'Missing selection must be rejected before dependency loading or network');
});
test('filenames remove separators and Windows reserved basenames', () => {
  assert.equal(api.safeFilename('a/b:c*?'), 'a_b_c__');
  assert.equal(api.safeFilename('CON'), '_CON');
  assert.equal(api.safeFilename('  ..  '), 'untitled');
  assert.ok(api.safeFilename('x'.repeat(300)).length <= 100);
});
test('output paths cannot contain traversal, drive paths or alternate data streams', () => {
  const root = path.resolve('output-fixture');
  assert.equal(api.outputPath(root, 'P01 - title.m4a'), path.join(root, 'P01 - title.m4a'));
  for (const name of ['../outside', '..\\outside', 'C:\\outside', '/outside', 'file:secret', '.', '']) assert.throws(() => api.outputPath(root, name));
});
test('manifests reject another video and preserve prior per-page outputs', () => {
  assert.throws(() => api.reconcileManifest({ bvid: 'BV1xx411c7mD', parts: [] }, bv, [{ page: 1, cid: 10, part: 'A', duration: 8 }]));
  const old = { bvid: bv, parts: [{ page: 1, outputs: { audio: { status: 'complete', file: 'kept.m4a', bytes: 20 } } }] };
  const next = api.reconcileManifest(old, bv, [{ page: 1, cid: 10, part: 'A', duration: 8 }, { page: 2, cid: 11, part: 'B', duration: 10 }]);
  assert.deepEqual(next.parts[0].outputs.audio, { status: 'complete', file: 'kept.m4a', bytes: 20 });
  assert.equal(next.parts.length, 2);
  assert.equal(old.parts.length, 1);
});
test('audio transfer plan never schedules video bytes', () => {
  const root = path.resolve('output-fixture');
  const plan = api.planTransfers('audio', root, 'sample', { audio: 'https://audio.example/a', video: 'https://video.example/v' });
  assert.deepEqual(plan.map(item => item.kind), ['audio']);
  assert.equal(plan[0].url, 'https://audio.example/a');
  assert.equal(plan[0].file, path.join(root, 'sample.m4a'));
  assert.throws(() => api.planTransfers('audio', root, 'sample', { video: 'https://video.example/v' }));
});
test('video plan schedules two streams without overwriting final output', () => {
  const plan = api.planTransfers('video', path.resolve('output-fixture'), 'sample', { audio: 'https://a.example/a', video: 'https://v.example/v' });
  assert.deepEqual(plan.map(item => item.kind), ['video', 'audio']);
  assert.notEqual(plan[0].file, plan[1].file);
});
test('stream selection uses bitrate, prefers AAC and records video downgrade', () => {
  const dash = { audio: [{ id: 30280, mimeType: 'audio/mp4', codecs: 'mp4a.40.2', bandwidth: 64000, baseUrl: 'https://a.example/low' }, { id: 30216, mimeType: 'audio/mp4', codecs: 'mp4a.40.2', bandwidth: 128000, baseUrl: 'https://a.example/high' }, { id: 30250, codecs: 'ec-3', bandwidth: 256000, baseUrl: 'https://a.example/not-aac' }], video: [{ id: 64, codecid: 7, bandwidth: 500000, baseUrl: 'https://v.example/64' }, { id: 120, codecid: 7, bandwidth: 5000000, baseUrl: 'https://v.example/120' }] };
  const result = api.selectStreams(dash, 'video', 80);
  assert.equal(result.audio, 'https://a.example/high');
  assert.equal(result.actualQuality, 64);
  assert.equal(result.video, 'https://v.example/64');
  const audio = api.selectStreams({ ...dash, video: [] }, 'audio', 80);
  assert.equal(audio.video, undefined);
  assert.throws(() => api.selectStreams({ audio: [{ codecs: 'ec-3', baseUrl: 'https://a.example/e' }] }, 'audio', 80));
});
test('arguments reject misspellings, duplicates, conflicting selection and unknown modes', () => {
  const args = ['--url', bv, '--source', 'source', '--output', 'out', '--ffmpeg', 'ffmpeg', '--parts', '1'];
  assert.equal(api.parseArgs(args).mode, 'video');
  assert.equal(api.parseArgs(args).quality, 80);
  for (const extra of [['--moed', 'audio'], ['--url', bv], ['--mode', 'both'], ['--quality', '80x'], ['--parts', 'all'], ['--parts', '0']]) assert.throws(() => api.parseArgs([...args, ...extra]));
  assert.throws(() => api.parseArgs(['--url', `https://www.bilibili.com/video/${bv}?p=2`, '--parts', '3', '--source', 'source', '--output', 'out', '--ffmpeg', 'ffmpeg']));
});
test('error logs suppress cookies, signatures and arbitrary server messages', () => {
  const error = new Error('Cookie: SESSDATA=secret; https://cdn.example/file?token=secret');
  error.code = 'ETIMEDOUT'; error.response = { statusCode: 403 };
  const summary = api.safeError(error);
  assert.ok(!summary.includes('secret') && !summary.includes('cdn.example'));
  assert.match(summary, /403/);
});
test('media inspection rejects absent tracks and inaccurate duration', () => {
  const probe = 'Duration: 00:00:12.50, start: 0.000\n Stream #0:0: Audio: aac, 44100 Hz\n';
  assert.equal(api.parseInspection(probe, 12, 'audio').duration, 12.5);
  assert.throws(() => api.parseInspection(probe, 12, 'video'));
  assert.throws(() => api.parseInspection(probe, 40, 'audio'));
});
test('bridge errors stay useful without exposing upstream details', () => {
  assert.match(api.safeError(new api.AdapterError('Source layout does not match')), /Source layout/);
});
test('only temporary network and server failures are retried', () => {
  assert.equal(api.isRetryable({ code: 'ETIMEDOUT' }), true);
  assert.equal(api.isRetryable({ response: { statusCode: 503 } }), true);
  for (const error of [{ response: { statusCode: 403 } }, { response: { statusCode: 412 } }, { response: { statusCode: 429 } }, { code: 'EACCES' }, new api.AdapterError('Playback identity rejected')]) assert.equal(api.isRetryable(error), false);
});
test('offline help exits successfully without source, dependencies or network', () => {
  const result = spawnSync(process.execPath, [adapterPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--mode/);
});
async function coreIntegration() {
  if (!process.env.BILIBILI_CORE_SOURCE) return;
  const { requireAt } = api.dependencies(process.env.BILIBILI_CORE_SOURCE, process.env.BILIBILI_CORE_DEPS);
  let requests = 0;
  const dash = { video: [{ id: 80, codecid: 7, baseUrl: 'https://video.example/fixture', bandwidth: 300000 }], audio: [{ id: 30280, mimeType: 'audio/mp4', codecs: 'mp4a.40.2', baseUrl: 'https://audio.example/fixture', bandwidth: 128000 }] };
  const bridge = async url => {
    requests++;
    return new URL(url).pathname === '/x/player/v2' ? { body: { data: { subtitle: { subtitles: [] } } } } : { body: { data: { dash } }, headers: {} };
  };
  const loaded = api.loadCore(process.env.BILIBILI_CORE_SOURCE, requireAt, bridge, { downloadPath: path.resolve('output-fixture'), SESSDATA: '', bfeId: '', isFolder: false, setBfeId() {} });
  try {
    const metadata = { bvid: bv, cid: 10, title: 'Fixture', pic: '', duration: 8, stat: { view: 1, danmaku: 0, reply: 0 }, owner: { name: 'Fixture', mid: 1 }, pages: [{ page: 1, cid: 10, part: 'One', duration: 8 }, { page: 2, cid: 11, part: 'Two', duration: 9 }] };
    const html = '<script>window.__playinfo__=' + JSON.stringify({ data: { dash, accept_quality: [80] } }) + '</script><script>window.__INITIAL_STATE__=' + JSON.stringify({ videoData: metadata }) + ';(function()';
    const parsed = await api.quietCore(() => loaded.core.parseHtml(html, 'BV', `https://www.bilibili.com/video/${bv}/`));
    assert.equal(parsed.page[1].cid, 11);
    assert.equal(requests, 0, 'Seeded metadata parser must not fetch or print signed URLs');
    const [task] = await api.quietCore(() => loaded.core.getDownloadList({ ...parsed, video: [], audio: [] }, [2], 80));
    assert.equal(task.cid, 11);
    assert.equal(task.downloadUrl.audio, 'https://audio.example/fixture');
    assert.equal(requests, 2, 'Original core refreshes playback and requests subtitle metadata');
    assert.deepEqual(api.planTransfers('audio', path.resolve('output-fixture'), 'sample', api.selectStreams(dash, 'audio', 80)).map(item => item.kind), ['audio']);
    passed++;
    console.log('PASS actual supplied core parses metadata and selects second-page streams offline');
  } finally { loaded.restore(); }
}
coreIntegration().then(() => { console.log(`${passed} tests passed`); }).catch(error => { console.error(`FAIL supplied-core integration: ${error.message}`); process.exitCode = 1; });
