const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const assert = require('node:assert/strict');

const base = 51000 + process.pid % 500;
const upstreamPort = base, appPort = base + 500, missingAppPort = base + 1000;
const routeCoordinates = [[72.8347, 19.0607], [72.836, 19.059], [72.840143, 19.055069]];
let geocodeUrl = '', quickRouteUrl = '', delayedRouteCalls = 0, valhallaCalls = 0;

function encodePolyline(points, precision = 6) {
  const factor = 10 ** precision;
  let lastLatitude = 0, lastLongitude = 0, encoded = '';
  const value = number => {
    let current = number < 0 ? ~(number << 1) : number << 1;
    while (current >= 0x20) { encoded += String.fromCharCode((0x20 | (current & 0x1f)) + 63); current >>= 5; }
    encoded += String.fromCharCode(current + 63);
  };
  points.forEach(([longitude, latitude]) => {
    const nextLatitude = Math.round(latitude * factor), nextLongitude = Math.round(longitude * factor);
    value(nextLatitude - lastLatitude); value(nextLongitude - lastLongitude);
    lastLatitude = nextLatitude; lastLongitude = nextLongitude;
  });
  return encoded;
}

function geoRoute() {
  return { type: 'FeatureCollection', features: [{ type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: [routeCoordinates.slice(0, 2), routeCoordinates.slice(1)] },
    properties: { distance: 400, time: 300, legs: [
      { distance: 150, time: 120, steps: [{ distance: 150, time: 120, from_index: 0, to_index: 1,
        name: 'First Road', instruction: { text: 'Walk east.' } }] },
      { distance: 250, time: 180, steps: [{ distance: 250, time: 180, from_index: 0, to_index: 1,
        name: 'Station Road', instruction: { text: 'Turn right onto Station Road.' } }] }
    ] }
  }] };
}

const upstream = http.createServer((req, res) => {
  if (req.url.startsWith('/geo/geocode')) {
    geocodeUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature',
      geometry: { type: 'Point', coordinates: [72.9701779, 19.1943294] },
      properties: { place_id: 'thane-city', name: 'Thane', formatted: 'Thane, Maharashtra, India',
        lat: 19.1943294, lon: 72.9701779, result_type: 'city' } }] }));
    return;
  }
  if (req.url.startsWith('/geo/routing')) {
    const url = new URL(req.url, `http://127.0.0.1:${upstreamPort}`);
    if (url.searchParams.get('waypoints').startsWith('18,')) {
      delayedRouteCalls++;
      setTimeout(() => { if (!res.writableEnded) { res.writeHead(504).end('{"error":"slow"}'); } }, 500);
      return;
    }
    quickRouteUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(geoRoute())); return;
  }
  if (req.url === '/valhalla' && req.method === 'POST') {
    valhallaCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ trip: { summary: { length: 0.4, time: 300 }, legs: [{
      shape: encodePolyline(routeCoordinates), maneuvers: [{ instruction: 'Continue straight.', length: 0.4,
        time: 300, begin_shape_index: 0, end_shape_index: 2 }]
    }] } }));
    return;
  }
  if (req.url.startsWith('/fail')) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"offline"}'); return; }
  res.writeHead(404).end();
});

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitForServer(port) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/`); if (response.ok) return; } catch {}
    await delay(50);
  }
  throw new Error('VisionGuide test server did not start.');
}
function startApp(port, env) {
  return spawn(process.execPath, ['server.cjs'], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env, PORT: String(port), GRAPHHOPPER_API_KEY: '', NOMINATIM_CONTACT: 'test@example.invalid', ...env
  } });
}

(async () => {
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const app = startApp(appPort, {
    GEOAPIFY_API_KEY: 'server-only-geoapify-key',
    GEOAPIFY_GEOCODE_URL: `http://127.0.0.1:${upstreamPort}/geo/geocode`,
    GEOAPIFY_ROUTE_URL: `http://127.0.0.1:${upstreamPort}/geo/routing`,
    VALHALLA_URL: `http://127.0.0.1:${upstreamPort}/valhalla`,
    OSRM_FOOT_URL: `http://127.0.0.1:${upstreamPort}/fail/osrm`,
    PROVIDER_TIMEOUT_MS: '250', GEOCODE_RATE_LIMIT_PER_MINUTE: '3', ROUTE_RATE_LIMIT_PER_MINUTE: '2'
  });
  try {
    await waitForServer(appPort);
    const invalid = await fetch(`http://127.0.0.1:${appPort}/api/geocode?q=x`);
    assert.equal(invalid.status, 400, 'invalid searches are rejected before contacting a provider');
    const searchResponse = await fetch(`http://127.0.0.1:${appPort}/api/geocode?q=Thane&lat=19.06&lon=72.83`);
    const search = await searchResponse.json();
    assert.equal(searchResponse.status, 200); assert.equal(search.results[0].name, 'Thane');
    assert.match(geocodeUrl, /filter=countrycode%3Ain/); assert.match(geocodeUrl, /bias=proximity%3A72\.83%2C19\.06/);
    assert.match(geocodeUrl, /apiKey=server-only-geoapify-key/);
    const cached = await (await fetch(`http://127.0.0.1:${appPort}/api/geocode?q=Thane&lat=19.06&lon=72.83`)).json();
    assert.equal(cached.cached, true);
    const limited = await fetch(`http://127.0.0.1:${appPort}/api/geocode?q=Mumbai`);
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after') !== null, true);

    const quickResponse = await fetch(`http://127.0.0.1:${appPort}/api/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { latitude: 19.0607, longitude: 72.8347 }, to: { latitude: 19.055069, longitude: 72.840143 } }) });
    const quickRoute = await quickResponse.json();
    assert.equal(quickResponse.status, 200); assert.equal(quickRoute.time, 300000);
    assert.deepEqual(quickRoute.coordinates, routeCoordinates, 'Geoapify MultiLineString legs are flattened without duplicate points');
    assert.deepEqual(quickRoute.steps[1].interval, [1, 2], 'step geometry indices are offset into the flattened route');
    assert.equal(quickRoute.steps[1].sign, 2); assert.match(quickRouteUrl, /mode=walk/);

    const fallbackResponse = await fetch(`http://127.0.0.1:${appPort}/api/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { latitude: 18, longitude: 72.8 }, to: { latitude: 19.055069, longitude: 72.840143 } }) });
    assert.equal(fallbackResponse.status, 200, 'a Geoapify timeout falls through to the next walking provider');
    assert.equal(delayedRouteCalls, 1); assert.equal(valhallaCalls, 1);
    const routeLimited = await fetch(`http://127.0.0.1:${appPort}/api/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(routeLimited.status, 429);
    const publicConfig = await (await fetch(`http://127.0.0.1:${appPort}/api/public-config`)).text();
    assert.equal(publicConfig.includes('server-only-geoapify-key'), false);
    assert.equal(fs.readFileSync('dist/destinationSearch.js', 'utf8').includes('GEOAPIFY_API_KEY'), false);
  } finally { app.kill(); }

  const missing = startApp(missingAppPort, {
    GEOAPIFY_API_KEY: '', NOMINATIM_URL: `http://127.0.0.1:${upstreamPort}/fail/nominatim`,
    PHOTON_URL: `http://127.0.0.1:${upstreamPort}/fail/photon`, VALHALLA_URL: `http://127.0.0.1:${upstreamPort}/fail/valhalla`,
    OSRM_FOOT_URL: `http://127.0.0.1:${upstreamPort}/fail/osrm`, PROVIDER_TIMEOUT_MS: '250'
  });
  try {
    await waitForServer(missingAppPort);
    const searchFailure = await fetch(`http://127.0.0.1:${missingAppPort}/api/geocode?q=Thane`);
    assert.equal(searchFailure.status, 502); assert.equal((await searchFailure.json()).code, 'PROVIDERS_UNAVAILABLE');
    const routeFailure = await fetch(`http://127.0.0.1:${missingAppPort}/api/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { latitude: 19, longitude: 72.8 }, to: { latitude: 19.1, longitude: 72.9 } }) });
    assert.equal(routeFailure.status, 502); assert.equal((await routeFailure.json()).code, 'PROVIDERS_UNAVAILABLE');
  } finally {
    missing.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
  console.log('PASS: Geoapify India search/bias/cache, walking-route normalization, timeout fallback, rate limits, key protection, and missing-provider errors.');
})().catch(error => { console.error(error); process.exitCode = 1; });
