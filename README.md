# Tesla Cut Cam Export

A browser-only Tesla dashcam viewer and exporter. Point it at your TeslaCam USB folder, play any event with all cameras in sync and a driving-metrics HUD, trim it, and export an MP4. **Footage never leaves your computer. Decoding and encoding happen in your browser, and the app sends no analytics.**

## Run it locally (portable, Windows)
1. Unzip `TeslaCutCamExport.zip`.
2. Double-click **`Start Tesla Cut Cam Export.bat`**. It needs Python 3 (`py`, `python` on PATH, or a common install folder). It serves `site/` on http://127.0.0.1:8123/, or on the next free port up to 8152, and opens your browser.
3. Click **Open TeslaCam folder**, or **Open last folder** to reopen the previous one. Keep the black window open while you use the app; closing it stops the server.

Use Chrome or Edge for the best results. Firefox 130+ can also view and export. Safari is untested.

## Features (v4)
- **HUD:** choose individual overlay items, or pick **No HUD**. Everything is off by default, including the Map.
- **Map:** a live mini-map with a GPS trail.
- **Speed ramp:** off by default. Slows down around the Sentry trigger or a marked point, with adjustable ramp length, factor, and easing.
- **Fisheye / skew correction:** each wide camera has its own checkbox: Rear, Left pillar and repeater, Right pillar and repeater. The correction is a WebGL radial undistort using the original TeslaHUD model (k1 −0.25, k2 −0.05). Your choices are saved and apply to both the live view and exports. All are off by default.
- **Stabilization:** optional and lightweight, with a small crop.
- **Title card:** logo only, logo and text, or text only. You set how long it shows.
- **Sentry sheet:** shows every Sentry event with a thumbnail. Click one to jump to its trigger. You can export a combined video, download events one by one, or export them as separate files into a folder.
- **Memory-aware export:** see below. The output is always a single MP4.
- Library, Driving/Sentry HUDs, layouts, timeline, stats, and an optional street-name lookup through the same-origin `/geo` proxy.

### How export uses memory
The app estimates your RAM in this order: the `?ram=<GB>` URL parameter or the localStorage key `tcc.simRamGB`, then `navigator.deviceMemory` (Chromium caps this at 8–16 GB), and otherwise assumes 4 GB. It uses a fraction of that RAM based on Settings → Performance: low 4%, auto 10%, high 20%. That amount is capped at 40% of the free JS heap. From this the app picks a chunk length between 1 and 60 s, assuming two chunk buffers per camera, and a decoder queue of 3, 6, or 10 frames. Chunks are decoded and encoded in turn and written into one fragmented MP4 as they finish, so you never merge files afterwards. The output uses a 90 kHz timescale with strictly increasing decode timestamps. This works with variable-rate footage around 36 fps and with encoders that reorder frames, such as Firefox's.

## Web deployment (Ubuntu + nginx + Cloudflare Tunnel)
Everything you need is in `TeslaCutCamExport-web.zip`, under `site/` and `deploy/`:
- **nginx** (`deploy/nginx-teslacutcam.conf`) listens on **127.0.0.1:8124**, serves `site/` with security headers, and proxies `/geo` to **127.0.0.1:8125**.
- **Geo proxy:** you have two options:
  - `teslacutcam-server.py --web`, run as a systemd service with `deploy/teslacutcam-geo.service`.
  - `deploy/geo-worker.js`, as a Cloudflare Worker or with Node 18+.
  
  Either one keeps the LocationIQ key on the server, caches results, rate limits each `CF-Connecting-IP` (default 30/min), and rejects bad coordinates.
- **Key:** set it with `TCC_GEO_KEY` or `TCC_GEO_KEY_FILE`, or put it in `/opt/teslacutcam/teslacutcam-geo.key` with mode 600. For the Worker, use `wrangler secret put LOCATIONIQ_KEY`. Neither zip contains a key.
- **Tunnel:** `deploy/cloudflared-config.example.yml` routes `teslacutcam.wackedoodle.com` to `http://localhost:8124`.

Steps:
1. `sudo mkdir -p /var/www/teslacutcam && sudo cp -r site/* /var/www/teslacutcam/`
2. `sudo cp deploy/nginx-teslacutcam.conf /etc/nginx/sites-available/teslacutcam && sudo ln -s ../sites-available/teslacutcam /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx`
3. Install the geo service as described at the top of `deploy/teslacutcam-geo.service`, then run `sudo systemctl enable --now teslacutcam-geo`.
4. Add the tunnel ingress from the example file, then run `cloudflared tunnel route dns <tunnel> teslacutcam.wackedoodle.com`.

## Develop and test
```
npm install
npm run build          # outputs to dist/
npm test               # runs all e2e suites in order (Playwright Chromium + Firefox)
```
The suites are `e2e`, `e2e-geo`, `e2e-filter`, `e2e-features`, `e2e-long`, `e2e-web`, `e2e-firefox`, and `e2e-defish` (which uses real footage in `/workspace/test-footage`). Each one can also be run with `node scripts/<suite>.mjs`. They need ffmpeg/ffprobe and test footage:
- `/workspace/test-feat`: one Saved clip and two Sentry events, with `event.json` triggers.
- `/workspace/test-long`: 3 × 66 s segments × 6 cameras, built with ffmpeg concat.

Screenshots are saved to `screenshots/r4-*.png`.

## Code layout
- `src/sei.ts` + `src/telemetry.worker.ts`: SEI telemetry parsing
- `src/library.ts`: folder scan
- `src/compose.ts`: layouts
- `src/overlay.ts`: HUDs
- `src/exporter.ts`: demux → decode → compose → encode → fragmented MP4, with memory planning
- `src/geo.ts`: geocoding client
- `src/main.ts`: UI
- `server/`: portable and web helper
- `deploy/`: nginx, systemd, Worker, cloudflared

## What's new (v2)
- **Loading status**: a spinner with each step and a percent bar (scanning, parsing telemetry, decoding each camera). Controls stay disabled until loading finishes.
- **Every camera is found automatically**: front, rear, left/right repeaters, left/right pillars and the front bumper camera (`fw`), including naming variants. The cameras found are listed under the player.
- **All cameras (theater) layout**, the default for Driving clips:
  - Front full width on top.
  - Pillar over repeater on each side.
  - Front bumper in a centre column when present.
  - Rear full width at the bottom.
- **ACC/BRK meters**: green shows your pedal %, red shows brake. Under FSD/Autopilot the pedal reads 0, so blue **AUTO** bars show the car's own acceleration/deceleration from the accelerometer.
- **G-force dot**: moves down when accelerating, up when braking, and sideways with lateral force. Motion is smoothed.
- **Timeline**:
  - Yellow playhead (drag it to scrub).
  - White In/Out brackets (drag to trim).
  - A purple marker at the Sentry trigger.
  - Shortcuts: Space play/pause, I/O set in/out, ←/→ skip 5 s.
- **Export dialog**:
  - Pick the layout and resolution.
  - Turn the HUD on or off for the exported file.
  - Turn individual items on or off: Date/Time, Speed, Gear, FSD/Autopilot, Steering, ACC/BRK, Blinkers, G-force, Heading, Location, and for Sentry the badge and trigger info.
  - These settings start from the live overlay toggles but never change them.
  - Shows a live preview and a summary.
- **Robust export decoding**:
  - Keyframes are detected from the bitstream itself, and decoding always starts on one. Trims pre-roll from the previous keyframe and discard the earlier frames.
  - `flush()` is called only at end of stream.
  - Edit lists are honoured.
  - The avcC/hvcC parameter sets are passed as the decoder description, for H.264 or HEVC.
  - If the decoder fails, it is rebuilt and resumes at the next keyframe.
- **Errors** appear in an in-app panel with a **Copy details** button (no more alert pop-ups).

## What's new in v3

### Click a camera to expand it
Click any camera tile, in any layout, to make it fill the view. It stays expanded while the video plays. To return to the exact layout you had, use the **Back to all cameras** button, the red **Expanded** chip, a double-click, or **Esc**. Expanding only changes what you see; exports still use the layout you picked.

### Street names (optional, via the local helper)
`Start TeslaCam.bat` runs `teslacam-server.py` (Python standard library only). It serves the app at http://127.0.0.1:8123 and adds a local `/geo` endpoint. That endpoint looks up street names with LocationIQ from your PC, so your key never reaches the browser.

1. Get a free key at https://locationiq.com.
2. Paste the key, on its own, into a text file named **`teslacam-geo.key`** in the same folder as `Start TeslaCam.bat`. You can also set the environment variable `TESLACAM_GEO_KEY`.
3. Restart the launcher. Settings → **Street names** will turn on.

Lookups are rounded to about 100 m and cached in three places: in memory, in `teslacam-geo-cache.json` next to the helper, and in the browser. Requests are throttled. If LocationIQ rate-limits you (429), the helper waits 30 s and the app keeps working. Without a key, or when street names are off, the app shows the street/city from `event.json`, and failing that, the coordinates. Closing the launcher window stops the helper. `teslacam-geo.key` is not included in the zip; you create it yourself.

### Source filter
The **Show:** dropdown above the event list filters by Tesla folder: **Driving** = RecentClips, **Saved** = SavedClips, **Sentry** = SentryClips. Pick any combination, or All. Each option shows its count, and your last choice is remembered. With Type: auto, the overlay style follows the event's folder: SentryClips gets the Sentry overlay, the others get the Driving overlay. You can still override it with the Type menu. If you open folders that aren't in the standard layout, events are classified from `event.json` (a sentry reason means Sentry, otherwise Saved), or as Driving when there is no `event.json`.
