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

const LOCK_FILE = path.join(__dirname, '.line-server.lock');
const managedChildren = new Map();
let lockOwned = false;
let containerStartedByServer = false;
let sessionStartedByServer = false;
let shuttingDown = false;

function acquireInstanceLock() {
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    lockOwned = true;
    return;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  let oldPid = 0;
  try { oldPid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()); } catch (_) {}
  if (oldPid > 0) {
    try {
      process.kill(oldPid, 0);
      throw new Error('LINEサーバーは既に起動しています (PID ' + oldPid + ')');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
  try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    lockOwned = true;
  } catch (e) {
    throw new Error('LINEサーバーの起動ロックを取得できません: ' + e.message);
  }
}

function releaseInstanceLock() {
  if (!lockOwned) return;
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
  lockOwned = false;
}

async function cleanupManagedResources() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[cleanup] server.jsが起動したプロセスを終了します');

  const groups = [...managedChildren.entries()];
  for (const [pid, label] of groups) {
    try {
      process.kill(-pid, 'SIGTERM');
      console.log('[cleanup] ' + label + 'を終了しました (PID ' + pid + ')');
    } catch (e) {
      if (e.code !== 'ESRCH') console.error('[cleanup] ' + label + '終了失敗:', e.message);
    }
  }
  managedChildren.clear();

  // このserver.jsが開始したセッションだけを停止する
  if (sessionStartedByServer) {
    try {
      await exec('waydroid', ['session', 'stop'], {
        timeout: 25000, maxBuffer: 1024 * 1024, env: waydroidEnvironment()
      });
      console.log('[cleanup] Waydroidセッションを停止しました');
    } catch (_) {}
    sessionStartedByServer = false;
  }

  if (containerStartedByServer) {
    try {
      await exec('sudo', ['-n', '/usr/bin/systemctl', 'stop', 'waydroid-container'], {
        timeout: 30000, maxBuffer: 1024 * 1024, env: waydroidEnvironment()
      });
      console.log('[cleanup] Waydroidコンテナを停止しました');
    } catch (e) {
      console.error('[cleanup] Waydroidコンテナ停止失敗:', e.stderr || e.message);
    }
    containerStartedByServer = false;
  }
}


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
  // 古いXMLを使い回さない。UIAutomatorが一時的にnullを返す場合は再試行する
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await adb(['shell', 'rm', '-f', '/sdcard/line-control.xml']);
      await new Promise(r => setTimeout(r, 350));
      const output = await adb(['shell', 'uiautomator', 'dump', '/sdcard/line-control.xml'], 25000);
      if (!output.includes('UI hierchary dumped')) throw new Error(output || '画面XMLを取得できません');
      const xml = await adb(['exec-out', 'cat', '/sdcard/line-control.xml'], 10000);
      if (xml.includes('<hierarchy') && xml.includes('</hierarchy>')) return xml;
    } catch (e) {
      if (attempt === 2) throw new Error('LINE画面の取得に失敗しました: ' + e.message);
    }
    await new Promise(r => setTimeout(r, 900));
  }
  throw new Error('LINE画面のXMLが空です');
}

function parseChatRows(xml) {
  const root = { children: [] };
  const stack = [root];
  const tokens = xml.match(/<node\b[^>]*\/>|<node\b[^>]*>|<\/node>/g) || [];
  for (const token of tokens) {
    if (token.startsWith('</node')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = { attrs: attrs(token), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!token.endsWith('/>')) stack.push(node);
  }

  const find = (node, id) => {
    if (node.attrs && node.attrs['resource-id'] === id) return node;
    for (const child of node.children || []) {
      const found = find(child, id);
      if (found) return found;
    }
    return null;
  };

  const rows = [];
  const walk = node => {
    if (node.attrs && node.attrs['resource-id'] === 'jp.naver.line.android:id/root' &&
        node.attrs.clickable === 'true') {
      const name = find(node, 'jp.naver.line.android:id/name');
      const members = find(node, 'jp.naver.line.android:id/member_count');
      if (name && name.attrs.text && members) {
        rows.push({
          name: name.attrs.text,
          memberCount: members.attrs.text || '',
          bounds: node.attrs.bounds || ''
        });
      }
    }
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return rows;
}

async function scanGroups(targetIndex = null) {
  if ((await adb(['get-state'])) !== 'device') throw new Error('ADBがAndroidに接続されていません');
  let width = 1080, height = 2400;
  try {
    const size = await adb(['shell', 'wm', 'size']);
    const match = size.match(/(\d+)x(\d+)/);
    if (match) { width = Number(match[1]); height = Number(match[2]); }
  } catch (_) {}

  const unique = new Map();
  const maxPages = 80;
  let unchangedPages = 0;
  let scrolls = 0;
  let opened = false;
  try {
    for (let page = 0; page < maxPages; page++) {
      const rows = parseChatRows(await getScreen());
      let added = 0;
      for (const row of rows) {
        const key = row.name.trim() + '\u0000' + row.memberCount.trim();
        if (!unique.has(key)) { unique.set(key, { ...row, page }); added++; }
      }

      if (targetIndex !== null && targetIndex >= 0 && targetIndex < unique.size) {
        const target = [...unique.values()][targetIndex];
        if (target && target.page === page) {
          const b = target.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
          if (!b) throw new Error('選択したグループの位置を読み取れません');
          const x = Math.round((Number(b[1]) + Number(b[3])) / 2);
          const y = Math.round((Number(b[2]) + Number(b[4])) / 2);
          await adb(['shell', 'input', 'tap', String(x), String(y)]);
          opened = true;
          await new Promise(resolve => setTimeout(resolve, 1400));
          return { groups: [...unique.values()], opened: true };
        }
      }

      unchangedPages = added === 0 ? unchangedPages + 1 : 0;
      if (unchangedPages >= 3) break;
      await adb(['shell', 'input', 'swipe',
        String(Math.round(width * 0.5)), String(Math.round(height * 0.82)),
        String(Math.round(width * 0.5)), String(Math.round(height * 0.28)), '450']);
      scrolls++;
      await new Promise(resolve => setTimeout(resolve, 450));
    }
    if (targetIndex !== null) throw new Error('指定したグループが見つかりません。一覧を再取得してください');
    return { groups: [...unique.values()], opened };
  } finally {
    if (!opened) {
      // 一覧取得後は先頭へ戻す
      for (let i = 0; i < scrolls + 2; i++) {
        await adb(['shell', 'input', 'swipe',
          String(Math.round(width * 0.5)), String(Math.round(height * 0.25)),
          String(Math.round(width * 0.5)), String(Math.round(height * 0.82)), '350']).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 120));
      }
    }
  }
}

async function getGroups() {
  const result = await scanGroups();
  return result.groups.map(({ name, memberCount }) => ({ name, memberCount }));
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

async function action(name, parameter) {
  if ((await adb(['get-state'])) !== 'device') {
    throw new Error('ADBがAndroidに接続されていません');
  }

  if (name === 'launch') {
    await adb(['shell', 'am', 'start', '-n', 'jp.naver.line.android/.activity.SplashActivity']);
    return 'LINEを起動しました';
  }

  if (name === 'open-group') {
    const index = Number(parameter);
    if (!Number.isInteger(index) || index < 0) throw new Error('グループを選択してください');
    const result = await scanGroups(index);
    const selected = result.groups[index];
    return '「' + (selected ? selected.name : '選択したグループ') + '」を開きました';
  }

  if (name === 'start') {
    const xml = await getScreen();
    const nodes = [...xml.matchAll(/<node\b[^>]*\/?\s*>/g)].map(m => attrs(m[0]));

    // すでにグループ通話が進行中なら、トーク内の「参加」を優先する
    let target = nodes.find(a =>
      a['resource-id'] === 'jp.naver.line.android:id/chat_ui_row_groupcall_join_button' &&
      a.clickable === 'true'
    );

    if (target) {
      const b = (target.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (!b) throw new Error('グループ通話の参加ボタンの位置を読み取れません');
      const x = Math.round((Number(b[1]) + Number(b[3])) / 2);
      const y = Math.round((Number(b[2]) + Number(b[4])) / 2);
      await adb(['shell', 'input', 'tap', String(x), String(y)]);
      return '進行中のグループ音声通話への参加ボタンを押しました';
    }

    // 通話中でなければ、グループトーク上部の「通話 ボタン」を押す
    target = nodes.find(a =>
      a['resource-id'] === 'jp.naver.line.android:id/header_button_layout' &&
      a['content-desc'] === '通話 ボタン' &&
      a.clickable === 'true'
    );

    if (!target) {
      throw new Error('グループトーク上部の「通話」ボタンが見つかりません。対象グループのトークを開いてください');
    }

    const b = (target.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) throw new Error('通話ボタンの位置を読み取れません');
    const x = Math.round((Number(b[1]) + Number(b[3])) / 2);
    const y = Math.round((Number(b[2]) + Number(b[4])) / 2);
    await adb(['shell', 'input', 'tap', String(x), String(y)]);
    await new Promise(r => setTimeout(r, 700));

    // 文字ノード自体がclickable=falseでも、表示位置を直接タップする
    let voice = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const menuXml = await getScreen();
      const candidates = [...menuXml.matchAll(/<node\b[^>]*\/?\s*>/g)]
        .map(m => attrs(m[0]))
        .filter(a => {
          const label = (a.text || '') + ' ' + (a['content-desc'] || '');
          return label.includes('音声通話') && !label.includes('ビデオ');
        }).filter(a => a.bounds);
      candidates.sort((a, b) => {
        const exact = x => ((x.text || '') + (x['content-desc'] || '')).includes('音声通話を開始') ? 0 : 1;
        return exact(a) - exact(b);
      });
      voice = candidates[0] || null;
      if (voice) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!voice) throw new Error('音声通話の開始項目が見つかりません。通話メニューの画面を確認してください');
    const vb = voice.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!vb) throw new Error('音声通話メニューの位置を読み取れません');
    const vx = Math.round((Number(vb[1]) + Number(vb[3])) / 2);
    const vy = Math.round((Number(vb[2]) + Number(vb[4])) / 2);
    await adb(['shell', 'input', 'tap', String(vx), String(vy)]);
    await new Promise(resolve => setTimeout(resolve, 1200));
    return '音声通話の開始を選択しました';
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
    console.log('[update] サーバーを停止して、新しいコードで再起動します');

    // 先に待受を完全に閉じてから子プロセスを起動する。
    // spawn直後ではなく、子プロセスがlisten成功を通知した時点で親を終了する。
    server.close(async () => {
      // GUI/セッション等の旧プロセスを止め、ポートと実行環境を整理してから次を起動
      await cleanupManagedResources();
      releaseInstanceLock();
      shuttingDown = false;
      const child = spawn(process.execPath, [__filename], {
        cwd: __dirname,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, LINE_RESTART_HANDSHAKE: '1' }
      });

      let settled = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        console.error('[update] 新サーバーの起動を確認できません:', message);
        process.exit(1);
      };

      child.on('message', message => {
        if (message && message.type === 'listening' && !settled) {
          settled = true;
          console.log('[update] 新サーバーの起動を確認しました。旧プロセスを終了します');
          child.disconnect();
          releaseInstanceLock();
          process.exit(0);
        }
        if (message && message.type === 'startup-error') {
          fail(message.message || 'listenに失敗しました');
        }
      });
      child.once('error', err => fail(err.message));
      child.once('exit', (code, signal) => {
        if (!settled) fail('子プロセス終了 code=' + code + ' signal=' + signal);
      });
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

      if (req.method === 'GET' && url.pathname === '/api/groups') {
        const groups = await getGroups();
        res.end(JSON.stringify({ groups }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/action') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 10000) throw new Error('リクエストが大きすぎます');
        }
        const data = JSON.parse(body || '{}');
        const message = await action(data.action, data.groupIndex);
        let chat;
        if (data.action === 'open-group') {
          const xml = await getScreen();
          chat = [];
          for (const match of xml.matchAll(/<node\b[^>]*\/?\s*>/g)) {
            const a = attrs(match[0]);
            const value = (a.text || '').trim();
            if (!value || /^(送信|戻る|メニュー|通話|ビデオ通話|音声通話|写真|カメラ|検索)$/.test(value)) continue;
            if (chat[chat.length - 1] !== value) chat.push(value);
          }
          chat = chat.slice(-35);
        }
        res.end(JSON.stringify({ ok: true, message, ...(chat ? { chat } : {}) }));
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

// server.js起動時にWaydroidコンテナ・Androidセッション・GUI・ADBを順番に起動する
function waydroidEnvironment() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const runtimeDir = process.env.XDG_RUNTIME_DIR || '/run/user/' + uid;
  return {
    ...process.env,
    HOME: process.env.HOME || '/home/harusinn',
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS || 'unix:path=' + runtimeDir + '/bus',
    DISPLAY: process.env.DISPLAY || ':0',
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0'
  };
}

function startDetached(command, args, label, env = waydroidEnvironment()) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: __dirname,
      env,
      detached: true,
      stdio: 'ignore'
    });
    child.once('spawn', () => {
      managedChildren.set(child.pid, label);
      if (label === 'Androidセッション') sessionStartedByServer = true;
      child.once('exit', () => managedChildren.delete(child.pid));
      child.unref();
      console.log('[Waydroid] ' + label + 'を開始しました (PID ' + child.pid + ')');
      resolve();
    });
    child.once('error', err => reject(err));
  });
}

async function readWaydroidStatus() {
  const result = await exec('waydroid', ['status'], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: waydroidEnvironment()
  });
  return result.stdout + result.stderr;
}

async function startWaydroid() {
  const env = waydroidEnvironment();
  console.log('[Waydroid] 起動を開始します');

  // 既に動作中のコンテナは他用途の可能性があるため、停止対象にしない。
  let containerActive = false;
  try {
    const active = await exec('systemctl', ['is-active', 'waydroid-container'], {
      timeout: 10000, maxBuffer: 1024 * 1024, env
    });
    containerActive = active.stdout.trim() === 'active';
  } catch (_) {}
  if (!containerActive) {
    await exec('sudo', ['-n', '/usr/bin/systemctl', 'start', 'waydroid-container'], {
      timeout: 30000, maxBuffer: 1024 * 1024, env
    });
    containerStartedByServer = true;
  }

  // session startはAndroidセッションが終了するまで待ち続けるため、バックグラウンド起動する。
  let statusText = '';
  try {
    statusText = await readWaydroidStatus();
  } catch (_) {}

  if (!/Session:\s*RUNNING/i.test(statusText)) {
    await startDetached('waydroid', ['session', 'start'], 'Androidセッション', env);
  } else {
    console.log('[Waydroid] Androidセッションは既に起動しています');
  }

  // Androidが完全に起動し、ADBが応答するまで最大150秒待つ。
  const deadline = Date.now() + 150000;
  let address = '192.168.240.112';
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      statusText = await readWaydroidStatus();
      const match = statusText.match(/IP(?:\s+address)?:\s*([0-9.]+)/i);
      if (match) address = match[1];

      await exec(ADB, ['connect', address + ':5555'], {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        env
      });
      const adbState = await exec(ADB, ['get-state'], {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        env
      });

      if (adbState.stdout.trim() === 'device') {
        console.log('[Waydroid] Android起動・ADB接続を確認しました:', address);
        break;
      }
    } catch (e) {
      lastError = e.stderr || e.message;
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  if (Date.now() >= deadline) {
    throw new Error('Android/ADBの起動確認がタイムアウトしました' +
      (lastError ? ': ' + lastError : ''));
  }

  // ADB接続確認後にGUIを表示する。Raspberry Pi ConnectのWayland/X11環境を引き継ぐ。
  await startDetached('waydroid', ['show-full-ui'], 'Android GUI', env);
}

server.on('error', err => {
  console.error('[server] listen/server error:', err);
  if (process.env.LINE_RESTART_HANDSHAKE === '1' && process.send) {
    try { process.send({ type: 'startup-error', message: err.message }); } catch (_) {}
  }
  if (err.code === 'EADDRINUSE') {
    console.error('[server] ポート' + PORT + 'は既に使用中です。既存プロセスを確認してください');
  }
  cleanupManagedResources().finally(() => {
    releaseInstanceLock();
    process.exit(1);
  });
});

function listenServer() {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`LINE Control Site: http://192.168.1.3:${PORT}`);
    console.log(`GitHub自動更新: ${UPDATE_INTERVAL / 1000}秒ごとに確認 (${REPO_BRANCH})`);
    if (process.env.LINE_RESTART_HANDSHAKE === '1' && process.send) {
      process.send({ type: 'listening' });
      delete process.env.LINE_RESTART_HANDSHAKE;
    }
    setTimeout(checkForUpdates, 5000);
    setInterval(checkForUpdates, UPDATE_INTERVAL);
  });
}

(async () => {
  try {
    acquireInstanceLock();
    console.log('[server] 起動ロックを取得しました (PID ' + process.pid + ')');
  } catch (e) {
    console.error('[server] ' + e.message);
    process.exit(1);
    return;
  }

  try {
    await startWaydroid();
  } catch (e) {
    console.error('[Waydroid] 自動起動に失敗しました:', e.message);
    console.error('[Waydroid] sudoのNOPASSWD設定とWaydroid/ADBの状態を確認してください');
  }
  // Waydroid側に問題があっても管理画面は起動する
  listenServer();
})();

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  console.log('[server] ' + signal + 'を受信。終了処理を開始します');
  server.close();
  await cleanupManagedResources();
  releaseInstanceLock();
  process.exit(0);
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM').catch(e => {
  console.error('[cleanup] 終了処理失敗:', e.message); releaseInstanceLock(); process.exit(1);
}); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT').catch(e => {
  console.error('[cleanup] 終了処理失敗:', e.message); releaseInstanceLock(); process.exit(1);
}); });
process.on('uncaughtException', err => {
  console.error('[server] uncaughtException:', err);
  cleanupManagedResources().finally(() => {
    releaseInstanceLock();
    process.exit(1);
  });
});
process.on('unhandledRejection', reason => {
  console.error('[server] unhandledRejection:', reason);
  cleanupManagedResources().finally(() => {
    releaseInstanceLock();
    process.exit(1);
  });
});
process.on('exit', releaseInstanceLock);
