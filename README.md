# VisionGuide

VisionGuide is an accessibility-focused browser app with live Camera Guide, OCR reading, shared voice commands/TTS, and live walking navigation.

## Install and run

Requirements: Node.js 18+ and Chrome or Edge. A Geoapify or GraphHopper API key is recommended for reliable search and walking routes; keyless local/prototype use can fall back to public OpenStreetMap services. A Supabase project is needed for production account authentication, and Twilio is needed for automatic SOS SMS.

```powershell
npm.cmd install
npm.cmd start
```

Open `http://127.0.0.1:4173`. Camera, microphone, and geolocation work on localhost or HTTPS and are requested only after the related control is selected.

### Windows live-location checklist

1. Open **Settings → Privacy & security → Location** (`ms-settings:privacy-location`). Turn on **Location services** and allow desktop apps to access location.
2. In Chrome or Edge, open `http://127.0.0.1:4173`, open the site-permission control beside the address, and set **Location** to **Allow**. Reload after changing either Windows or browser permission.
3. Open Navigate and select **Use my precise location**. VisionGuide first requests a fresh high-accuracy browser fix and keeps a continuous watcher running. The displayed `± metres` value is the accuracy reported by Windows/browser—not an accuracy claim made by VisionGuide.
4. If Windows supplies only Wi-Fi positioning, the location may remain too coarse for live navigation. Keep the page open while waiting for improvement or use an HTTPS Android test; do not substitute a VPN/IP result or a manual preview for live GPS.

For console diagnostics, `window.navigationUI.engine.location.getDiagnostics()` reports secure-context, browser-support, permission, watcher, best-accuracy, and fix-age state without inventing a position.

Before starting, copy `.env.example` to `.env.local` when you want to configure production services. `GEOAPIFY_API_KEY` enables India-filtered Geoapify search and walking routes; obtain a key from the Geoapify dashboard. Set `NOMINATIM_CONTACT=mailto:you@example.com` to identify this installation when the public Nominatim fallback is used. Provider keys, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY` are optional for the local demo. `.env.local` is ignored by Git and read only by `server.cjs`. Provider keys remain server-side; the Supabase publishable key is intentionally provided to the browser and relies on Supabase Auth/RLS for security. Never use a Supabase secret or `service_role` key in this app. Server environment variables take precedence over this file. Optional provider overrides are:

```powershell
$env:GRAPHHOPPER_URL='https://graphhopper.com/api/1/route'
$env:GEOAPIFY_GEOCODE_URL='https://api.geoapify.com/v1/geocode/search'
$env:GEOAPIFY_ROUTE_URL='https://api.geoapify.com/v1/routing'
$env:NOMINATIM_URL='https://nominatim.openstreetmap.org/search'
$env:PHOTON_URL='https://photon.komoot.io/api/'
$env:VALHALLA_URL='https://valhalla1.openstreetmap.de/route'
$env:OSRM_FOOT_URL='https://routing.openstreetmap.de/routed-foot/route/v1/driving'
$env:HOST='0.0.0.0'
```

For production or sustained traffic, configure Geoapify or GraphHopper and avoid depending on public demo services. With keys configured, route requests try GraphHopper, Geoapify, Valhalla, and pedestrian OSRM in that order; search prefers Geoapify and falls back to Nominatim then Photon. VisionGuide searches only on submission or a completed voice command, applies per-client request limits, serializes public Nominatim traffic to at most one request per second, and caches identical query/bias pairs in server memory for 24 hours. It does not implement autocomplete.

## Authentication

Supabase provides real email/password sign-up, email confirmation, sign-in, persistent/refreshing browser sessions, password recovery, password updates, and local-device sign-out. Access to the application requires an authenticated account. VisionGuide never saves a password in its own local storage.

In Supabase Auth URL Configuration, set the Site URL to the deployed HTTPS origin and allow that origin with a trailing `/` as a redirect URL. For local development, also allow `http://127.0.0.1:4173/`. Keep email/password sign-ups enabled. Before production launch, configure custom SMTP so confirmation and recovery emails are reliably delivered beyond Supabase's development email limits.

## Emergency SOS

SOS gets a fresh high-accuracy device location, shows the exact recipient, phone number, coordinates, accuracy and Google Maps pin, and requires confirmation before sending. The server verifies the user's Supabase access token and sends the SMS through Twilio. The UI then checks Twilio's message status and only says “delivered” after provider confirmation. A one-minute per-user rate limit protects against duplicate sends.

Add these server-only values to `.env.local` for local development and to the deployment platform's environment settings for production:

```dotenv
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+15551234567
```

You may set `TWILIO_MESSAGING_SERVICE_SID=MG...` instead of `TWILIO_FROM_NUMBER`. If both are present, the Messaging Service is used. Never put the Twilio Auth Token in `dist/`, client JavaScript, Git, or Supabase's publishable configuration.

Indian mobile numbers can be entered as 10 digits or in `+91` form and are saved in E.164 form. Twilio trial accounts can send only to verified recipient numbers. For production delivery to India, complete the sender/DLT registration and template requirements applicable to your Twilio route and account. Test with consenting contacts on multiple Indian carriers before launch.

If automatic SMS is not configured or the provider rejects the request, mobile users get a native Messages fallback with the recipient and map pin prefilled. The user must still press Send, and VisionGuide clearly reports that no automatic message was sent.

## Navigate

The Navigate page provides:

- Browser `watchPosition()` tracking with high-accuracy mode, zero cached age, freshness checks, weighted GPS smoothing, heading/speed, and cleanup.
- Stale or coarse Wi-Fi/IP positions are rejected. Route calculation waits for a fresh position accurate to 80 metres or better instead of routing from a misleading approximate location.
- Devices without usable GPS can search and select their real starting street, landmark, or station for an explicitly labeled route preview. Manual starts never masquerade as live GPS and cannot start turn-by-turn progress.
- MapLibre GL JS with OpenStreetMap raster data, current position, destination, walking route, and completed route progress.
- Submitted Nominatim-compatible destination search with up to five selectable matches.
- GraphHopper `foot` routing through the local server, with the API key kept server-side.
- Distance, walking ETA, next direction, remaining distance, and route progress.
- Thresholded turn speech, deduplication, arrival speech, and three-good-point off-route confirmation before rerouting.
- Continued GPS navigation while Camera Guide is open. Both features use `guidanceManager.js`; Camera danger cues have higher priority than immediate turns, upcoming turns, and normal route information.

Voice commands include:

- `navigate to [destination]`, `take me to [destination]`, or `go to [destination]`
- `navigate home`
- `select result 1` through `select result 5`
- `begin navigation` and `stop navigation`
- `current instruction`, `repeat`, and `where am I`
- Existing Camera Guide, OCR, SOS, settings, and screen-navigation commands

## Privacy and safety

Camera analysis remains in browser memory. Camera frames are not uploaded by VisionGuide. Destination text and an optional reliable proximity bias are sent through the local server to the configured geocoding provider. Route origin/destination coordinates are sent through the local server to the configured walking-route provider. API keys remain server-side. Map tiles are requested from OpenStreetMap for the displayed viewport. Email addresses and authentication sessions are handled by Supabase; passwords are sent directly to Supabase Auth and are never stored by VisionGuide. Saved places, contacts, preferences, and journey history remain in browser local storage. During a confirmed SOS, the primary contact's phone number and the user's coordinates/accuracy are sent through the server to Twilio for SMS delivery.

VisionGuide is experimental and is not a certified mobility, collision-avoidance, or public emergency service. GPS, map data, routes, monocular depth, and detected obstacles can be inaccurate. SOS sends an SMS only to the saved personal contact; it does not call police, ambulance, fire services, or India's 112 service.

## Project layout

```text
dist/
  index.html                 Application entry point
  app.js                     Existing SPA screens and shared TTS bridge
  authService.js             Supabase session and email/password auth client
  sosService.js              Fresh GPS, authenticated SMS client, and mobile fallback
  guidanceManager.js         Prioritized, deduplicated central speech queue
  voiceCommands.js           Existing speech recognition and command routing
  locationService.js         Live geolocation, smoothing, heading/speed, cleanup
  destinationSearch.js       Submitted geocoding client
  routingService.js          Walking-route client
  routeTracker.js            Map matching, progress, accuracy/off-route logic
  navigationEngine.js        Navigation lifecycle, cues, arrival, and rerouting
  mapController.js           MapLibre sources, layers, viewport, and progress
  navigationController.js    Navigate UI and app/voice integration
  mapLibreLoader.js          Local MapLibre v6 ESM loader
  camera.js                  Camera lifecycle and Camera Guide UI
  objectDetection.js         Live vision and high-priority safety guidance
  ocrReader.js               In-browser OCR lifecycle
  experience.css             Existing design plus responsive Navigate styles
server.cjs                   Static server, protected navigation proxies, and authenticated Twilio SOS
tests/                       Unit, integration, and headless browser checks
```

## Test

```powershell
npm.cmd test
npm.cmd run test:browser
npm.cmd audit --omit=dev
```

`npm test` covers Supabase's client contract, SOS GPS/phone normalization/fallback, authenticated Twilio requests and delivery status, duplicate-send protection, existing Camera, voice, OCR/vision behavior, GPS permission/errors/jump rejection, search, Geoapify and OpenStreetMap-provider fallbacks, rate limits, normalized route geometry/steps, progress, rerouting, and speech-priority logic. `npm run test:browser` starts its own temporary app server plus installed Chrome/Edge headlessly; it verifies the public/auth UI, rendered Navigate controls, emulated GPS, manual preview, search selection, route start, a real MapLibre canvas, and navigation continuing when Camera Guide opens.

## Deployment

Deploy `server.cjs`, `dist/`, `package.json`, `package-lock.json`, and installed production dependencies behind HTTPS. Set `HOST=0.0.0.0`, at least one reliable provider key (`GEOAPIFY_API_KEY` and/or `GRAPHHOPPER_API_KEY`), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_FROM_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID` in the server environment. Do not place provider keys, the Twilio Auth Token, or any Supabase secret/service-role key in `dist/` or browser configuration. Add the final HTTPS origin to Supabase Auth's Site URL and redirect allow list. Mobile camera, microphone, and precise geolocation require an HTTPS origin; plain HTTP on a LAN IP is insufficient. A static-only deployment cannot provide protected routing or automatic SOS SMS with this architecture.

For physical-phone GPS testing, expose this same Node server through an HTTPS deployment or trusted HTTPS development tunnel, open that HTTPS URL in current Android Chrome, allow precise location, and test outdoors with device GPS enabled. Confirm the accuracy value shown by VisionGuide before relying on spoken turns; desktop Wi-Fi location cannot validate phone GNSS behavior.

Protect any development tunnel or deployment with an access policy or authenticated staging environment, keep provider/Twilio keys only on the server, and do not expose an unrestricted development backend to the public internet. On Android, enable system Location and precise location for Chrome, allow this HTTPS site's Location permission, keep the page visible, and prevent battery saver from suspending Chrome during the test. Ordinary browser pages are not reliable background-navigation services: updates and speech may pause when Chrome is backgrounded or the screen locks.
