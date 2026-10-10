'use strict';
// Adapter only: the user's original TypeScript core remains in --source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const BV = /^BV[0-9A-Za-z]{10}$/;
const MANIFEST = 'download-manifest.json';
const HELP = `Bilibili media adapter (uses a user-supplied BilibiliVideoDownload 3.3.x source)
node download.cjs --url BVxxxxxxxxxx --source <source-directory> [options]
  --output <directory>   Required for downloads, not --info
  --ffmpeg <executable>  Required for downloads, not --info
  --parts 1,3-4|all      Explicit selected pages (required without URL p= for downloads)
  --mode audio|video    Default video; audio downloads only AAC audio bytes
  --quality <id>        Video quality request ID, default 80; lower available ID allowed
  --deps <directory>    Existing dependency package root (default --source)
  --session-file <file> Optional Windows DPAPI encrypted session; never logs it
  --info                Public metadata only; does not create output or decrypt credentials
  --help                Offline help; does not load dependencies or access network
Authentication is separate. No browser launch, QR login, or automatic cache deletion.
`;

class AdapterError extends Error {}
function fail(message) { throw new AdapterError(message); }
function positiveInteger(value, label) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail(`Invalid ${label}`);
  return Number(value);
}
function parseVideoInput(value) {
  if (BV.test(value)) return { bvid: value, page: null };
  let url;
  try { url = new URL(value); } catch { fail('Use a BV ID or canonical bilibili.com video URL'); }
  if (url.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com'].includes(url.hostname) || url.port || url.username || url.password) fail('Only public HTTPS bilibili.com video URLs are accepted');
  const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/);
  if (!match || url.searchParams.getAll('p').length > 1) fail('Invalid BV video URL or duplicate page parameter');
  const page = url.searchParams.has('p') ? positiveInteger(url.searchParams.get('p'), 'URL page') : null;
  return { bvid: match[1], page };
}
function partsSyntax(value) {
  if (value === 'all') return;
  if (!value || !/^[1-9]\d*(?:-[1-9]\d*)?(?:,[1-9]\d*(?:-[1-9]\d*)?)*$/.test(value)) fail('Use --parts 1,3-4 with positive page numbers');
}
function parseParts(value, available) {
  partsSyntax(value);
  if (value === 'all') return [...new Set(available)].sort((a, b) => a - b);
  const allowed = new Set(available);
  const selected = new Set();
  for (const token of value.split(',')) {
    const [startValue, endValue = startValue] = token.split('-');
    const start = positiveInteger(startValue, 'page');
    const end = positiveInteger(endValue, 'page');
    if (end < start || end - start + 1 > allowed.size) fail('Invalid or out-of-range page interval');
    for (let page = start; page <= end; page++) {
      if (!allowed.has(page)) fail(`Page ${page} is not in this video`);
      selected.add(page);
    }
  }
  return [...selected].sort((a, b) => a - b);
}
function parseArgs(argv) {
  const opts = { mode: 'video', quality: 80 };
  const seen = new Set();
  const values = new Set(['url', 'source', 'output', 'ffmpeg', 'session-file', 'parts', 'mode', 'quality', 'deps']);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) fail('Arguments must use named --options');
    const key = token.slice(2);
    if ((!values.has(key) && !['help', 'info'].includes(key)) || seen.has(key)) fail('Unknown or repeated argument');
    seen.add(key);
    if (values.has(key)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail(`Missing value for --${key}`);
      opts[key] = value;
    } else opts[key] = true;
  }
  if (opts.help) return opts;
  if (!opts.url || !opts.source) fail('--url and --source are required');
  Object.assign(opts, parseVideoInput(opts.url));
  if (!['audio', 'video'].includes(opts.mode)) fail('--mode must be audio or video');
  opts.quality = positiveInteger(opts.quality, 'quality ID');
  if (opts.parts) {
    partsSyntax(opts.parts);
    if (opts.page !== null) fail('Choose either a URL p= page or --parts, not both');
  }
  if (!opts.info && (!opts.output || !opts.ffmpeg)) fail('Downloads require --output and --ffmpeg');
  if (!opts.info && !opts.parts && opts.page === null) fail('Downloads require explicit --parts (or --parts all) or a URL p= page');
  return opts;
}
function safeFilename(value) {
  let name = String(value).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').trim().replace(/[. ]+$/g, '').slice(0, 100).replace(/[. ]+$/g, '');
  if (!name || /^\.+$/.test(name)) name = 'untitled';
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function outputPath(root, filename) {
  if (!filename || filename === '.' || filename === '..' || /[\\/:\x00]/.test(filename) || path.isAbsolute(filename)) fail('Output filename must be a single safe basename');
  const target = path.resolve(root, filename);
  if (!inside(path.resolve(root), target)) fail('Output path escapes its directory');
  return target;
}
function checkedPath(root, filename) {
  const target = outputPath(root, filename);
  if (fs.existsSync(target) && !inside(fs.realpathSync(root), fs.realpathSync(target))) fail('Existing output follows a link outside the output directory');
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) fail('Refusing symbolic-link output');
  return target;
}
function reconcileManifest(existing, bvid, pages) {
  if (existing && existing.bvid !== bvid) fail('Output manifest belongs to another BV; use another output directory');
  if (existing && !Array.isArray(existing.parts)) fail('Malformed existing manifest');
  const previous = new Map((existing?.parts || []).map(part => [part.page, part]));
  return { ...(existing || {}), schemaVersion: 1, bvid, parts: pages.map(page => {
    const old = previous.get(page.page) || {};
    if (old.cid && old.cid !== page.cid) fail(`CID changed for P${page.page}; existing files cannot be reused automatically`);
    return { ...old, page: page.page, cid: page.cid, title: page.part, expectedDuration: page.duration, outputs: { ...(old.outputs || {}) } };
  }) };
}
function mediaURL(value) {
  let url;
  try { url = new URL(value); } catch { fail('Missing or invalid media stream'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('Unsupported media stream URL');
  return url.href;
}
function planTransfers(mode, root, stem, streams) {
  if (!['audio', 'video'].includes(mode)) fail('Unknown transfer mode');
  const audio = { kind: 'audio', url: mediaURL(streams.audio), file: outputPath(root, stem + (mode === 'audio' ? '.m4a' : '-audio.m4s')) };
  if (mode === 'audio') return [audio];
  return [{ kind: 'video', url: mediaURL(streams.video), file: outputPath(root, stem + '-video.m4s') }, audio];
}
function selectStreams(dash, mode, quality) {
  const audio = [...(dash?.audio || [])].filter(item => /^mp4a\./.test(item.codecs || '') || (!item.codecs && item.mimeType === 'audio/mp4')).sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  if (!audio) fail('No AAC/MP4 audio stream is available; no implicit transcoding');
  const result = { audio: mediaURL(audio.baseUrl || audio.base_url), audioCodec: audio.codecs || 'AAC', audioBandwidth: audio.bandwidth || null };
  if (mode === 'audio') return result;
  const video = [...(dash.video || [])].filter(item => Number.isInteger(item.id) && item.id <= quality).sort((a, b) => b.id - a.id || (Number(b.codecid === 7) - Number(a.codecid === 7)) || (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  if (!video) fail('No video stream at or below the requested quality; choose another available quality');
  return { ...result, video: mediaURL(video.baseUrl || video.base_url), actualQuality: video.id, videoCodec: video.codecs || video.codecid };
}
function safeError(error) {
  if (error instanceof AdapterError) return error.message;
  const code = /^[A-Z][A-Z0-9_]{1,40}$/.test(error?.code || '') ? error.code : 'ERROR';
  const status = Number.isInteger(error?.response?.statusCode) ? ` HTTP ${error.response.statusCode}` : '';
  return code + status; // Never include upstream message, request URL, headers or stack.
}
function isRetryable(error) {
  if (error instanceof AdapterError) return false;
  return ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH', 'EPIPE'].includes(error?.code) || [500, 502, 503, 504].includes(error?.response?.statusCode);
}
function parseInspection(text, expectedDuration, mode) {
  const match = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const audio = text.match(/Audio: ([^\r\n]+)/);
  const video = text.match(/Video: ([^\r\n]+)/);
  if (!match || !audio || (mode === 'video' && !video)) fail('Output is missing a required media track or duration');
  const duration = +match[1] * 3600 + +match[2] * 60 + +match[3];
  if (!Number.isFinite(expectedDuration) || Math.abs(duration - expectedDuration) > 5) fail('Output duration does not match selected page');
  return { duration, audio: audio[1], ...(mode === 'video' ? { video: video[1] } : {}) };
}
function inspect(file, duration, mode, ffmpeg) {
  if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) fail('Output is not a nonempty regular file');
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  if (probe.error || probe.signal) fail('Unable to inspect media with configured ffmpeg');
  return { ...parseInspection(probe.stderr || '', duration, mode), bytes: fs.statSync(file).size };
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function dependencies(source, deps) {
  const requireAt = Module.createRequire(path.join(path.resolve(deps || source), 'package.json'));
  let version;
  try { version = requireAt('got/package.json').version; } catch { fail('Cannot verify got version; provide CommonJS got 11.8.5 or newer within 11.x'); }
  const release = typeof version === 'string' && version.match(/^11\.(\d+)\.(\d+)$/);
  if (!release || !(Number(release[1]) > 8 || (Number(release[1]) === 8 && Number(release[2]) >= 5))) fail('This adapter requires patched CommonJS got 11 (11.8.5 or newer)');
  let got;
  try { got = requireAt('got'); } catch { fail('Existing got 11 dependency not found; pass --deps to an installed package root'); }
  if (typeof got !== 'function' || typeof got.stream !== 'function') fail('This adapter requires CommonJS got 11');
  return { requireAt, got };
}
function readSession(filename) {
  if (!filename) return '';
  if (process.platform !== 'win32') fail('--session-file supports Windows user/machine DPAPI only');
  const encrypted = fs.readFileSync(path.resolve(filename), 'utf8');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$mediaSecure = ConvertTo-SecureString ([Console]::In.ReadToEnd()); [System.Net.NetworkCredential]::new("", $mediaSecure).Password'], { input: encrypted, encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') } });
  if (result.status !== 0 || !result.stdout.trim()) fail('Cannot decrypt session in this Windows user/machine context');
  const session = result.stdout.trim();
  if (/[\r\n;]/.test(session)) fail('Invalid stored session');
  return session;
}
function loadCore(source, requireAt, bridge, setting) {
  let ts;
  try { ts = requireAt('typescript'); } catch { fail('Existing TypeScript dependency not found'); }
  const originalLoad = Module._load;
  const originalTs = require.extensions['.ts'];
  const originalWindow = global.window;
  const root = path.resolve(source);
  Module._load = function (request, parent, isMain) {
    if (parent?.filename && inside(root, parent.filename)) {
      if (request === '../store') return { store: { settingStore: () => setting }, pinia: {} };
      if (request === 'electron-log') return { info() {}, error() {} };
      if (!request.startsWith('.') && !path.isAbsolute(request)) return requireAt(request);
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  require.extensions['.ts'] = (mod, filename) => {
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    mod._compile(compiled.outputText, filename);
  };
  global.window = { electron: { got: bridge } };
  try {
    const core = require(path.join(root, 'src', 'core', 'bilibili.ts'));
    const ua = require(path.join(root, 'src', 'assets', 'data', 'ua.ts')).default;
    return { core, ua, restore() { Module._load = originalLoad; if (originalTs) require.extensions['.ts'] = originalTs; else delete require.extensions['.ts']; global.window = originalWindow; } };
  } catch {
    Module._load = originalLoad;
    if (originalTs) require.extensions['.ts'] = originalTs; else delete require.extensions['.ts'];
    global.window = originalWindow;
    fail('Source core could not be loaded; check 3.3.x layout and installed dependencies');
  }
}
async function quietCore(operation) {
  const log = console.log;
  console.log = () => {}; // Original parseHtml logs the full object, including temporary stream URLs.
  try { return await operation(); } finally { console.log = log; }
}
function saveManifest(root, manifest) {
  const target = checkedPath(root, MANIFEST);
  const temporary = outputPath(root, `.manifest-${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  fs.renameSync(temporary, target);
}
async function transfer(got, plan, referer, ua) {
  for (const item of plan) {
    if (fs.existsSync(item.file)) fail('Refusing to overwrite an existing stream file');
    await pipeline(got.stream(item.url, { headers: { Referer: referer, 'User-Agent': ua }, retry: { limit: 0 }, timeout: { request: 120000 }, followRedirect: false }), fs.createWriteStream(item.file, { flags: 'wx' }));
  }
}
function finalizeExclusive(temporary, final) {
  // Hard link is exclusive, so a concurrently created user file is never overwritten.
  fs.linkSync(temporary, final);
  // The adapter leaves its stream/temporary files in place intentionally.
}
async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  if (options.help) { process.stdout.write(HELP); return 0; }
  const source = path.resolve(options.source);
  if (!fs.existsSync(path.join(source, 'src', 'core', 'bilibili.ts'))) fail('Source must contain src/core/bilibili.ts');
  const { requireAt, got: baseGot } = dependencies(source, options.deps);
  const got = baseGot.extend({ timeout: { request: 30000 }, retry: { limit: 0 }, followRedirect: false });
  let ua = 'Mozilla/5.0 (compatible; BilibiliMediaAdapter/1.0)';
  const publicURL = `https://www.bilibili.com/video/${options.bvid}/`;
  const response = await got('https://api.bilibili.com/x/web-interface/view', { searchParams: { bvid: options.bvid }, responseType: 'json', headers: { 'User-Agent': ua } });
  if (response.body.code !== 0 || !response.body.data?.pages?.length) fail('Video metadata API rejected this BV or supplied no pages');
  const metadata = response.body.data;
  if (metadata.bvid !== options.bvid || metadata.pages.some(page => !Number.isSafeInteger(page.page) || page.page < 1 || !Number.isSafeInteger(page.cid) || page.cid < 1 || !Number.isFinite(page.duration) || page.duration <= 0)) fail('Video metadata identity or page fields are invalid');
  const selected = options.parts ? parseParts(options.parts, metadata.pages.map(page => page.page)) : options.page !== null ? parseParts(String(options.page), metadata.pages.map(page => page.page)) : metadata.pages.map(page => page.page);
  if (options.info) {
    console.log(JSON.stringify({ bvid: metadata.bvid, title: metadata.title, selected, pages: metadata.pages.map(page => ({ page: page.page, cid: page.cid, title: page.part, duration: page.duration })) }, null, 2));
    return 0;
  }
  const root = path.resolve(options.output);
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) fail('Output must be a directory');
  fs.mkdirSync(root, { recursive: true });
  const manifestFile = checkedPath(root, MANIFEST);
  const existing = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const manifest = reconcileManifest(existing, options.bvid, metadata.pages);
  manifest.title = metadata.title;
  const ffmpegCheck = spawnSync(options.ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  if (ffmpegCheck.status !== 0 || !/ffmpeg version/i.test(ffmpegCheck.stdout || '')) fail('Configured ffmpeg is unavailable; no media bytes were downloaded');
  const session = readSession(options['session-file']);
  const setting = { downloadPath: root, SESSDATA: session, bfeId: '', isFolder: false, setBfeId() {} };
  const playback = new Map();
  const bridge = async (input, config = {}) => {
    const url = new URL(input);
    if (url.hostname !== 'api.bilibili.com') fail('Unsupported source API host');
    if (url.pathname === '/x/player/v2') return { body: { data: { subtitle: { subtitles: [] } } } }; // Subtitles are not requested by this media-only adapter.
    if (url.pathname !== '/x/player/playurl') fail('Unsupported source API operation');
    const cid = url.searchParams.get('cid');
    const result = await got('https://api.bilibili.com/x/player/playurl', { searchParams: { cid, bvid: options.bvid, qn: options.quality, fnval: 80 }, responseType: 'json', headers: { 'User-Agent': ua, Referer: publicURL, ...(session ? { Cookie: `SESSDATA=${session}` } : {}) } });
    if (result.body.code !== 0 || !result.body.data?.dash) fail('Playback API rejected the current identity or returned no DASH streams');
    playback.set(String(cid), result.body.data);
    return result;
  };
  const loaded = loadCore(source, requireAt, bridge, setting);
  ua = loaded.ua || ua;
  try {
    let parsed;
    for (const pageNumber of selected) {
      const record = manifest.parts.find(part => part.page === pageNumber);
      const saved = record.outputs[options.mode];
      const stem = `P${String(pageNumber).padStart(2, '0')} - ${safeFilename(record.title)}`;
      // Reuse legacy runner records when their local file can be freshly verified.
      const legacy = options.mode === 'audio' ? record.audioFile : record.file;
      const filename = saved?.file || (record.status === 'complete' && legacy ? legacy : stem + (options.mode === 'audio' ? '.m4a' : '.mp4'));
      const final = checkedPath(root, filename);
      if (fs.existsSync(final)) {
        const inspection = inspect(final, record.expectedDuration, options.mode, options.ffmpeg);
        const digest = await sha256(final);
        if (saved?.sha256 && saved.sha256 !== digest) fail(`Existing P${pageNumber} output changed; preserving it without downloading`);
        record.outputs[options.mode] = { ...saved, file: filename, status: 'complete', ...inspection, sha256: digest };
        saveManifest(root, manifest);
        console.log(`P${pageNumber}: existing ${options.mode} verified; preserved`);
        continue;
      }
      let complete = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const retainedStreams = record.outputs[options.mode]?.retainedStreams || [];
        const state = record.outputs[options.mode] = { file: filename, status: 'downloading', requestedQuality: options.mode === 'video' ? options.quality : null, attempts: attempt, retainedStreams };
        saveManifest(root, manifest);
        try {
          await bridge(`https://api.bilibili.com/x/player/playurl?cid=${record.cid}`);
          if (!parsed) {
            const data = playback.get(String(record.cid));
            const html = '<script>window.__playinfo__=' + JSON.stringify({ data }) + '</script><script>window.__INITIAL_STATE__=' + JSON.stringify({ videoData: metadata }) + ';(function()';
            parsed = await quietCore(() => loaded.core.parseHtml(html, 'BV', publicURL));
          }
          if (options.mode === 'video') {
            // Force the original per-page core to refresh, never reuse the first page's cached URL.
            await quietCore(() => loaded.core.getDownloadList({ ...parsed, video: [], audio: [] }, [pageNumber], options.quality));
          }
          const streams = selectStreams(playback.get(String(record.cid))?.dash, options.mode, options.quality);
          const runStem = stem + '-' + crypto.randomUUID();
          const plan = planTransfers(options.mode, root, runStem, streams);
          state.retainedStreams.push(...plan.map(item => path.basename(item.file)));
          state.actualQuality = streams.actualQuality ?? null;
          state.audioCodec = streams.audioCodec;
          saveManifest(root, manifest);
          await transfer(got, plan, publicURL + '?p=' + pageNumber, ua);
          let temporary = plan[0].file;
          if (options.mode === 'video') {
            temporary = outputPath(root, runStem + '.mp4');
            state.retainedStreams.push(path.basename(temporary));
            const merge = spawnSync(options.ffmpeg, ['-hide_banner', '-v', 'error', '-n', '-i', plan[0].file, '-i', plan[1].file, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', temporary], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
            if (merge.status !== 0) fail('ffmpeg could not remux the downloaded streams');
          }
          const inspection = inspect(temporary, record.expectedDuration, options.mode, options.ffmpeg);
          const digest = await sha256(temporary);
          finalizeExclusive(temporary, final);
          Object.assign(state, { status: 'complete', ...inspection, sha256: digest });
          delete state.error;
          complete = true;
          saveManifest(root, manifest);
          console.log(`P${pageNumber}: ${options.mode} verified${streams.actualQuality ? `; quality ${options.quality} -> ${streams.actualQuality}` : ''}`);
          break;
        } catch (error) {
          state.status = 'failed'; state.error = safeError(error);
          saveManifest(root, manifest);
          console.error(`P${pageNumber} attempt ${attempt}: ${state.error}; files retained`);
          if (!isRetryable(error) || fs.existsSync(final)) break;
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
      if (!complete) { manifest.updatedAt = new Date().toISOString(); saveManifest(root, manifest); return 1; }
    }
    manifest.updatedAt = new Date().toISOString();
    saveManifest(root, manifest);
    return 0;
  } finally { loaded.restore(); }
}

module.exports = { AdapterError, parseVideoInput, parseParts, parseArgs, safeFilename, outputPath, reconcileManifest, planTransfers, selectStreams, safeError, isRetryable, parseInspection, dependencies, loadCore, quietCore, main };
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(`Adapter stopped: ${safeError(error)}. Check source, dependencies, identity and local paths; no automatic cleanup.`); process.exitCode = 1; });
