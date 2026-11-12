/* Foreground-only clinical alerts. Tokens stay in local storage and auth headers. */
'use strict';

window.PatientSync = (() => {
  const KEY = 'vitaltrack.patient-sync.v1';
  const PREFIX = '/api/clinical/mobile/';
  const FRESH_MS = 15000;
  const isCursor = value => Number.isSafeInteger(value) && value >= 0;
  const android = () => typeof cordova !== 'undefined' && cordova.platformId === 'android';
  let pairing = null;
  let initialStatus = 'Not paired';

  function serverOrigin(value) {
    const raw = String(value).trim();
    // Validate the original authority/path too: URL would silently normalize ../ or credentials.
    if (!/^https?:\/\/[^/?#@%\\\s]+\/?$/i.test(raw)) throw new Error('Enter an origin-only HTTP or HTTPS server URL.');
    const url = new URL(raw);
    if (url.username || url.password || url.port === '0') throw new Error('Server credentials are not allowed.');
    const host = url.hostname.toLowerCase();
    const octets = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? host.split('.').map(Number) : [];
    const privateIP = octets.length === 4 && octets.every(n => n <= 255) &&
      (octets[0] === 10 || octets[0] === 127 ||
       (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
       (octets[0] === 192 && octets[1] === 168));
    if (url.protocol === 'http:' && !(privateIP || host === 'localhost' || host === '[::1]' ||
        /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local$/.test(host))) {
      throw new Error('Public servers require HTTPS; HTTP is limited to local networks.');
    }
    if (!android() && url.origin !== window.location.origin) {
      throw new Error('Open this server’s /vitaltrack/ preview; browser sync must be same-origin.');
    }
    return url.origin;
  }

  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) {
      if (typeof saved.token !== 'string' || !/^[\x21-\x7e]+$/.test(saved.token) ||
          !isCursor(saved.cursor) || typeof saved.patient_name !== 'string' ||
          !['string', 'number'].includes(typeof saved.patient_id)) throw new Error('Invalid pairing');
      saved.server = serverOrigin(saved.server);
      pairing = saved;
    }
  } catch (_) {
    try { localStorage.removeItem(KEY); } catch (_) { /* Storage may be disabled. */ }
    initialStatus = 'Stored pairing unavailable. Enter a new dashboard code.';
  }

  let initialized = false;
  let deviceReady = false;
  let paused = false;
  let generation = 0;
  let timer = null;
  let pending = null;
  let operation = '';
  let connected = false;
  let failures = 0;
  let snapshotTimestamp = '';
  let statusText = initialStatus;
  let statusKind = 'idle';

  function foreground() { return !paused && !document.hidden; }
  function current(g, record) { return g === generation && pairing === record; }

  function render(message = statusText, kind = statusKind) {
    statusText = message;
    statusKind = kind;
    connected = kind === 'live';
    if (!initialized) return;
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    set('sync-patient', pairing ? `${pairing.patient_name} · Patient ${pairing.patient_id}` : 'No patient paired');
    set('sync-status', message);
    $('sync-status').dataset.state = kind;
    set('sync-badge', connected ? 'Connected' : pairing ? 'Stale' : operation === 'claim' ? 'Pairing' : 'Not paired');
    const badge = $('nb-network');
    const color = connected ? '#30D158' : '#8E8E93';
    if (badge) {
      badge.style.color = color;
      badge.style.borderColor = color;
      const dot = badge.querySelector('.nb-dot');
      if (dot) dot.style.background = color;
    }
    $('sync-connect').disabled = !!pairing || !!operation || !deviceReady;
    $('sync-disconnect').disabled = !pairing && operation !== 'claim';
    $('sync-server').disabled = !!pairing || !!operation;
    $('sync-code').disabled = !!pairing || !!operation;
    const button = $('btn-tele-toggle');
    if (pairing || operation === 'claim') {
      UI.setTelemetryStatus(message, 'Clinical patient feed · demo disabled', false);
      if (button) { button.disabled = true; button.textContent = 'Paired'; }
      UI.setPulseDotPhase(connected ? 'running' : 'idle');
    } else if (button) {
      button.disabled = false;
    }
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(pairing)); }
    catch (_) { throw { storage: true }; }
  }

  // Both transports settle exactly once. Aborting native work discards its callback;
  // HttpURLConnection itself closes on completion/timeout (no background service).
  function request(server, path, method, token, body) {
    let abort;
    const promise = new Promise((resolve, reject) => {
      let settled = false;
      let timeout;
      const controller = !android() ? new AbortController() : null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error); else resolve(value);
      };
      abort = () => {
        finish({ status: 0, aborted: true, message: 'Request cancelled' });
        if (controller) controller.abort();
      };
      timeout = setTimeout(() => {
        finish({ status: 0, message: 'Request timed out' });
        if (controller) controller.abort();
      }, 8000);
      if (android()) {
        if (!window.VitalTrackNative?.requestSync) {
          finish({ status: 0, message: 'Native sync bridge unavailable' });
          return;
        }
        try {
          window.VitalTrackNative.requestSync(server, path, method, token, body,
            value => finish(null, value), error => finish({
              status: Number(error?.status) || 0,
              message: typeof error?.message === 'string' ? error.message : 'Sync request failed'
            }));
        } catch (_) { finish({ status: 0, message: 'Native sync bridge unavailable' }); }
        return;
      }
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (body != null) headers['Content-Type'] = 'application/json';
      fetch(server + path, {
        method, headers, body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal, redirect: 'error', credentials: 'omit',
        cache: 'no-store', mode: 'same-origin'
      }).then(async response => {
        let value;
        try { value = await response.json(); } catch (_) { value = null; }
        if (!response.ok) {
          finish({ status: response.status, message: value?.message || 'Sync request failed' });
        } else if (value === null && response.status !== 204) {
          finish({ status: response.status, message: 'Invalid server response' });
        } else finish(null, value || {});
      }).catch(() => finish({ status: 0, message: 'Network unavailable' }));
    });
    return { promise, abort: () => abort && abort() };
  }

  function invalidate() {
    generation++;
    clearTimeout(timer);
    timer = null;
    if (pending) pending.abort();
    pending = null;
  }

  function applyVitals(vitals, timestamp, chart) {
    const prev = { hr: state.hr, spo2: state.spo2, rr: state.rr, temp: state.temp };
    const mapping = { hr: 'heart_rate', spo2: 'spo2', rr: 'respiratory_rate', temp: 'temperature' };
    Object.keys(mapping).forEach(key => {
      const value = vitals && vitals[mapping[key]];
      state[key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
    });
    UI.updateVitals(state, prev);
    UI.updateChartCurrents(state);
    if (chart) {
      Charts.push(fmtClock(new Date(timestamp)), state);
      Charts.updateStats();
    }
  }

  function stopDemo() {
    stopTelemetry();
    clearInterval(state.mainIntervalId);
    clearInterval(state.activityIntervalId);
    state.mainIntervalId = state.activityIntervalId = null;
    Native.cancelAllNotifications();
    Native.vibrate(0);
    Audio.stop();
    Charts.clear();
    applyVitals(null);
    snapshotTimestamp = '';
  }

  function clearPairing(message) {
    invalidate();
    pairing = null;
    operation = '';
    failures = 0;
    snapshotTimestamp = '';
    try { localStorage.removeItem(KEY); }
    catch (_) { message += ' Local storage could not be cleared; clear app data before reuse.'; }
    Native.cancelAllNotifications();
    Native.vibrate(0);
    Audio.stop();
    applyVitals(null);
    Charts.clear();
    UI.setTelemetryStatus('Not paired', 'Start runs demo data only', false);
    UI.setPulseDotPhase('idle');
    if (initialized) $('sync-code').value = '';
    render(message, 'idle');
  }

  function schedule(g, delay) {
    if (g !== generation || !pairing || !deviceReady || !foreground() || timer !== null) return;
    timer = setTimeout(() => { timer = null; poll(g); }, delay);
  }

  function validateFeed(data, record) {
    if (!data || !isCursor(data.cursor) || data.cursor < record.cursor || !Array.isArray(data.events) ||
        !data.patient || String(data.patient.id) !== String(record.patient_id) ||
        typeof data.patient.name !== 'string') throw new Error('Invalid patient feed');
    for (const event of data.events) {
      if (!event || !isCursor(event.id) || event.id > data.cursor ||
          !['watch', 'review', 'urgent'].includes(event.phase) ||
          typeof event.event_id !== 'string' || typeof event.title !== 'string' ||
          typeof event.text !== 'string') throw new Error('Invalid alert');
    }
  }

  async function poll(g) {
    if (g !== generation || pending || !pairing || !deviceReady || !foreground()) return;
    const record = pairing;
    pending = request(record.server, PREFIX + 'feed?after=' + record.cursor, 'GET', record.token, null);
    let delay = 1000;
    try {
      const data = await pending.promise;
      if (!current(g, record) || !foreground()) return;
      validateFeed(data, record);
      const events = data.events.slice().sort((a, b) => a.id - b.id);
      for (const event of events) {
        if (event.id <= record.cursor) continue;
        record.cursor = event.id;
        // The server retains only fresh events; persisted cursors prevent replay on reload.
        persist();
        applyVitals(event.vitals);
        triggerPhase(event.phase, event);
      }
      record.cursor = data.cursor;
      record.patient_name = data.patient.name;
      persist();
      const stamp = data.patient.timestamp;
      const normalizedStamp = typeof stamp === 'string' && !/(Z|[+-]\d{2}:\d{2})$/.test(stamp) ? stamp + 'Z' : stamp;
      const time = typeof normalizedStamp === 'string' ? Date.parse(normalizedStamp) : NaN;
      const validTime = Number.isFinite(time);
      applyVitals(data.patient.vitals, stamp, validTime && stamp !== snapshotTimestamp);
      snapshotTimestamp = stamp;
      failures = 0;
      const hasVitals = ['hr', 'spo2', 'rr', 'temp'].every(key => Number.isFinite(state[key]));
      const fresh = validTime && Date.now() - time >= -FRESH_MS && Date.now() - time <= FRESH_MS && hasVitals;
      render(fresh ? 'Connected · live patient feed' : 'Connected · patient timestamp outside live window (may use simulation time)', 'live');
      const updated = validTime ? new Date(time).toLocaleString() : 'unavailable';
      $('telemetry-timer').textContent = 'Patient updated: ' + updated;
    } catch (error) {
      if (!current(g, record)) return;
      if (error.status === 401) {
        clearPairing('Pairing expired (including after server restart). Generate a new dashboard code.');
        return;
      }
      if (error.storage) {
        disconnect('Local storage unavailable; pair again after enabling storage.');
        return;
      }
      failures++;
      delay = Math.min(5000, 1000 * Math.pow(2, Math.min(failures, 3)));
      render(`Paired · stale · reconnecting in ${delay / 1000}s`, 'stale');
    } finally {
      if (current(g, record)) {
        pending = null;
        schedule(g, delay);
      }
    }
  }

  async function connect(event) {
    if (event) event.preventDefault();
    if (!deviceReady || pairing || operation || !foreground()) return;
    let server;
    const code = $('sync-code').value.trim();
    try {
      server = serverOrigin($('sync-server').value);
      if (!/^[0-9]{6}$/.test(code)) throw new Error('Enter the 6-digit code from the dashboard.');
      // Fail before claiming a single-use code if durable storage is unavailable.
      localStorage.setItem(KEY, 'null');
      localStorage.removeItem(KEY);
    } catch (error) {
      render(error instanceof Error && error.name !== 'SecurityError' && error.name !== 'QuotaExceededError'
        ? error.message : 'Local storage is required for pairing.', 'idle');
      return;
    }
    invalidate();
    const g = generation;
    operation = 'claim';
    stopDemo();
    if (alertsEnabled()) Audio.prime();
    render('Connecting · claiming dashboard code…', 'connecting');
    pending = request(server, PREFIX + 'claim', 'POST', '', { code });
    $('sync-code').value = '';
    try {
      const data = await pending.promise;
      if (g !== generation) return;
      if (!data || typeof data.token !== 'string' || !/^[\x21-\x7e]+$/.test(data.token) ||
          !isCursor(data.cursor) || typeof data.patient_name !== 'string' ||
          !['string', 'number'].includes(typeof data.patient_id)) throw new Error('Invalid claim');
      pairing = { server, token: data.token, patient_id: data.patient_id,
        patient_name: data.patient_name, cursor: data.cursor };
      persist();
      failures = 0;
      operation = '';
      render('Paired · stale · waiting for patient feed', 'stale');
    } catch (error) {
      if (g !== generation) return;
      if (error.storage) {
        disconnect('Local storage unavailable; pairing cleared.');
        return;
      }
      operation = '';
      const message = error.status === 401 ? 'Code expired. Generate a new dashboard code.' :
        error.status >= 400 && error.status < 500 ? 'Code rejected. Generate a new dashboard code.' :
          'Unable to pair. Check server/network and generate a new code before retrying.';
      UI.setTelemetryStatus('Not paired', 'Start runs demo data only', false);
      render(message, 'idle');
    } finally {
      if (g === generation) { pending = null; schedule(g, 0); }
    }
  }

  async function disconnect(message) {
    const record = pairing;
    clearPairing(typeof message === 'string' ? message : 'Disconnected locally.');
    if (!record) return;
    const g = generation;
    operation = 'revoke';
    render(statusText + ' Revoking server connection…', 'idle');
    pending = request(record.server, PREFIX + 'connection', 'DELETE', record.token, null);
    try {
      await pending.promise;
      if (g === generation) render(typeof message === 'string' ? message : 'Disconnected; server connection revoked.', 'idle');
    } catch (error) {
      if (g === generation) render(error.status === 401 ? 'Disconnected; server connection already expired.' :
        'Disconnected locally; server revocation unconfirmed (offline). The server token remains valid until expiry.', 'idle');
    } finally {
      if (g === generation) { operation = ''; pending = null; render(); }
    }
  }

  function suspend() {
    invalidate();
    if (operation === 'claim') {
      operation = '';
      UI.setTelemetryStatus('Not paired', 'Pairing interrupted', false);
      render('Pairing interrupted. Generate a new dashboard code.', 'idle');
    } else if (operation === 'revoke') {
      operation = '';
      render('Disconnected locally; server revocation unconfirmed.', 'idle');
    }
    if (pairing) render('Paired · stale · polling paused while app is not foreground', 'stale');
  }

  function restart() {
    if (!deviceReady || !foreground() || !pairing || pending || timer !== null) return;
    render('Paired · stale · reconnecting…', 'stale');
    schedule(generation, 0);
  }

  function init() {
    if (initialized) return;
    initialized = true;
    $('sync-server').value = pairing ? pairing.server :
      (typeof cordova === 'undefined' && /^https?:$/.test(window.location.protocol) ? window.location.origin : '');
    $('sync-form').addEventListener('submit', connect);
    $('sync-disconnect').addEventListener('click', () => disconnect());
    document.addEventListener('pause', () => { paused = true; suspend(); });
    document.addEventListener('resume', () => { paused = false; restart(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else restart(); });
    window.addEventListener('offline', () => {
      suspend();
      if (pairing) { render('Paired · stale · network offline; reconnecting…', 'stale'); schedule(generation, 5000); }
    });
    window.addEventListener('online', restart);
    if (pairing) {
      stopDemo();
      render('Paired · stale · waiting for foreground connection', 'stale');
    } else render();
  }

  function ready() {
    deviceReady = true;
    render();
    restart();
  }

  return { init, ready, get isPaired() { return !!pairing; },
    get isConnecting() { return operation === 'claim'; }, get isConnected() { return connected; } };
})();
