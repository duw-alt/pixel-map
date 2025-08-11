/* Multiplayer Pixel Map (Lite) - Frontend */

// Constants
const ZOOM_THRESHOLD = 15;
// Full cell rendering for clean edges
const PIXEL_SCALE = 1.0;
const MAX_PIXELS = 100;
const REFILL_INTERVAL_MS = 20000; // 20s per pixel
const SNAP_EPS = 1e-9; // mitigate FP boundary issues
// Mercator square grid size (meters). Server will send authoritative value.
let GRID_METERS = 25;

// UI elements
const nameModal = document.getElementById('name-modal');
const nameForm = document.getElementById('name-form');
const nameInput = document.getElementById('player-name');
const counterEl = document.getElementById('counter');
const paintBtn = document.getElementById('paint-btn');
const colorPicker = document.getElementById('color-picker');
const refillEl = document.getElementById('refill');
const cancelBtn = document.getElementById('cancel-btn');
const eraserBtn = document.getElementById('eraser-btn');
const hintEl = document.getElementById('hint');
const guestDisplay = document.getElementById('guest-display');
const guestName = document.getElementById('guest-name');
const secretCodeBtn = document.getElementById('secret-code-btn');
const secretCodeInput = document.getElementById('secret-code');

// Audio for click sounds
const clickSound = new Audio('/click-sound.mp3');

// Function to play click sound
function playClickSound() {
  clickSound.currentTime = 0; // Reset to start
  clickSound.play().catch(e => console.log('Audio play failed:', e));
}

// Secret code functionality
let unlimitedPixels = false;

function checkSecretCode(code) {
  if (code.toLowerCase() === 'goonlord') {
    unlimitedPixels = true;
    session.remaining = Infinity;
    if (counterEl) {
      counterEl.textContent = 'Pixels left: ∞';
    }
    if (refillEl) {
      refillEl.classList.add('hidden');
    }
    return true;
  }
  return false;
}

// Player session (in-memory only)
const session = {
  playerName: null,
  color: null,
  remaining: MAX_PIXELS,
};

// Utility to persist pixel count
function savePixelCount() {
  if (session.playerName) {
    localStorage.setItem('pixelCount', String(session.remaining));
  }
}

// Utility to restore pixel count
function restorePixelCount() {
  const stored = localStorage.getItem('pixelCount');
  if (stored !== null && !isNaN(Number(stored))) {
    session.remaining = Math.max(0, Math.min(MAX_PIXELS, Number(stored)));
  }
}

// Refill state
let nextRefillAtMs = null;
let refillTimerId = null;

// Data structures
// Map<key, {i, j, color, playerName}>
const committedPixels = new Map();
// Map<key, {i, j, color, playerName}>
const queuedPixels = new Map();

// Map and canvas setup
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [0, 0],
  zoom: 2,
  bearing: 0,
  pitch: 0,
});

// Ensure flat view and disable rotation/tilt gestures
map.setBearing(0);
map.setPitch(0);
if (map.dragRotate && typeof map.dragRotate.disable === 'function') {
  map.dragRotate.disable();
}
if (map.touchZoomRotate && typeof map.touchZoomRotate.disableRotation === 'function') {
  map.touchZoomRotate.disableRotation();
}

// Canvas overlay on top of MapLibre canvas
const overlayCanvas = document.createElement('canvas');
overlayCanvas.className = 'overlay';
const overlayCtx = overlayCanvas.getContext('2d');
map.getContainer().appendChild(overlayCanvas);

function resizeOverlay() {
  const mapCanvas = map.getCanvas();
  const dpr = window.devicePixelRatio || 1;
  overlayCanvas.style.width = mapCanvas.clientWidth + 'px';
  overlayCanvas.style.height = mapCanvas.clientHeight + 'px';
  overlayCanvas.width = Math.round(mapCanvas.clientWidth * dpr);
  overlayCanvas.height = Math.round(mapCanvas.clientHeight * dpr);
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

map.on('load', () => {
  resizeOverlay();
  render();
});
map.on('resize', resizeOverlay);
map.on('move', () => requestAnimationFrame(render));
map.on('zoom', () => {
  updateHud();
  requestAnimationFrame(render);
});

// Hover tracking for highlight
let hoverCell = null;
// Tooltip for pixel hover
const pixelTooltip = document.createElement('div');
pixelTooltip.style.position = 'absolute';
pixelTooltip.style.pointerEvents = 'none';
pixelTooltip.style.background = 'rgba(20,22,28,0.95)';
pixelTooltip.style.color = '#e8e8e8';
pixelTooltip.style.padding = '6px 12px';
pixelTooltip.style.borderRadius = '8px';
pixelTooltip.style.fontSize = '0.95rem';
pixelTooltip.style.fontWeight = '500';
pixelTooltip.style.boxShadow = '0 2px 8px rgba(0,0,0,0.25)';
pixelTooltip.style.zIndex = '100';
pixelTooltip.style.display = 'none';
document.body.appendChild(pixelTooltip);

function showPixelTooltip(text, x, y) {
  pixelTooltip.textContent = text;
  pixelTooltip.style.left = `${x + 12}px`;
  pixelTooltip.style.top = `${y + 12}px`;
  pixelTooltip.style.display = 'block';
}
function hidePixelTooltip() {
  pixelTooltip.style.display = 'none';
}

// Patch map mousemove to show tooltip
map.on('mousemove', (e) => {
  if (map.getZoom() < ZOOM_THRESHOLD) {
    hoverCell = null;
    hidePixelTooltip();
    return requestAnimationFrame(render);
  }
  const { lng, lat } = e.lngLat.wrap();
  hoverCell = snapLngLatToIJ(lng, lat);
  // Find pixel info
  const key = cellKey(hoverCell.i, hoverCell.j);
  let px = queuedPixels.get(key);
  if (px && px.playerName === session.playerName) {
    // Don't show tooltip for user's own unplaced pixels
    hidePixelTooltip();
  } else {
    // Show for committed pixels or (if ever) queued pixels by others
    px = px || committedPixels.get(key);
    if (px && px.playerName) {
      showPixelTooltip(`painted by ${px.playerName}`, e.originalEvent.clientX, e.originalEvent.clientY);
    } else {
      hidePixelTooltip();
    }
  }
  requestAnimationFrame(render);
});

map.on('mouseout', () => {
  hidePixelTooltip();
});

// Cursor feedback during drag
map.on('dragstart', () => {
  map.getCanvas().classList.add('is-dragging');
});
map.on('dragend', () => {
  map.getCanvas().classList.remove('is-dragging');
});

// Handle clicks to queue pixels (only in Canvas Mode and when session active)
map.on('click', (e) => {
  if (!session.playerName) return;
  if (map.getZoom() < ZOOM_THRESHOLD) return;
  if (!isEraserEnabled() && !unlimitedPixels && session.remaining <= 0) return;

  const { lng, lat } = e.lngLat.wrap();
  const { i, j } = snapLngLatToIJ(lng, lat);
  const key = cellKey(i, j);

  // Eraser: remove from queue only (cannot erase committed pixels)
  if (isEraserEnabled()) {
    if (queuedPixels.has(key)) {
      queuedPixels.delete(key);
      if (!unlimitedPixels) {
        session.remaining = Math.max(0, session.remaining + 1);
        savePixelCount();
      }
      ensureRefillTimer();
      updateHud();
      render();
      playClickSound();
    }
    return;
  }

  // If already queued, ignore
  if (queuedPixels.has(key)) return;

  const pixel = { i, j, color: session.color, playerName: session.playerName };
  queuedPixels.set(key, pixel);
  if (!unlimitedPixels) {
    session.remaining = Math.max(0, session.remaining - 1);
    savePixelCount();
  }
  ensureRefillTimer();
  updateHud();
  render();
  playClickSound();
});

function updateHud() {
  if (unlimitedPixels) {
    counterEl.textContent = 'Pixels left: ∞';
  } else {
    counterEl.textContent = `Pixels left: ${session.remaining}`;
  }
  const inCanvasMode = map.getZoom() >= ZOOM_THRESHOLD;
  paintBtn.classList.toggle('hidden', !inCanvasMode);
  paintBtn.disabled = queuedPixels.size === 0;
  if (cancelBtn) {
    // Only visible when user is actively painting (has at least one queued)
    const showCancel = inCanvasMode && queuedPixels.size > 0;
    cancelBtn.classList.toggle('hidden', !showCancel);
    cancelBtn.disabled = !showCancel;
  }
  if (eraserBtn) {
    // Only visible when user is actively painting (has at least one queued)
    const showEraser = inCanvasMode && queuedPixels.size > 0;
    eraserBtn.classList.toggle('hidden', !showEraser);
    eraserBtn.disabled = !showEraser;
    if (queuedPixels.size === 0) {
      eraserBtn.setAttribute('aria-pressed', 'false');
    }
  }
  updateRefillHud();
  updateHint();
}

function updateGuestDisplay() {
  if (!guestDisplay || !guestName) return;
  if (session.playerName) {
    guestName.textContent = `painting as #${session.playerName}`;
    guestDisplay.classList.remove('hidden');
  } else {
    guestDisplay.classList.add('hidden');
  }
}

// Mercator grid helpers
const R = 6378137;

function lonLatToMercMeters(lonDeg, latDeg) {
  const clampLat = Math.max(Math.min(latDeg, 85.05112878), -85.05112878);
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (clampLat * Math.PI) / 180;
  const x = R * lon;
  const y = R * Math.log(Math.tan(Math.PI / 4 + lat / 2));
  return { x, y };
}

function mercMetersToLonLat(x, y) {
  const lon = (x / R) * (180 / Math.PI);
  const lat = (Math.atan(Math.sinh(y / R)) * 180) / Math.PI;
  return { lon, lat };
}

function snapLngLatToIJ(lon, lat) {
  const { x, y } = lonLatToMercMeters(lon, lat);
  // Use floor so the cell under the cursor is always selected
  const i = Math.floor(x / GRID_METERS);
  const j = Math.floor(y / GRID_METERS);
  return { i, j };
}

function cellKey(i, j) {
  return `${i},${j}`;
}

// Drawing helpers
function drawGrid() {
  const zoomOk = map.getZoom() >= ZOOM_THRESHOLD;
  if (!zoomOk) return;

  const bounds = map.getBounds();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const swM = lonLatToMercMeters(west, south);
  const neM = lonLatToMercMeters(east, north);
  const iStart = Math.ceil(swM.x / GRID_METERS);
  const iEnd = Math.floor(neM.x / GRID_METERS);
  const jStart = Math.ceil(swM.y / GRID_METERS);
  const jEnd = Math.floor(neM.y / GRID_METERS);

  // Safety: avoid drawing too many lines if zoomed out
  if (iEnd - iStart > 800 || jEnd - jStart > 800) return;

  overlayCtx.save();
  overlayCtx.lineWidth = 1;
  overlayCtx.strokeStyle = 'rgba(255,255,255,0.2)';

  // Vertical lines (constant x in mercator meters)
  for (let ii = iStart; ii <= iEnd; ii++) {
    const x = ii * GRID_METERS;
    const a = mercMetersToLonLat(x, swM.y);
    const b = mercMetersToLonLat(x, neM.y);
    const p1 = map.project([a.lon, a.lat]);
    const p2 = map.project([b.lon, b.lat]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(p1.x, p1.y);
    overlayCtx.lineTo(p2.x, p2.y);
    overlayCtx.stroke();
  }

  // Horizontal lines (constant y in mercator meters)
  for (let jj = jStart; jj <= jEnd; jj++) {
    const y = jj * GRID_METERS;
    const a = mercMetersToLonLat(swM.x, y);
    const b = mercMetersToLonLat(neM.x, y);
    const p1 = map.project([a.lon, a.lat]);
    const p2 = map.project([b.lon, b.lat]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(p1.x, p1.y);
    overlayCtx.lineTo(p2.x, p2.y);
    overlayCtx.stroke();
  }

  overlayCtx.restore();
}

function drawPixelCell(i, j, color, opts = {}) {
  // Convert Mercator cell [i,j] to lon/lat corners
  const x0m = i * GRID_METERS;
  const y0m = j * GRID_METERS;
  const x1m = x0m + GRID_METERS;
  const y1m = y0m + GRID_METERS;
  const bl = mercMetersToLonLat(x0m, y0m);
  const tr = mercMetersToLonLat(x1m, y1m);
  const pBL = map.project([bl.lon, bl.lat]);
  const pTR = map.project([tr.lon, tr.lat]);
  const rectX = pBL.x;
  const rectY = pTR.y;
  const rectW = pTR.x - pBL.x;
  const rectH = pBL.y - pTR.y;

  // Optional scale centered
  // Center a square scaled by PIXEL_SCALE (can be <1 or >1)
  const s = Math.min(rectW, rectH) * PIXEL_SCALE;
  let px = rectX + (rectW - s) / 2;
  let py = rectY + (rectH - s) / 2;
  let w = s;
  let h = s;

  // Tiny overdraw to hide seam artifacts
  const overdraw = 0.5;
  px -= overdraw / 2;
  py -= overdraw / 2;
  w += overdraw;
  h += overdraw;

  overlayCtx.fillStyle = color;
  overlayCtx.fillRect(px, py, w, h);

  if (opts.outlineColor) {
    overlayCtx.strokeStyle = opts.outlineColor;
    overlayCtx.lineWidth = 1.0;
    overlayCtx.strokeRect(px + 0.5, py + 0.5, w - 1, h - 1);
  }
}

function render() {
  // Clear
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  // Draw grid if in Canvas Mode
  drawGrid();

  // Draw committed pixels
  for (const px of committedPixels.values()) {
    drawPixelCell(px.i, px.j, px.color);
  }

  // Draw queued pixels on top with outline
  for (const px of queuedPixels.values()) {
    drawPixelCell(px.i, px.j, px.color, { outlineColor: 'white' });
  }

  // Hover highlight cell
  if (hoverCell && map.getZoom() >= ZOOM_THRESHOLD) {
    const { i, j } = hoverCell;
    const x0m = i * GRID_METERS;
    const y0m = j * GRID_METERS;
    const x1m = x0m + GRID_METERS;
    const y1m = y0m + GRID_METERS;
    const bl = mercMetersToLonLat(x0m, y0m);
    const tr = mercMetersToLonLat(x1m, y1m);
    const pBL = map.project([bl.lon, bl.lat]);
    const pTR = map.project([tr.lon, tr.lat]);
    const rectX = pBL.x;
    const rectY = pTR.y;
    const rectW = pTR.x - pBL.x;
    const rectH = pBL.y - pTR.y;
    overlayCtx.save();
    overlayCtx.strokeStyle = 'rgba(255,255,255,0.8)';
    overlayCtx.lineWidth = 2;
    overlayCtx.strokeRect(rectX + 1, rectY + 1, rectW - 2, rectH - 2);
    overlayCtx.restore();
  }
}

function updateHint() {
  if (!hintEl) return;
  // Show each hint only once per page load
  if (!updateHint._shown) updateHint._shown = new Set();
  if (!session.playerName) {
    hintEl.textContent = 'Enter your name to start';
    if (!updateHint._shown.has('name')) {
      showHintOnce('name');
    }
    return;
  }
  const inCanvasMode = map.getZoom() >= ZOOM_THRESHOLD;
  if (!inCanvasMode) {
    // Persistent zoom hint (no fade) until user zooms in
    hintEl.textContent = 'Zoom in to start painting';
    hintEl.classList.remove('hidden');
    hintEl.classList.remove('fade-out');
    return;
  }
  // In Canvas Mode: no secondary hint
  hintEl.classList.add('hidden');
  hintEl.classList.remove('fade-out');
  return;
}

function showHintOnce(key) {
  updateHint._shown.add(key);
  hintEl.classList.remove('hidden');
  hintEl.classList.remove('fade-out');
  // Allow layout to apply, then start fade after ~3s
  setTimeout(() => {
    hintEl.classList.add('fade-out');
    // After transition, hide fully
    setTimeout(() => hintEl.classList.add('hidden'), 350);
  }, 3000);
}

// (No eraser drawing; eraser only removes queued items pre-commit)

// WebSocket client
let ws;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    // no-op
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'snapshot') {
      if (typeof msg.gridMeters === 'number' && isFinite(msg.gridMeters)) {
        GRID_METERS = msg.gridMeters;
      }
      committedPixels.clear();
      if (Array.isArray(msg.pixels)) {
        for (const px of msg.pixels) {
          const key = cellKey(px.i, px.j);
          committedPixels.set(key, px);
        }
      }
      render();
    } else if (msg.type === 'pixels' && Array.isArray(msg.pixels)) {
      for (const px of msg.pixels) {
        const key = cellKey(px.i, px.j);
        committedPixels.set(key, px);
        // If we had this queued, drop it (server is source of truth)
        queuedPixels.delete(key);
      }
      updateHud();
      render();
    }
  };

  ws.onclose = () => {
    // attempt lightweight reconnect
    setTimeout(connectWS, 1500);
  };
}

connectWS();

// Paint Now button
paintBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (queuedPixels.size === 0) return;

  const pixels = Array.from(queuedPixels.values()).map((p) => ({
    i: p.i,
    j: p.j,
    color: p.color,
    playerName: p.playerName,
  }));

  ws.send(JSON.stringify({ type: 'paint', pixels }));

  // Optimistically clear queue (server will broadcast authoritative pixels)
  queuedPixels.clear();
  updateHud();
  render();
});

// Cancel button returns queued pixels and clears preview
if (cancelBtn) {
  cancelBtn.addEventListener('click', () => {
    if (queuedPixels.size === 0) return;
    const giveBack = queuedPixels.size;
    queuedPixels.clear();
    session.remaining = Math.min(MAX_PIXELS, session.remaining + giveBack);
    savePixelCount();
    ensureRefillTimer();
    updateHud();
    render();
  });
}

// ESC key cancels queued tiles
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && queuedPixels.size > 0) {
    cancelBtn?.click();
  }
});

// Eraser toggle
function isEraserEnabled() {
  return eraserBtn && eraserBtn.getAttribute('aria-pressed') === 'true';
}
if (eraserBtn) {
  eraserBtn.addEventListener('click', () => {
    const pressed = eraserBtn.getAttribute('aria-pressed') === 'true';
    eraserBtn.setAttribute('aria-pressed', String(!pressed));
  });
}

// Name prompt flow
nameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = (nameInput.value || '').trim();
  if (!name) return;
  session.playerName = name;
  localStorage.setItem('guestName', name); // Store in localStorage
  // Default to name-based color, but sync picker and swatch
  session.color = colorForName(name);
  // Initialize picker to session color
  if (colorPicker) {
    try { colorPicker.value = session.color; } catch {}
  }
  nameModal.classList.add('hidden');
  ensureRefillTimer();
  updateHud();
  updateGuestDisplay();
});

// Color utility: deterministic color from name
function colorForName(name) {
  const palette = [
    '#ff4d4f', '#ff7a45', '#ffa940', '#ffc53d', '#fadb14', '#73d13d', '#36cfc9',
    '#40a9ff', '#597ef7', '#9254de', '#eb2f96', '#13c2c2', '#2f54eb', '#fa541c',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

// Color picker wiring
if (colorPicker) {
  // Set a pleasant default until name is submitted
  try { colorPicker.value = '#40a9ff'; } catch {}
  colorPicker.addEventListener('input', () => {
    if (!session.playerName) return; // require name first
    session.color = colorPicker.value;
    render();
  });
}

// Refill logic
function ensureRefillTimer() {
  if (unlimitedPixels || session.remaining >= MAX_PIXELS) {
    stopRefillTimer();
    return;
  }
  if (refillTimerId == null) {
    if (nextRefillAtMs == null) {
      nextRefillAtMs = Date.now() + REFILL_INTERVAL_MS;
    }
    refillTimerId = setInterval(onRefillTick, 250);
  }
}

function stopRefillTimer() {
  if (refillTimerId != null) {
    clearInterval(refillTimerId);
    refillTimerId = null;
  }
  nextRefillAtMs = null;
  updateRefillHud();
}

function onRefillTick() {
  if (unlimitedPixels || session.remaining >= MAX_PIXELS) {
    stopRefillTimer();
    return;
  }
  const now = Date.now();
  if (nextRefillAtMs != null && now >= nextRefillAtMs) {
    const elapsed = now - nextRefillAtMs;
    const steps = 1 + Math.floor(elapsed / REFILL_INTERVAL_MS);
    session.remaining = Math.min(MAX_PIXELS, session.remaining + steps);
    savePixelCount();
    nextRefillAtMs += steps * REFILL_INTERVAL_MS;
    if (session.remaining >= MAX_PIXELS) {
      stopRefillTimer();
    }
    updateHud();
  } else {
    updateRefillHud();
  }
}

function updateRefillHud() {
  if (!refillEl) return;
  if (unlimitedPixels || session.remaining >= MAX_PIXELS || !session.playerName) {
    refillEl.classList.add('hidden');
    return;
  }
  refillEl.classList.remove('hidden');
  const msLeft = Math.max(0, (nextRefillAtMs ?? (Date.now() + REFILL_INTERVAL_MS)) - Date.now());
  refillEl.textContent = `Next +1 in ${formatTime(msLeft)}`;
}

function formatTime(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return `${mm}:${ss}`;
}

// Also update guest display on page load and when updating HUD
updateGuestDisplay();
const origUpdateHud = updateHud;
updateHud = function() {
  origUpdateHud.apply(this, arguments);
  updateGuestDisplay();
};

// On page load, check for stored guest name
const storedName = localStorage.getItem('guestName');
if (storedName) {
  session.playerName = storedName;
  session.color = colorForName(storedName);
  if (colorPicker) {
    try { colorPicker.value = session.color; } catch {}
  }
  nameModal.classList.add('hidden');
  restorePixelCount();
  ensureRefillTimer();
  updateHud();
  updateGuestDisplay && updateGuestDisplay();
}

// Secret code button event listener
if (secretCodeBtn) {
  secretCodeBtn.addEventListener('click', () => {
    const code = prompt('Enter secret code:');
    if (code && checkSecretCode(code.trim())) {
      // No sound for secret code activation
    }
  });
}

// Secret code input event listener (fallback)
if (secretCodeInput) {
  secretCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const code = secretCodeInput.value.trim();
      if (checkSecretCode(code)) {
        secretCodeInput.value = '';
        secretCodeInput.style.display = 'none';
        playClickSound();
      }
    }
  });
}

