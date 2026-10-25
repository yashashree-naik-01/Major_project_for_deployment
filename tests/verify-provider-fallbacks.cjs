const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const base = 49000 + process.pid % 500;
const upstreamPort = base, appPort = base + 500;
let photonCalls = 0, valhallaCalls = 0, osrmCalls = 0, valhallaBody = null;

function encodePolyline(points, precision = 6) {
  const factor = 10 ** precision;
  let lastLatitude = 0, lastLongitude = 0, encoded = '';
  const encodeValue = value => {
    let current = value < 0 ? ~(value << 1) : value << 1;
    while (current >= 0x20) { encoded += String.fromCharCode((0x20 | (current & 0x1f)) + 63); current >>= 5; }
    encoded += String.fromCharCode(current + 63);
  };
  for (const [longitude, latitude] of points) {
    const nextLatitude = Math.round(latitude * factor), nextLongitude = Math.round(longitude * factor);
    encodeValue(nextLatitude - lastLatitude); encodeValue(nextLongitude - lastLongitude);
    lastLatitude = nextLatitude; lastLongitude = nextLongitude;
  }
  return encoded;
}

const routeCoordinates = [[72.8347, 19.0607], [72.837, 19.058], [72.840143, 19.055069]];
const upstream = http.createServer((req, res) => {
  if (req.url.startsWith('/nominatim')) {
    res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"maintenance"}'); return;
  }
  if (req.url.startsWith('/photon')) {
    photonCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [72.840143, 19.055069] },
      properties: { osm_type: 'W', osm_id: 434887908, name: 'Bandra Railway Station', street: 'Gurunanak Marg',
        city: 'Mumbai', state: 'Maharashtra', country: 'India', osm_value: 'train_station' } }] }));
    return;
  }
  if (req.url === '/valhalla' && req.method === 'POST') {
    valhallaCalls++;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      valhallaBody = JSON.parse(body);
      if (valhallaBody.locations[0].lat === 18) {
        res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"temporarily unavailable"}'); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ trip: { summary: { length: 0.925, time: 702 }, legs: [{
        shape: encodePolyline(routeCoordinates), maneuvers: [
          { instruction: 'Walk east.', length: 0.4, time: 300, begin_shape_index: 0, end_shape_index: 1 },
          { instruction: 'Turn right onto Gurunanak Marg.', street_names: ['Gurunanak Marg'], length: 0.525,
            time: 402, begin_shape_index: 1, end_shape_index: 2 }
        ]
      }] } }));
    });
    return;
  }
  if (req.url.startsWith('/osrm/')) {
    osrmCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'Ok', routes: [{ distance: 510, duration: 390,
      geometry: { type: 'LineString', coordinates: routeCoordinates }, legs: [{ steps: [
        { distance: 200, duration: 150, name: 'First Road', maneuver: { type: 'depart', modifier: 'straight', location: routeCoordinates[0] } },
        { distance: 310, duration: 240, name: 'Station Road', maneuver: { type: 'turn', modifier: 'left', location: routeCoordinates[1] } },
        { distance: 0, duration: 0, name: '', maneuver: { type: 'arrive', modifier: 'straight', location: routeCoordinates[2] } }
      ] }] }] }));
    return;
  }
  res.writeHead(404).end();
});

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitForServer(url) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await delay(50);
  }
  throw new Error('Server did not start.');
}

(async () => {
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const app = spawn(process.execPath, ['server.cjs'], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env, PORT: String(appPort), NOMINATIM_URL: `http://127.0.0.1:${upstreamPort}/nominatim`,
    PHOTON_URL: `http://127.0.0.1:${upstreamPort}/photon`, VALHALLA_URL: `http://127.0.0.1:${upstreamPort}/valhalla`,
    OSRM_FOOT_URL: `http://127.0.0.1:${upstreamPort}/osrm`, GEOAPIFY_API_KEY: '', GRAPHHOPPER_API_KEY: ''
  } });
  try {
    await waitForServer(`http://127.0.0.1:${appPort}/`);
    const searchResponse = await fetch(`http://127.0.0.1:${appPort}/api/geocode?q=Bandra%20Railway%20Station`);
    const search = await searchResponse.json();
    assert.equal(searchResponse.status, 200);
    assert.equal(search.results[0].name, 'Bandra Railway Station');
    assert.match(search.results[0].displayName, /Mumbai, Maharashtra, India/);
    assert.equal(photonCalls, 1);

    const routeResponse = await fetch(`http://127.0.0.1:${appPort}/api/route`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        from: { latitude: 19.0607, longitude: 72.8347 }, to: { latitude: 19.055069, longitude: 72.840143 }
      }) });
    const route = await routeResponse.json();
    assert.equal(routeResponse.status, 200);
    assert.equal(route.distance, 925); assert.equal(route.time, 702000);
    assert.deepEqual(route.coordinates, routeCoordinates);
    assert.equal(route.steps[1].streetName, 'Gurunanak Marg'); assert.equal(route.steps[1].sign, 2);
    assert.equal(valhallaCalls, 1); assert.equal(valhallaBody.costing, 'pedestrian');

    const fallbackResponse = await fetch(`http://127.0.0.1:${appPort}/api/route`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        from: { latitude: 18, longitude: 72.8 }, to: { latitude: 19.055069, longitude: 72.840143 }
      }) });
    const fallbackRoute = await fallbackResponse.json();
    assert.equal(fallbackResponse.status, 200); assert.equal(fallbackRoute.distance, 510);
    assert.deepEqual(fallbackRoute.coordinates, routeCoordinates);
    assert.equal(fallbackRoute.steps[1].text, 'Turn left onto Station Road.');
    assert.equal(fallbackRoute.steps[1].sign, -2); assert.equal(osrmCalls, 1);
    console.log('PASS: Photon search failover plus Valhalla and OSRM pedestrian route failover.');
  } finally {
    app.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
