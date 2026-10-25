const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const chrome = chromeCandidates.find(fs.existsSync);
if (!chrome) throw new Error('Chrome or Edge is required for the browser smoke test.');

const debugPort = 45000 + process.pid % 1000;
const appPort = 46000 + process.pid % 1000;
const profile = path.join(os.tmpdir(), `visionguide-browser-${process.pid}`);
const appServer = spawn(process.execPath, ['server.cjs'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, PORT: String(appPort) } });
const browser = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-default-apps', '--disable-gpu', 'about:blank'
], { stdio: 'ignore', windowsHide: true });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function retry(fn, attempts = 40) {
  let error;
  for (let i = 0; i < attempts; i++) { try { return await fn(); } catch (e) { error = e; await delay(100); } }
  throw error;
}

(async () => {
  await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/`);
    if (!response.ok) throw new Error('VisionGuide test server is not ready.');
  });
  const version = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    if (!response.ok) throw new Error('DevTools endpoint is not ready.');
    return response.json();
  });
  assert(version.webSocketDebuggerUrl);
  const created = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${appPort}/`)}`, { method: 'PUT' })).json();
  const socket = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map(), errors = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const messageId = ++id; pending.set(messageId, { resolve, reject }); socket.send(JSON.stringify({ id: messageId, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Browser.grantPermissions', { origin: `http://127.0.0.1:${appPort}`, permissions: ['geolocation'] });
  await send('Emulation.setGeolocationOverride', { latitude: 19.0607, longitude: 72.8347, accuracy: 8 });
  await delay(900);
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  await delay(1200);
  const publicLanding = await evaluate(`({hero:!!document.querySelector('.landing-hero'),signIn:!!document.querySelector('[data-action="signin"]'),title:document.querySelector('h1')?.textContent})`);
  assert(publicLanding.hero && publicLanding.signIn);
  assert.match(publicLanding.title, /world feels clearer/i);
  await evaluate(`document.querySelector('[data-action="signup"]').click()`);
  await delay(150);
  assert.equal(await evaluate(`!!document.querySelector('#auth-form[data-mode="signup"]')`), true);
  assert.equal(await evaluate(`typeof window.supabaseAuth?.signIn === 'function'`), true);
  await evaluate(`document.querySelector('[data-action="landing"]').click()`);
  await delay(150);
  assert.equal(await evaluate(`!!document.querySelector('[data-action="guest"]')`), false);
  await evaluate(`document.querySelector('[data-action="signin"]').click()`);
  await delay(150);
  assert.match(await evaluate(`document.querySelector('.auth-demo')?.innerText || ''`), /demo@visionguide\.local[\s\S]*visionguide/i);
  await evaluate(`onboarded=true; document.querySelector('#auth-email').value='demo@visionguide.local'; document.querySelector('#auth-password').value='visionguide'; document.querySelector('#auth-form').requestSubmit()`);
  await delay(300);
  assert.equal(await evaluate(`authenticated && !!document.querySelector('.product-shell')`), true);
  await evaluate(`document.querySelector('[data-action="navigate"]').click()`);
  await delay(500);
  const initial = await evaluate(`({text:document.querySelector('main').innerText, hasMap:!!document.querySelector('#navigation-map'), hasSearch:!!document.querySelector('#destination-search')})`);
  assert(initial.hasMap && initial.hasSearch);
  assert.match(initial.text, /Current Location/);
  assert.match(initial.text, /START NAVIGATION/);

  await evaluate(`document.querySelector('[data-nav-action="location"]').click()`);
  await delay(700);
  assert.match(await evaluate(`document.querySelector('#nav-location-copy').textContent`), /19\.06070/);

  await evaluate(`window.fetch=async(url,options={})=>{
    if(String(url).includes('/api/geocode')) return new Response(JSON.stringify({results:[{id:'1',name:'Test Library',displayName:'Test Library, Bandra',latitude:19.0607,longitude:72.8353}]}),{status:200,headers:{'Content-Type':'application/json'}});
    if(String(url).includes('/api/route')) return new Response(JSON.stringify({distance:64,time:60000,coordinates:[[72.8347,19.0607],[72.835,19.0607],[72.8353,19.0607]],steps:[{text:'Continue straight',sign:0,interval:[0,1]},{text:'Turn right',sign:2,interval:[1,2]}]}),{status:200,headers:{'Content-Type':'application/json'}});
    throw new Error('Unexpected fetch '+url);
  }; window.navigationUI.engine.search.fetch=window.fetch.bind(window); window.navigationUI.engine.routing.fetch=window.fetch.bind(window); true`);
  await evaluate(`document.querySelector('#origin-search').value='Airoli Station'; document.querySelector('#navigation-origin-form').requestSubmit()`);
  await delay(300);
  assert.equal(await evaluate(`document.querySelectorAll('[data-nav-action="origin-result"]').length`), 1);
  await evaluate(`document.querySelector('[data-nav-action="origin-result"]').click()`);
  await delay(200);
  assert.match(await evaluate(`document.querySelector('#nav-gps-quality').textContent`), /manual preview/i);
  assert.equal(await evaluate(`document.querySelector('[data-nav-action="start"]').disabled`), true);
  await evaluate(`document.querySelector('[data-nav-action="location"]').click()`);
  await delay(700);
  assert.match(await evaluate(`document.querySelector('#nav-location-copy').textContent`), /live GPS/i);
  await evaluate(`document.querySelector('#destination-search').value='Test Library'; document.querySelector('#navigation-search-form').requestSubmit()`);
  await delay(300);
  const resultCount = await evaluate(`document.querySelectorAll('[data-nav-action="result"]').length`);
  if (resultCount !== 1) console.error(await evaluate(`JSON.stringify({html:document.querySelector('#navigation-results').innerHTML,state:window.navigationUI.getState()})`));
  assert.equal(resultCount, 1);
  await evaluate(`document.querySelector('[data-nav-action="result"]').click()`);
  await delay(500);
  assert.match(await evaluate(`document.querySelector('#nav-route-status').textContent`), /route ready/i);
  assert.equal(await evaluate(`document.querySelector('[data-nav-action="start"]').disabled`), false);
  await evaluate(`document.querySelector('[data-nav-action="start"]').click()`);
  await delay(250);
  assert.equal(await evaluate(`window.navigationUI.isActive()`), true);
  assert.match(await evaluate(`document.querySelector('#nav-route-status').textContent`), /running/i);
  const mapLoaded = await evaluate(`!!document.querySelector('#navigation-map canvas')`);
  assert.equal(mapLoaded, true, 'MapLibre renders an interactive canvas');
  const routeDrawing = await retry(async () => {
    const drawing = await evaluate(`(() => {
      const map=window.navigationUI.map.map, data=map.getSource('vg-route').serialize().data;
      return {
        casing:!!map.getLayer('vg-route-casing'), route:!!map.getLayer('vg-route'), progress:!!map.getLayer('vg-progress'),
        opacity:map.getPaintProperty('vg-route','line-opacity'), width:map.getPaintProperty('vg-route','line-width'),
        type:data?.features?.[0]?.geometry?.type, points:data?.features?.[0]?.geometry?.coordinates?.length || 0
      };
    })()`);
    if (drawing.points !== 3) throw new Error('MapLibre route source is not ready.');
    return drawing;
  });
  assert.deepEqual(routeDrawing, { casing: true, route: true, progress: true, opacity: 0.95, width: 8, type: 'LineString', points: 3 });
  await evaluate(`document.querySelector('[data-action="camera"]').click()`);
  await delay(250);
  assert.equal(await evaluate(`window.navigationUI.isActive()`), true, 'navigation continues while Camera Guide is open');
  const stopped = await evaluate(`window.navigationUI.stop(); ({active:window.navigationUI.isActive(),watching:window.navigationUI.engine.location.isWatching(),location:window.navigationUI.getState().location})`);
  assert.deepEqual(stopped, { active: false, watching: false, location: null });
  assert.deepEqual(errors.filter(error => !/404 \(Not Found\)/.test(error)), []);
  console.log(`PASS: public landing, local demo login, Supabase auth UI, live navigation, search/result selection, visible MapLibre route (${routeDrawing.points} points), start/progress flow, and concurrent Camera Guide.`);
  socket.close();
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  browser.kill();
  appServer.kill();
  await delay(150);
  const resolvedProfile = path.resolve(profile), resolvedTemp = path.resolve(os.tmpdir()) + path.sep;
  if (resolvedProfile.startsWith(resolvedTemp) && path.basename(resolvedProfile).startsWith('visionguide-browser-')) {
    try { fs.rmSync(resolvedProfile, { recursive: true, force: true }); } catch {}
  }
});
