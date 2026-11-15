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

async function getGroups() {
  if ((await adb(['get-state'])) !== 'device') {
    throw new Error('ADBがAndroidに接続されていません');
  }
  const xml = await getScreen();
  return parseChatRows(xml);
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
    const rows = await getGroups();
    const index = Number(parameter);
    if (!Number.isInteger(index) || index < 0 || index >= rows.length) {
      throw new Error('グループ一覧が更新されています。一覧を再取得してください');
    }
    const b = rows[index].bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) throw new Error('選択したグループの位置を読み取れません');
    const x = Math.round((Number(b[1]) + Number(b[3])) / 2);
    const y = Math.round((Number(b[2]) + Number(b[4])) / 2);
    await adb(['shell', 'input', 'tap', String(x), String(y)]);
    await new Promise(r => setTimeout(r, 1000));
    return '「' + rows[index].name + '」を開きました';
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

    // 通話メニューに「音声通話」が直接表示された場合は選択する
    const menuXml = await getScreen();
    const voice = [...menuXml.matchAll(/<node\b[^>]*\/?\s*>/g)]
      .map(m => attrs(m[0]))
      .find(a => a.clickable === 'true' &&
        ((a.text || '').includes('音声通話') || (a['content-desc'] || '').includes('音声通話')));

    if (voice) {
      const vb = (voice.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (!vb) throw new Error('音声通話メニューの位置を読み取れません');
      const vx = Math.round((Number(vb[1]) + Number(vb[3])) / 2);
      const vy = Math.round((Number(vb[2]) + Number(vb[4])) / 2);
      await adb(['shell', 'input', 'tap', String(vx), String(vy)]);
      return '音声通話を選択しました';
    }

    return 'グループの通話メニューを開きました。音声通話の選択画面を確認してください';
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
    server.close(() => {
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

server.on('error', err => {
  console.error('[server] listen/server error:', err);
  if (process.env.LINE_RESTART_HANDSHAKE === '1' && process.send) {
    try { process.send({ type: 'startup-error', message: err.message }); } catch (_) {}
  }
  if (err.code === 'EADDRINUSE') {
    console.error('[server] ポート' + PORT + 'は既に使用中です。既存プロセスを確認してください');
  }
  process.exitCode = 1;
});

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

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
