const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const chrome = chromeCandidates.find(fs.existsSync);
const debugPort = 45123;
const appPort = 46123;
const profile = path.join(os.tmpdir(), `visionguide-test-${Date.now()}`);

const appServer = spawn(process.execPath, ['server.cjs'], {
  cwd: 'c:\\DATA\\ENGG\\SEM 7\\visionguide123\\visionguide',
  stdio: 'ignore',
  windowsHide: true,
  env: { ...process.env, PORT: String(appPort) }
});

const browser = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-default-apps', 'about:blank'
], { stdio: 'ignore', windowsHide: true });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  try {
    await delay(1500);
    const created = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${appPort}/`)}`, { method: 'PUT' })).json();
    const socket = new WebSocket(created.webSocketDebuggerUrl);
    await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });

    let id = 0;
    const pending = new Map();
    const consoleLogs = [];
    socket.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        consoleLogs.push(msg.params.args.map(a => a.value || a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleLogs.push('EXCEPTION: ' + msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
      }
    };

    const send = (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      socket.send(JSON.stringify({ id: mid, method, params }));
    });

    await send('Runtime.enable');
    await delay(2000);

    const checkOrt = await send('Runtime.evaluate', {
      expression: `Boolean(window.ort && window.ort.InferenceSession)`,
      returnByValue: true
    });
    console.log('ort loaded:', checkOrt.result.value);

    const tryLoad = await send('Runtime.evaluate', {
      expression: `(async () => {
        try {
          const res = await window.stairDetectorAPI.loadModel();
          return { ok: Boolean(res), loaded: window.stairDetectorAPI.isModelLoaded(), error: window.stairDetectorAPI.getModelError() };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    console.log('stairDetector loadModel result:', tryLoad.result.value);

    console.log('Console logs during test:\n', consoleLogs.join('\n'));

  } catch (err) {
    console.error('Error:', err);
  } finally {
    try { browser.kill(); } catch {}
    try { appServer.kill(); } catch {}
    process.exit(0);
  }
})();
