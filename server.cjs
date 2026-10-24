const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function loadLocalEnvironment() {
  const environmentFile = path.join(__dirname, '.env.local');
  if (!fs.existsSync(environmentFile)) return;

  const allowedNames = new Set([
    'GRAPHHOPPER_API_KEY', 'GRAPHHOPPER_URL',
    'GEOAPIFY_API_KEY', 'GEOAPIFY_GEOCODE_URL', 'GEOAPIFY_ROUTE_URL',
    'NOMINATIM_URL', 'NOMINATIM_CONTACT', 'PHOTON_URL', 'VALHALLA_URL', 'OSRM_FOOT_URL',
    'PROVIDER_TIMEOUT_MS', 'GEOCODE_RATE_LIMIT_PER_MINUTE', 'ROUTE_RATE_LIMIT_PER_MINUTE',
    'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_AUTH_USER_URL',
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
    'TWILIO_MESSAGING_SERVICE_SID', 'TWILIO_API_BASE_URL', 'HOST', 'PORT'
  ]);
  for (const rawLine of fs.readFileSync(environmentFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !allowedNames.has(match[1]) || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) process.env[match[1]] = value;
  }
}

loadLocalEnvironment();

const root = path.join(__dirname, 'dist');
const mapLibreRoot = path.join(__dirname, 'node_modules', 'maplibre-gl', 'dist');
const supabaseBrowserFile = path.join(__dirname, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.map': 'application/json' };
const graphHopperKey = process.env.GRAPHHOPPER_API_KEY || '';
const graphHopperUrl = process.env.GRAPHHOPPER_URL || 'https://graphhopper.com/api/1/route';
const geoapifyKey = process.env.GEOAPIFY_API_KEY || '';
const geoapifyGeocodeUrl = process.env.GEOAPIFY_GEOCODE_URL || 'https://api.geoapify.com/v1/geocode/search';
const geoapifyRouteUrl = process.env.GEOAPIFY_ROUTE_URL || 'https://api.geoapify.com/v1/routing';
const nominatimUrl = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const nominatimContact = process.env.NOMINATIM_CONTACT || 'local VisionGuide development';
const photonUrl = process.env.PHOTON_URL || 'https://photon.komoot.io/api/';
const valhallaUrl = process.env.VALHALLA_URL || 'https://valhalla1.openstreetmap.de/route';
const osrmFootUrl = process.env.OSRM_FOOT_URL || 'https://routing.openstreetmap.de/routed-foot/route/v1/driving';
const providerTimeout = Math.max(250, Math.min(60000, Number(process.env.PROVIDER_TIMEOUT_MS) || 15000));
const geocodeRateLimit = Math.max(1, Math.min(600, Number(process.env.GEOCODE_RATE_LIMIT_PER_MINUTE) || 60));
const routeRateLimit = Math.max(1, Math.min(600, Number(process.env.ROUTE_RATE_LIMIT_PER_MINUTE) || 60));
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const supabaseAuthUserUrl = process.env.SUPABASE_AUTH_USER_URL || (supabaseUrl ? `${supabaseUrl.replace(/\/$/, '')}/auth/v1/user` : '');
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID || '';
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || '';
const twilioFromNumber = process.env.TWILIO_FROM_NUMBER || '';
const twilioMessagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID || '';
const twilioApiBaseUrl = (process.env.TWILIO_API_BASE_URL || 'https://api.twilio.com').replace(/\/$/, '');
const geocodeCache = new Map();
const apiRateLimits = { geocode: new Map(), route: new Map() };
const sosRateLimits = new Map();
const sosMessages = new Map();
let lastNominatimRequest = 0;
let nominatimQueue = Promise.resolve();

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > limit) reject(new Error('Request is too large.')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON request.')); } });
    req.on('error', reject);
  });
}

function validPoint(point) {
  return point && Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude)) &&
    Math.abs(Number(point.latitude)) <= 90 && Math.abs(Number(point.longitude)) <= 180;
}

async function fetchWithTimeout(url, options = {}, timeout = providerTimeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function requestAddress(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local').split(',')[0].trim();
}

function enforceRateLimit(req, res, bucket, limit, label) {
  const now = Date.now(), cutoff = now - 60000, key = requestAddress(req);
  const recent = (bucket.get(key) || []).filter(time => time > cutoff);
  if (recent.length >= limit) {
    const retryAfter = Math.max(1, Math.ceil((recent[0] + 60000 - now) / 1000));
    json(res, 429, { code: 'RATE_LIMITED', error: `Too many ${label} requests. Try again in ${retryAfter} seconds.` }, { 'Retry-After': String(retryAfter) });
    return false;
  }
  recent.push(now); bucket.set(key, recent); return true;
}

function searchBias(requestUrl) {
  if (!requestUrl.searchParams.has('lat') || !requestUrl.searchParams.has('lon')) return null;
  const latitude = Number(requestUrl.searchParams.get('lat'));
  const longitude = Number(requestUrl.searchParams.get('lon'));
  return validPoint({ latitude, longitude }) ? { latitude, longitude } : null;
}

function geoapifyGeocode(query, bias) {
  const url = new URL(geoapifyGeocodeUrl);
  url.searchParams.set('text', query); url.searchParams.set('format', 'geojson');
  url.searchParams.set('filter', 'countrycode:in'); url.searchParams.set('limit', '5');
  url.searchParams.set('lang', 'en'); url.searchParams.set('apiKey', geoapifyKey);
  if (bias) url.searchParams.set('bias', `proximity:${bias.longitude},${bias.latitude}`);
  return fetchWithTimeout(url, { headers: { Accept: 'application/geo+json, application/json' } }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
    if (!Array.isArray(data.features)) throw new Error('invalid response');
    return data.features.map((feature, index) => {
      const properties = feature.properties || {}, coordinates = feature.geometry?.coordinates || [];
      return { id: properties.place_id || `geoapify-${index}`, name: properties.name || properties.address_line1 || query,
        displayName: properties.formatted || [properties.address_line1, properties.address_line2].filter(Boolean).join(', ') || query,
        latitude: Number(properties.lat ?? coordinates[1]), longitude: Number(properties.lon ?? coordinates[0]),
        type: properties.result_type || properties.category || '' };
    });
  });
}

async function geocode(req, res, requestUrl) {
  if (!enforceRateLimit(req, res, apiRateLimits.geocode, geocodeRateLimit, 'destination search')) return;
  const query = String(requestUrl.searchParams.get('q') || '').trim();
  if (query.length < 3 || query.length > 160) return json(res, 400, { error: 'Enter a destination between 3 and 160 characters.' });
  const bias = searchBias(requestUrl);
  const key = `${query.toLocaleLowerCase('en')}|${bias ? `${bias.latitude.toFixed(3)},${bias.longitude.toFixed(3)}` : ''}`;
  const cached = geocodeCache.get(key);
  if (cached && Date.now() - cached.time < 86400000) return json(res, 200, { results: cached.results, cached: true });
  nominatimQueue = nominatimQueue.catch(() => {}).then(async () => {
    let results;
    if (geoapifyKey) try {
      results = await geoapifyGeocode(query, bias);
    } catch (error) {
      console.warn(`Geoapify search failed (${error.message}); trying OpenStreetMap providers.`);
    }
    if (!results) try {
      const wait = Math.max(0, 1050 - (Date.now() - lastNominatimRequest));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      lastNominatimRequest = Date.now();
      const url = new URL(nominatimUrl);
      url.searchParams.set('q', query); url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('addressdetails', '1'); url.searchParams.set('limit', '5'); url.searchParams.set('countrycodes', 'in');
      if (bias) { url.searchParams.set('viewbox', `${bias.longitude - .5},${bias.latitude + .5},${bias.longitude + .5},${bias.latitude - .5}`); }
      const response = await fetchWithTimeout(url, { headers: {
        Accept: 'application/json', 'Accept-Language': 'en',
        'User-Agent': `VisionGuide/2.0 (${nominatimContact})`
      }});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const items = await response.json();
      if (!Array.isArray(items)) throw new Error('invalid response');
      results = items.map(item => ({ id: item.place_id, name: item.name || item.display_name?.split(',')[0],
        displayName: item.display_name, latitude: Number(item.lat), longitude: Number(item.lon), type: item.type }));
    } catch (nominatimError) {
      console.warn(`Nominatim search failed (${nominatimError.message}); trying Photon.`);
      const url = new URL(photonUrl);
      url.searchParams.set('q', query); url.searchParams.set('limit', '5'); url.searchParams.set('lang', 'en');
      url.searchParams.set('bbox', '68.1,6.4,97.4,35.7');
      if (bias) { url.searchParams.set('lat', String(bias.latitude)); url.searchParams.set('lon', String(bias.longitude)); }
      const response = await fetchWithTimeout(url, { headers: {
        Accept: 'application/geo+json, application/json', 'Accept-Language': 'en',
        'User-Agent': `VisionGuide/2.0 (${nominatimContact})`
      }});
      if (!response.ok) throw new Error(`Photon returned HTTP ${response.status}.`);
      const data = await response.json();
      if (!Array.isArray(data.features)) throw new Error('Photon returned an invalid response.');
      results = data.features.map((feature, index) => {
        const properties = feature.properties || {}, coordinates = feature.geometry?.coordinates || [];
        const displayName = [properties.name, properties.street, properties.city || properties.district,
          properties.state, properties.country].filter((value, itemIndex, values) => value && values.indexOf(value) === itemIndex).join(', ');
        return { id: `${properties.osm_type || 'photon'}${properties.osm_id || index}`,
          name: properties.name || properties.city || query, displayName: displayName || query,
          latitude: Number(coordinates[1]), longitude: Number(coordinates[0]),
          type: properties.osm_value || properties.type || '' };
      });
    }
    results = results.filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
    geocodeCache.set(key, { time: Date.now(), results });
    return results;
  });
  try { return json(res, 200, { results: await nominatimQueue }); }
  catch (error) {
    console.error(`Destination search failed: ${error.message}`);
    return json(res, 502, { code: error.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDERS_UNAVAILABLE',
      error: error.name === 'AbortError' ? 'Destination search timed out. Try again.' : 'Destination search providers are temporarily unavailable. Configure GEOAPIFY_API_KEY or try again later.' });
  }
}

function decodePolyline(encoded, precision = 6) {
  const coordinates = []; let index = 0, latitude = 0, longitude = 0;
  const decodeValue = () => {
    let result = 0, shift = 0, byte;
    do {
      if (index >= encoded.length) throw new Error('Routing provider returned invalid geometry.');
      byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5;
    } while (byte >= 0x20);
    return (result & 1) ? ~(result >> 1) : result >> 1;
  };
  const factor = 10 ** precision;
  while (index < encoded.length) {
    latitude += decodeValue(); longitude += decodeValue();
    coordinates.push([longitude / factor, latitude / factor]);
  }
  return coordinates;
}

async function graphHopperRoute(from, to) {
  const url = new URL(graphHopperUrl); url.searchParams.set('key', graphHopperKey);
  const response = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ profile: 'foot', points: [[Number(from.longitude), Number(from.latitude)], [Number(to.longitude), Number(to.latitude)]],
      points_encoded: false, instructions: true, locale: 'en', elevation: false }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.paths?.length) throw new Error(data.message || data.hints?.[0]?.message || `GraphHopper returned HTTP ${response.status}.`);
  const pathData = data.paths[0];
  return { distance: pathData.distance, time: pathData.time, coordinates: pathData.points?.coordinates || [],
    steps: (pathData.instructions || []).map(step => ({ text: step.text, streetName: step.street_name,
      distance: step.distance, time: step.time, sign: step.sign, interval: step.interval })) };
}

function turnSign(text) {
  text = String(text || '').toLowerCase();
  if (/u[ -]?turn/.test(text)) return 4;
  if (/left/.test(text)) return -2;
  if (/right/.test(text)) return 2;
  return 0;
}

async function geoapifyRoute(from, to) {
  const url = new URL(geoapifyRouteUrl);
  url.searchParams.set('waypoints', `${Number(from.latitude)},${Number(from.longitude)}|${Number(to.latitude)},${Number(to.longitude)}`);
  url.searchParams.set('mode', 'walk'); url.searchParams.set('format', 'geojson'); url.searchParams.set('lang', 'en');
  url.searchParams.set('apiKey', geoapifyKey);
  const response = await fetchWithTimeout(url, { headers: { Accept: 'application/geo+json, application/json' } });
  const data = await response.json().catch(() => ({})), feature = data.features?.[0];
  if (!response.ok || !feature?.geometry?.coordinates || !feature.properties) {
    const error = new Error(data.message || data.error || `Geoapify returned HTTP ${response.status}.`);
    error.noRoute = response.status === 404 || response.status === 422; throw error;
  }
  const geometry = feature.geometry;
  const lines = geometry.type === 'MultiLineString' ? geometry.coordinates : geometry.type === 'LineString' ? [geometry.coordinates] : [];
  const coordinates = [], legOffsets = [];
  lines.forEach(line => {
    const first = line[0], previous = coordinates.at(-1);
    const sharedStart = Boolean(previous && first && Number(previous[0]) === Number(first[0]) && Number(previous[1]) === Number(first[1]));
    legOffsets.push(Math.max(0, coordinates.length - (sharedStart ? 1 : 0)));
    line.forEach((coordinate, index) => {
      if (!Array.isArray(coordinate) || !Number.isFinite(Number(coordinate[0])) || !Number.isFinite(Number(coordinate[1]))) return;
      if (index || !sharedStart)
        coordinates.push([Number(coordinate[0]), Number(coordinate[1])]);
    });
  });
  if (coordinates.length < 2) throw new Error('Geoapify returned incomplete route geometry.');
  const legs = feature.properties.legs || [];
  const steps = legs.flatMap((leg, legIndex) => (leg.steps || []).map(step => {
    const offset = legOffsets[legIndex] || 0;
    const text = step.instruction?.text || step.instruction || 'Continue straight.';
    return { text, streetName: step.name || '', distance: Number(step.distance) || 0,
      time: (Number(step.time) || 0) * 1000, sign: turnSign(text),
      interval: [offset + (Number(step.from_index) || 0), offset + (Number(step.to_index) || 0)] };
  }));
  return { distance: Number(feature.properties.distance) || legs.reduce((sum, leg) => sum + (Number(leg.distance) || 0), 0),
    time: (Number(feature.properties.time) || legs.reduce((sum, leg) => sum + (Number(leg.time) || 0), 0)) * 1000,
    coordinates, steps };
}

async function valhallaRoute(from, to) {
  const response = await fetchWithTimeout(valhallaUrl, { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': `VisionGuide/2.0 (${nominatimContact})`,
    'X-Client-Id': 'visionguide-local'
  }, body: JSON.stringify({ locations: [{ lat: Number(from.latitude), lon: Number(from.longitude) },
    { lat: Number(to.latitude), lon: Number(to.longitude) }], costing: 'pedestrian', units: 'kilometers', language: 'en-US' }) });
  const data = await response.json().catch(() => ({}));
  const leg = data.trip?.legs?.[0], summary = data.trip?.summary;
  if (!response.ok || !leg?.shape || !summary) throw new Error(data.error || data.error_code || `Valhalla returned HTTP ${response.status}.`);
  const coordinates = decodePolyline(leg.shape, 6);
  if (coordinates.length < 2) throw new Error('Valhalla returned incomplete route geometry.');
  return { distance: Number(summary.length) * 1000, time: Number(summary.time) * 1000, coordinates,
    steps: (leg.maneuvers || []).map(maneuver => ({ text: maneuver.instruction || 'Continue straight',
      streetName: maneuver.street_names?.[0] || '', distance: Number(maneuver.length) * 1000,
      time: Number(maneuver.time) * 1000,
      sign: /left/i.test(maneuver.instruction) ? -2 : /right/i.test(maneuver.instruction) ? 2 : 0,
      interval: [Number(maneuver.begin_shape_index) || 0, Number(maneuver.end_shape_index) || 0] })) };
}

function closestCoordinateIndex(coordinates, point, start = 0) {
  let bestIndex = start, bestDistance = Infinity;
  for (let index = start; index < coordinates.length; index++) {
    const longitude = coordinates[index][0] - point[0], latitude = coordinates[index][1] - point[1];
    const distance = longitude * longitude + latitude * latitude;
    if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
  }
  return bestIndex;
}

function osrmInstruction(step) {
  const maneuver = step.maneuver || {}, modifier = String(maneuver.modifier || '').replace('uturn', 'U-turn');
  const onto = step.name ? ` onto ${step.name}` : '';
  if (maneuver.type === 'depart') return `Start ${modifier || 'walking'}${onto}.`;
  if (maneuver.type === 'arrive') return 'You have arrived at your destination.';
  if (maneuver.type === 'roundabout' || maneuver.type === 'rotary')
    return `Enter the roundabout${maneuver.exit ? ` and take exit ${maneuver.exit}` : ''}${onto}.`;
  if (maneuver.type === 'fork') return `Keep ${modifier || 'straight'}${onto}.`;
  if (maneuver.type === 'merge') return `Merge ${modifier || 'straight'}${onto}.`;
  if (maneuver.type === 'new name' || maneuver.type === 'continue' || maneuver.type === 'notification')
    return `Continue ${modifier || 'straight'}${onto}.`;
  return `Turn ${modifier || 'straight'}${onto}.`;
}

async function osrmRoute(from, to) {
  const coordinatesText = `${Number(from.longitude)},${Number(from.latitude)};${Number(to.longitude)},${Number(to.latitude)}`;
  const url = new URL(`${osrmFootUrl.replace(/\/$/, '')}/${coordinatesText}`);
  url.searchParams.set('overview', 'full'); url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('steps', 'true');
  const response = await fetchWithTimeout(url, { headers: {
    Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': `VisionGuide/2.0 (${nominatimContact})`
  }});
  const data = await response.json().catch(() => ({})), routeData = data.routes?.[0];
  if (!response.ok || data.code !== 'Ok' || !routeData?.geometry?.coordinates?.length) {
    const error = new Error(data.message || data.code || `OSRM returned HTTP ${response.status}.`);
    error.noRoute = data.code === 'NoRoute';
    throw error;
  }
  const coordinates = routeData.geometry.coordinates;
  const rawSteps = (routeData.legs || []).flatMap(leg => leg.steps || []);
  let cursor = 0;
  const begins = rawSteps.map(step => {
    cursor = closestCoordinateIndex(coordinates, step.maneuver?.location || coordinates[cursor], cursor);
    return cursor;
  });
  const steps = rawSteps.map((step, index) => {
    const modifier = String(step.maneuver?.modifier || '');
    return { text: osrmInstruction(step), streetName: step.name || '', distance: Number(step.distance) || 0,
      time: (Number(step.duration) || 0) * 1000,
      sign: /left/.test(modifier) ? -2 : /right/.test(modifier) ? 2 : /uturn/.test(modifier) ? 4 : 0,
      interval: [begins[index], begins[index + 1] ?? coordinates.length - 1] };
  });
  return { distance: Number(routeData.distance) || 0, time: (Number(routeData.duration) || 0) * 1000, coordinates, steps };
}

function normalizeRoute(result) {
  const coordinates = (result?.coordinates || []).map(coordinate => [Number(coordinate?.[0]), Number(coordinate?.[1])])
    .filter(coordinate => Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]) && Math.abs(coordinate[0]) <= 180 && Math.abs(coordinate[1]) <= 90);
  if (coordinates.length < 2) throw new Error('Routing provider returned incomplete route geometry.');
  const lastIndex = coordinates.length - 1;
  let steps = (result.steps || []).map(step => {
    const from = Math.max(0, Math.min(lastIndex, Math.trunc(Number(step.interval?.[0]) || 0)));
    const to = Math.max(from, Math.min(lastIndex, Math.trunc(Number(step.interval?.[1]) || from)));
    return { text: String(step.text || 'Continue straight.').trim(), streetName: String(step.streetName || ''),
      distance: Math.max(0, Number(step.distance) || 0), time: Math.max(0, Number(step.time) || 0),
      sign: Number(step.sign) || 0, interval: [from, to] };
  });
  if (!steps.length) steps = [{ text: 'Begin walking on the displayed route.', streetName: '',
    distance: Math.max(0, Number(result.distance) || 0), time: Math.max(0, Number(result.time) || 0), sign: 0, interval: [0, lastIndex] }];
  return { distance: Math.max(0, Number(result.distance) || 0), time: Math.max(0, Number(result.time) || 0), coordinates, steps };
}

async function route(req, res) {
  if (!enforceRateLimit(req, res, apiRateLimits.route, routeRateLimit, 'route calculation')) return;
  let body;
  try { body = await readJson(req); } catch (error) { return json(res, 400, { error: error.message }); }
  if (!validPoint(body.from) || !validPoint(body.to)) return json(res, 400, { error: 'Valid origin and destination coordinates are required.' });
  const providers = [
    ...(graphHopperKey ? [{ name: 'GraphHopper', request: graphHopperRoute }] : []),
    ...(geoapifyKey ? [{ name: 'Geoapify', request: geoapifyRoute }] : []),
    { name: 'Valhalla', request: valhallaRoute },
    { name: 'OSRM foot', request: osrmRoute }
  ];
  const failures = [];
  for (const provider of providers) {
    try { return json(res, 200, normalizeRoute(await provider.request(body.from, body.to))); }
    catch (error) {
      failures.push(error); console.warn(`${provider.name} walking route failed (${error.message}); trying the next provider.`);
    }
  }
  const noRoute = failures.length && failures.every(error => error.noRoute);
  console.error(`All walking route providers failed: ${failures.map(error => error.message).join(' | ')}`);
  return json(res, noRoute ? 422 : 502, { code: noRoute ? 'NO_WALKABLE_ROUTE' : 'PROVIDERS_UNAVAILABLE', error: noRoute
    ? 'No walkable route could be found between your current location and this destination.'
    : 'Walking routing providers are temporarily unavailable. Configure GEOAPIFY_API_KEY or GRAPHHOPPER_API_KEY, or try again.' });
}

function validPhone(phone) {
  return /^\+[1-9]\d{7,14}$/.test(String(phone || ''));
}

function twilioConfigured() {
  return Boolean(twilioAccountSid && twilioAuthToken && (twilioFromNumber || twilioMessagingServiceSid));
}

function twilioHeaders() {
  return {
    Accept: 'application/json',
    Authorization: `Basic ${Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64')}`
  };
}

async function authenticate(req) {
  const authorization = String(req.headers.authorization || '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token || token.length > 4096 || !supabaseAuthUserUrl || !supabasePublishableKey) return null;
  try {
    const response = await fetchWithTimeout(supabaseAuthUserUrl, { headers: {
      Accept: 'application/json', apikey: supabasePublishableKey, Authorization: `Bearer ${token}`
    }}, 10000);
    if (!response.ok) return null;
    const user = await response.json();
    return user?.id ? user : null;
  } catch { return null; }
}

function emergencyMessage(user, location) {
  const displayName = String(user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'A VisionGuide user')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 50);
  const latitude = Number(location.latitude).toFixed(6);
  const longitude = Number(location.longitude).toFixed(6);
  const accuracy = Math.max(1, Math.round(Number(location.accuracy)));
  return `EMERGENCY: ${displayName} may need help. Location: https://www.google.com/maps?q=${latitude},${longitude} (GPS accuracy about ${accuracy} metres). Please contact them now.`;
}

async function sendSos(req, res) {
  const user = await authenticate(req);
  if (!user) return json(res, 401, { code: 'AUTH_REQUIRED', error: 'Your session expired. Sign in again before sending an emergency alert.' });

  let body;
  try { body = await readJson(req); } catch (error) { return json(res, 400, { code: 'INVALID_REQUEST', error: error.message }); }
  const location = body.location || {};
  const accuracy = Number(location.accuracy);
  if (!validPhone(body.phone)) return json(res, 400, { code: 'INVALID_PHONE', error: 'The emergency contact phone number must include a valid country code.' });
  if (!validPoint(location) || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000)
    return json(res, 400, { code: 'INVALID_LOCATION', error: 'A valid live GPS location is required.' });
  if (!twilioConfigured()) return json(res, 503, { code: 'SOS_NOT_CONFIGURED', error: 'Automatic emergency SMS is not configured on this server.' });

  const now = Date.now();
  for (const [key, value] of sosRateLimits) if (now - value > 300000) sosRateLimits.delete(key);
  for (const [key, value] of sosMessages) if (now > value.expiresAt) sosMessages.delete(key);
  const lastSend = sosRateLimits.get(user.id) || 0;
  if (now - lastSend < 60000) return json(res, 429, {
    code: 'SOS_RATE_LIMITED', error: `An emergency SMS was already requested. Wait ${Math.ceil((60000 - (now - lastSend)) / 1000)} seconds before sending another.`
  });
  sosRateLimits.set(user.id, now);

  const form = new URLSearchParams({ To: body.phone, Body: emergencyMessage(user, location) });
  if (twilioMessagingServiceSid) form.set('MessagingServiceSid', twilioMessagingServiceSid);
  else form.set('From', twilioFromNumber);
  const url = `${twilioApiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(twilioAccountSid)}/Messages.json`;
  try {
    const response = await fetchWithTimeout(url, { method: 'POST', headers: {
      ...twilioHeaders(), 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    }, body: form.toString() }, 15000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.sid) {
      sosRateLimits.delete(user.id);
      const configurationError = response.status === 401 || response.status === 403;
      return json(res, response.status >= 400 && response.status < 500 ? 502 : response.status, {
        code: configurationError ? 'SOS_PROVIDER_AUTH_FAILED' : 'SOS_PROVIDER_REJECTED',
        error: configurationError
          ? 'The SMS provider credentials were rejected. Use the phone SMS fallback and ask the administrator to check Twilio.'
          : 'The SMS provider could not accept this emergency message. Use the phone SMS fallback.'
      });
    }
    const status = String(data.status || 'queued').toLowerCase();
    sosMessages.set(data.sid, { userId: user.id, expiresAt: now + 86400000 });
    return json(res, 202, { ok: true, messageId: data.sid, status, sentAt: new Date().toISOString() });
  } catch (error) {
    sosRateLimits.delete(user.id);
    return json(res, 502, { code: 'SOS_PROVIDER_UNAVAILABLE',
      error: error.name === 'AbortError' ? 'The SMS provider timed out. Use the phone SMS fallback.' : 'The SMS provider is unavailable. Use the phone SMS fallback.' });
  }
}

async function sosStatus(req, res, requestUrl) {
  const user = await authenticate(req);
  if (!user) return json(res, 401, { code: 'AUTH_REQUIRED', error: 'Your session expired. Sign in again.' });
  const id = String(requestUrl.searchParams.get('id') || '');
  const entry = sosMessages.get(id);
  if (!/^(SM|MM)[0-9a-fA-F]{32}$/.test(id) || !entry || entry.userId !== user.id || Date.now() > entry.expiresAt)
    return json(res, 404, { code: 'SOS_STATUS_NOT_FOUND', error: 'Emergency message status is unavailable.' });
  try {
    const url = `${twilioApiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(twilioAccountSid)}/Messages/${encodeURIComponent(id)}.json`;
    const response = await fetchWithTimeout(url, { headers: twilioHeaders() }, 10000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return json(res, 502, { code: 'SOS_STATUS_UNAVAILABLE', error: 'Delivery status is temporarily unavailable.' });
    const status = String(data.status || 'unknown').toLowerCase();
    return json(res, 200, { messageId: id, status, terminal: ['delivered', 'failed', 'undelivered', 'canceled'].includes(status) });
  } catch { return json(res, 502, { code: 'SOS_STATUS_UNAVAILABLE', error: 'Delivery status is temporarily unavailable.' }); }
}

const server = http.createServer((req, res) => {
  let requestUrl;
  try { requestUrl = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400).end('Invalid request'); return; }
  if (req.method === 'GET' && requestUrl.pathname === '/api/public-config') {
    json(res, 200, { supabase: { url: supabaseUrl, publishableKey: supabasePublishableKey,
      configured: Boolean(supabaseUrl && supabasePublishableKey) } });
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/api/geocode') { void geocode(req, res, requestUrl); return; }
  if (req.method === 'POST' && requestUrl.pathname === '/api/route') { void route(req, res); return; }
  if (req.method === 'POST' && requestUrl.pathname === '/api/sos') { void sendSos(req, res); return; }
  if (req.method === 'GET' && requestUrl.pathname === '/api/sos-status') { void sosStatus(req, res, requestUrl); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let name;
  try { name = decodeURIComponent(requestUrl.pathname); }
  catch { res.writeHead(400).end('Invalid request'); return; }
  if (name.startsWith('/vendor/maplibre/')) {
    const vendorName = name.slice('/vendor/maplibre/'.length);
    const allowed = new Set(['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css']);
    if (!allowed.has(vendorName)) { res.writeHead(404).end('File not found'); return; }
    const vendorFile = path.join(mapLibreRoot, vendorName);
    fs.readFile(vendorFile, (error, data) => {
      if (error) { res.writeHead(404).end('File not found'); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(vendorFile)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
    return;
  }
  if (name === '/vendor/supabase/supabase.js') {
    fs.readFile(supabaseBrowserFile, (error, data) => {
      if (error) { res.writeHead(404).end('File not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
    return;
  }
  if (name === '/') name = '/index.html';
  const file = path.resolve(root, '.' + name);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end('Not allowed'); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end('File not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Stop the other server or set PORT to another number.`
    : error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`VisionGuide is ready: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
  console.log('Keep this terminal open. Press Ctrl+C to stop.');
});
