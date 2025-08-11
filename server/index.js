const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// Mercator square grid size in meters for snapping and drawing
const GRID_METERS = 25; // 25 m squares
const SNAP_EPS = 1e-9; // align with frontend to avoid boundary jitter
const R = 6378137; // WebMercator radius

// Persistence file (optional)
const DATA_DIR = __dirname; // keep alongside server
const DATA_FILE = path.join(DATA_DIR, 'pixels.json');

/** Convert lon/lat (deg) to WebMercator meters */
function lonLatToMercMeters(lonDeg, latDeg) {
  const clampLat = Math.max(Math.min(latDeg, 85.05112878), -85.05112878);
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (clampLat * Math.PI) / 180;
  const x = R * lon;
  const y = R * Math.log(Math.tan(Math.PI / 4 + lat / 2));
  return { x, y };
}

/** Convert WebMercator meters to lon/lat (deg) */
function mercMetersToLonLat(x, y) {
  const lon = (x / R) * (180 / Math.PI);
  const lat =
    (Math.atan(Math.sinh(y / R)) * 180) / Math.PI; // inverse mercator
  return { lon, lat };
}

/** Snap mercator meters to cell index */
function snapMetersToIndex(m) {
  return Math.round(m / GRID_METERS - SNAP_EPS);
}

/**
 * Stable key for a grid cell
 * @param {number} latCell
 * @param {number} lonCell
 */
function cellKey(i, j) {
  return `${i},${j}`;
}

/** @typedef {{i:number, j:number, color:string, playerName:string, ts:string}} Pixel */

// In-memory store: Map<key, Pixel>
const pixelStore = new Map();

// Load persisted pixels if available
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const p of arr) {
        if (!p) continue;
        let rec = null;
        if (
          typeof p.i === 'number' &&
          typeof p.j === 'number' &&
          typeof p.color === 'string' &&
          typeof p.playerName === 'string'
        ) {
          rec = { i: p.i, j: p.j, color: p.color, playerName: p.playerName, ts: p.ts || new Date().toISOString() };
        } else if (
          typeof p.lat === 'number' &&
          typeof p.lon === 'number' &&
          typeof p.color === 'string' &&
          typeof p.playerName === 'string'
        ) {
          // Back-compat: convert lat/lon to mercator indices
          const { x, y } = lonLatToMercMeters(p.lon, p.lat);
          const i = snapMetersToIndex(x);
          const j = snapMetersToIndex(y);
          rec = { i, j, color: p.color, playerName: p.playerName, ts: p.ts || new Date().toISOString() };
        }
        if (rec) {
          pixelStore.set(cellKey(rec.i, rec.j), rec);
        }
      }
    }
    console.log(`Loaded ${pixelStore.size} pixels from persistence.`);
  }
} catch (err) {
  console.error('Failed to load persisted pixels:', err);
}

function persistPixels() {
  try {
    const arr = Array.from(pixelStore.values());
    fs.writeFile(DATA_FILE, JSON.stringify(arr), (err) => {
      if (err) console.error('Failed to persist pixels:', err);
    });
  } catch (err) {
    console.error('Error during persistPixels:', err);
  }
}

const app = express();

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// Root route serves index.html via static middleware
app.get('/health', (_req, res) => {
  res.json({ ok: true, pixels: pixelStore.size });
});

const server = http.createServer(app);

// WebSocket server
const wss = new WebSocket.Server({ server, path: '/ws' });

function broadcast(json) {
  const data = JSON.stringify(json);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

wss.on('connection', (ws) => {
  // Send snapshot to new client
  const snapshot = Array.from(pixelStore.values());
  ws.send(
    JSON.stringify({ type: 'snapshot', gridMeters: GRID_METERS, pixels: snapshot })
  );

  ws.on('message', (message) => {
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch (err) {
      return; // ignore invalid JSON
    }

    if (!payload || typeof payload !== 'object') return;

    if (payload.type === 'paint' && Array.isArray(payload.pixels)) {
      const applied = [];
      for (const px of payload.pixels) {
        if (!px) continue;
        const iRaw = Number(px.i);
        const jRaw = Number(px.j);
        const color = typeof px.color === 'string' ? px.color : null;
        const playerName = typeof px.playerName === 'string' ? px.playerName : null;
        if (!Number.isFinite(iRaw) || !Number.isFinite(jRaw) || !color || !playerName) continue;

        const i = Math.floor(iRaw);
        const j = Math.floor(jRaw);
        const key = cellKey(i, j);

        // Support eraser: if color === 'transparent', delete pixel
        if (color === 'transparent') {
          if (pixelStore.has(key)) {
            pixelStore.delete(key);
            applied.push({ i, j, color: 'transparent', playerName, ts: new Date().toISOString() });
          }
        } else {
          const pixel = {
            i,
            j,
            color,
            playerName,
            ts: new Date().toISOString(),
          };
          // Overdraw: latest pixel always replaces previous color in the same cell
          pixelStore.set(key, pixel);
          applied.push(pixel);
        }
      }

      if (applied.length > 0) {
        broadcast({ type: 'pixels', pixels: applied });
        persistPixels();
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

