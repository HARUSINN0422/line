const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const exec = promisify(execFile);
const PORT = Number(process.env.PORT || 4000);
const ADB = process.env.ADB || 'adb';
const PUBLIC = path.join(__dirname, 'public');
const UPDATE_INTERVAL = 60 * 1000;
const REPO_BRANCH = 'main';

function allowed(ip) {
  ip = (ip || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1' ||
    /^192\.168\.1\.\d+$/.test(ip);
}

// ADB操作を直列化し、uiautomator dumpの同時実行を防ぐ
let adbQueue = Promise.resolve();
function adb(args, timeout = 15000) {
  const task = adbQueue.then(async () => {
    const result = await exec(ADB, args, {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8'
    });
    return result.stdout.trim();
  });
  adbQueue = task.catch(() => {});
  return task;
}

function attrs(xml) {
  const result = {};
  for (const m of xml.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    result[m[1]] = m[2]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }
  return result;
}

async function getScreen() {
  await adb(['shell', 'uiautomator', 'dump', '/sdcard/line-control.xml'], 20000);
  return adb(['exec-out', 'cat', '/sdcard/line-control.xml'], 10000);
}

async function status() {
  let connected = false;
  let running = false;
  let title = '';
  try {
    connected = (await adb(['get-state'])) === 'device';
    if (connected) {
      running = !!(await adb(['shell', 'pidof', 'jp.naver.line.android']));
      const xml = await getScreen();
      for (const m of xml.matchAll(/<node\b[^>]*\/?\s*>/g)) {
        const a = attrs(m[0]);
        if (a['resource-id'] === 'jp.naver.line.android:id/header_title') {
          title = a.text || '';
        }
      }
    }
  } catch (e) {
    console.error('[ADB status]', e.message);
  }
  return { connected, running, title };
}

async function action(name) {
  if ((await adb(['get-state'])) !== 'device') {
    throw new Error('ADBがAndroidに接続されていません');
  }

  if (name === 'launch') {
    await adb(['shell', 'am', 'start', '-n', 'jp.naver.line.android/.activity.SplashActivity']);
    return 'LINEを起動しました';
  }

  if (name === 'start') {
    await adb(['shell', 'am', 'start', '-n', 'jp.naver.line.android/.activity.SplashActivity']);
    await new Promise(r => setTimeout(r, 1500));
    const xml = await getScreen();

    let target = null;
    for (const m of xml.matchAll(/<node\b[^>]*\/?\s*>/g)) {
      const a = attrs(m[0]);
      if (
        a['resource-id'] ===
        'jp.naver.line.android:id/chat_ui_group_call_header_starter_voice_button' &&
        a.clickable === 'true'
      ) {
        target = a;
        break;
      }
    }

    if (!target) {
      throw new Error('グループの音声通話ボタンが見つかりません。LINEで対象グループのトークを開いてください');
    }

    const b = (target.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) throw new Error('通話ボタンの位置を読み取れません');

    const x = Math.round((Number(b[1]) + Number(b[3])) / 2);
    const y = Math.round((Number(b[2]) + Number(b[4])) / 2);
    await adb(['shell', 'input', 'tap', String(x), String(y)]);
    return 'グループの音声通話ボタンを操作しました';
  }

  throw new Error('未対応の操作です');
}

let updating = false;
let restarting = false;

async function checkForUpdates() {
  if (updating || restarting) return;
  updating = true;
  try {
    await exec('git', ['fetch', 'origin', REPO_BRANCH], {
      cwd: __dirname, timeout: 60000, maxBuffer: 2 * 1024 * 1024
    });

    const local = (await exec('git', ['rev-parse', 'HEAD'], { cwd: __dirname })).stdout.trim();
    const remote = (await exec('git', ['rev-parse', 'origin/' + REPO_BRANCH], { cwd: __dirname })).stdout.trim();

    if (local === remote) return;

    // ローカル変更を上書きしない。fast-forwardできる場合だけ更新する
    await exec('git', ['merge', '--ff-only', 'origin/' + REPO_BRANCH], {
      cwd: __dirname, timeout: 60000, maxBuffer: 2 * 1024 * 1024
    });

    console.log('[update] GitHubの更新を取得しました:', remote.slice(0, 7));
    restarting = true;
    server.close(() => {
      const child = spawn(process.execPath, [__filename], {
        cwd: __dirname,
        stdio: 'inherit',
        env: process.env
      });
      child.once('error', err => {
        console.error('[update] 再起動に失敗:', err);
        process.exit(1);
      });
      child.once('spawn', () => process.exit(0));
    });
  } catch (e) {
    console.error('[update] 更新確認/取得に失敗:', e.stderr || e.message);
  } finally {
    updating = false;
  }
}

const server = http.createServer(async (req, res) => {
  if (!allowed(req.socket.remoteAddress)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    try {
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const s = await status();
        res.end(JSON.stringify(s));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/action') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 10000) throw new Error('リクエストが大きすぎます');
        }
        const data = JSON.parse(body || '{}');
        const message = await action(data.action);
        res.end(JSON.stringify({ ok: true, message }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }

  const file = path.join(PUBLIC, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('index.htmlを読み込めません');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LINE Control Site: http://192.168.1.3:${PORT}`);
  console.log(`GitHub自動更新: ${UPDATE_INTERVAL / 1000}秒ごとに確認 (${REPO_BRANCH})`);
  setTimeout(checkForUpdates, 5000);
  setInterval(checkForUpdates, UPDATE_INTERVAL);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
