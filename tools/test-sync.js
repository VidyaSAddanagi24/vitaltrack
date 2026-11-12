/* Offline, dependency-free regression tests: node tools/test-sync.js */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'www/js/index.js'), 'utf8');
const syncSource = fs.readFileSync(path.join(root, 'www/js/sync.js'), 'utf8');
const KEY = 'vitaltrack.patient-sync.v1';

class Element {
  constructor() {
    this.style = {}; this.dataset = {}; this.children = []; this.listeners = {};
    this.checked = true; this.value = ''; this.disabled = false; this.textContent = '';
    this.innerHTML = ''; this.parts = new Map();
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  fire(name) { return Promise.all((this.listeners[name] || []).map(fn => fn({ preventDefault() {}, target: this }))); }
  setAttribute() {}
  closest() { return null; }
  querySelector(selector) {
    if (!selector.startsWith('.') || !this.innerHTML.includes(selector.slice(1))) return null;
    if (!this.parts.has(selector)) this.parts.set(selector, new Element());
    return this.parts.get(selector);
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); }
  insertBefore(child) { child.parentNode = this; this.children.unshift(child); }
  removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children[this.children.length - 1]; }
}

function harness({ storage = new Map(), native = false } = {}) {
  let now = Date.parse('2026-11-12T10:00:00Z');
  let nextTimer = 0;
  const timers = new Map();
  const elements = new Map();
  const requests = [];
  const notifications = [];
  const vibrations = [];
  const chartSamples = [];
  const events = {};
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  get('nb-network').innerHTML = '<span class="nb-dot"></span>';
  const document = {
    hidden: false,
    getElementById: get,
    querySelectorAll: () => [], querySelector: () => null,
    createElement: () => new Element(),
    addEventListener: (event, fn) => (events[event] ||= []).push(fn)
  };
  const addTimer = (fn, ms, interval = false) => {
    const id = ++nextTimer; timers.set(id, { fn, at: now + ms, ms, interval }); return id;
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const sandbox = {
    document, URL, AbortController, Date: Clock,
    console: { log() {}, warn() {}, info() {} },
    navigator: { userAgent: '', vibrate: pattern => { vibrations.push(pattern); return true; } },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)
    },
    setTimeout: (fn, ms) => addTimer(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => addTimer(fn, ms, true), clearInterval: id => timers.delete(id),
    addEventListener: (event, fn) => (events[event] ||= []).push(fn),
    location: { origin: 'http://localhost:8000', protocol: 'http:' },
    fetch(url, opts) {
      return new Promise((resolve, reject) => {
        requests.push({ url, opts, resolve: (data, status = 200) => resolve({
          status, ok: status >= 200 && status < 300, json: async () => data
        }), reject });
        // Intentionally allow late completion after abort, to exercise generation guards.
      });
    }
  };
  sandbox.window = sandbox;
  const plugin = {
    requestPermission: callback => callback(true),
    schedule: payload => notifications.push(payload), cancelAll: callback => callback(),
    canScheduleExactAlarms: callback => callback(true)
  };
  if (native) {
    sandbox.cordova = { platformId: 'android', plugins: { notification: { local: plugin } } };
    sandbox.VitalTrackNative = {
      requestSync(server, endpoint, method, token, body, success, error) {
        requests.push({ url: server + endpoint, opts: { method, headers: { Authorization: token ? 'Bearer ' + token : undefined },
          body: body ? JSON.stringify(body) : undefined }, resolve: success, reject: error });
      }
    };
    sandbox.fetch = () => { throw new Error('Android must use native transport'); };
  }
  const context = vm.createContext(sandbox);
  vm.runInContext(indexSource, context);
  vm.runInContext(syncSource, context);
  const api = vm.runInContext('({ state, Native, UI, Charts, Audio, triggerPhase, startTelemetry })', context);
  api.Charts.push = (stamp, sample) => chartSamples.push({ ...sample });
  let fallbackSounds = 0;
  api.Audio.chime = api.Audio.alert = api.Audio.alarm = () => fallbackSounds++;
  if (native) api.Native.init(true);
  sandbox.PatientSync.init();
  sandbox.PatientSync.ready();
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const entry = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, timer] = entry;
      now = timer.at;
      timers.delete(id);
      if (timer.interval) timers.set(id, { ...timer, at: now + timer.ms });
      timer.fn();
      await flush();
    }
    now = target;
  }
  const emit = async name => { for (const fn of events[name] || []) fn(); await flush(); };
  const vitals = hr => ({ heart_rate: hr, spo2: 97, respiratory_rate: 18, temperature: 37 });
  const event = (id, hr = 140) => ({ id, event_id: 'event-' + id, phase: 'urgent', title: '<img src=x onerror=alert(1)>',
    text: '<script>bad()</script>', timestamp: new Clock().toISOString(), vitals: vitals(hr) });
  const feed = (cursor, items = [], hr = 75, timestamp = new Clock().toISOString()) => ({ cursor, events: items,
    patient: { id: 'p1', name: '<b>Patient</b>', timestamp, vitals: vitals(hr) } });
  async function claim(cursor = 10) {
    get('sync-server').value = 'http://localhost:8000';
    get('sync-code').value = '123456';
    get('sync-form').fire('submit');
    const req = requests.at(-1);
    assert.equal(req.opts.method, 'POST');
    assert.deepEqual(JSON.parse(req.opts.body), { code: '123456' });
    assert.ok(!req.opts.headers.Authorization);
    req.resolve({ token: 'secret-token', patient_id: 'p1', patient_name: 'Patient', cursor, expires_in: 3600 });
    await flush();
    await advance(0);
  }
  return { ...api, sandbox, get, requests, notifications, vibrations, storage, timers, chartSamples,
    flush, advance, emit, event, feed, claim, sounds: () => fallbackSounds };
}

async function main() {
  const h = harness({ native: true });
  h.startTelemetry();
  assert.equal(h.state.telemetryRunning, true);
  await h.claim();
  assert.equal(h.state.telemetryRunning, false, 'claim stops existing simulation');
  h.startTelemetry();
  assert.equal(h.state.telemetryRunning, false, 'paired simulation cannot restart');
  assert.equal(h.requests[1].url, 'http://localhost:8000/api/clinical/mobile/feed?after=10');
  assert.equal(h.requests[1].opts.headers.Authorization, 'Bearer secret-token');
  assert.ok(h.requests.every(req => !req.url.includes('secret-token')));
  assert.match(h.get('sync-status').textContent, /stale/);
  h.requests[1].resolve(h.feed(12, [h.event(12), h.event(11, 130), h.event(11), h.event(10)]));
  await h.flush();
  assert.equal(h.notifications.length, 2, 'sorted events deduplicated by id');
  assert.equal(h.notifications[0].data.hr, 130, 'event vitals applied before native trigger');
  assert.equal(h.notifications[1].data.hr, 140);
  assert.equal(h.notifications[1].androidChannelId, 'vt_alerts_urgent_v4');
  assert.equal(h.state.hr, 75, 'latest patient snapshot wins normal display');
  assert.equal(h.get('sync-patient').textContent, '<b>Patient</b> · Patient p1');
  const banner = h.get('notification-container').lastChild;
  assert.ok(!banner.innerHTML.includes('<script>'), 'banner does not interpolate message HTML');
  assert.equal(banner.querySelector('.notif-title').textContent, '<img src=x onerror=alert(1)>');
  assert.ok(!h.get('activity-log').firstChild.innerHTML.includes('<script>'));
  assert.equal(JSON.parse(h.storage.get(KEY)).cursor, 12);
  assert.equal(h.sandbox.PatientSync.isConnected, true);

  await h.advance(1000);
  const count = h.requests.length;
  await h.advance(1000);
  assert.equal(h.requests.length, count, 'no overlapping foreground polls');
  h.requests.at(-1).reject({ status: 0, message: 'offline' });
  await h.flush();
  assert.equal(h.sandbox.PatientSync.isPaired, true);
  assert.equal(h.sandbox.PatientSync.isConnected, false);
  assert.match(h.get('sync-status').textContent, /stale.*reconnecting/);
  for (const delay of [2000, 4000, 5000]) {
    const before = h.requests.length;
    await h.advance(delay - 1);
    assert.equal(h.requests.length, before);
    await h.advance(1);
    assert.equal(h.requests.length, before + 1);
    if (delay !== 5000) { h.requests.at(-1).reject({ status: 0 }); await h.flush(); }
  }
  h.get('notif-toggle').checked = false;
  const beforeVibration = h.vibrations.length;
  h.requests.at(-1).resolve(h.feed(13, [h.event(12), h.event(13)]));
  await h.flush();
  assert.equal(h.notifications.length, 2, 'mute prevents native scheduling');
  assert.equal(h.vibrations.length, beforeVibration, 'mute prevents vibration');
  assert.equal(h.sounds(), 0, 'mute prevents fallback sound');
  assert.equal(h.state.alertLog.length, 3, 'muted alerts still logged');

  await h.advance(1000);
  const stale = h.requests.at(-1);
  await h.emit('pause');
  const beforePause = h.requests.length;
  await h.advance(10000);
  assert.equal(h.requests.length, beforePause);
  stale.resolve(h.feed(14, [h.event(14)]));
  await h.flush();
  assert.equal(JSON.parse(h.storage.get(KEY)).cursor, 13, 'late native callbacks ignored after pause');
  await h.emit('resume');
  await h.emit('resume');
  await h.advance(0);
  assert.equal(h.requests.length, beforePause + 1, 'resume starts only one poll');
  h.requests.at(-1).resolve(h.feed(13, [], 72, '2020-01-01T00:00:00Z'));
  await h.flush();
  assert.match(h.get('sync-status').textContent, /timestamp outside live window/);
  assert.equal(h.sandbox.PatientSync.isConnected, true, 'connection and patient-clock freshness are separate');

  await h.advance(1000);
  const beforeDisconnect = h.requests.at(-1);
  h.get('sync-disconnect').fire('click');
  assert.equal(h.storage.has(KEY), false, 'disconnect clears persisted pairing immediately');
  assert.equal(h.sandbox.PatientSync.isPaired, false);
  const revoke = h.requests.at(-1);
  assert.equal(revoke.opts.method, 'DELETE');
  assert.equal(revoke.opts.headers.Authorization, 'Bearer secret-token');
  revoke.resolve({});
  await h.flush();
  await h.claim(50);
  beforeDisconnect.resolve(h.feed(99, [h.event(99)]));
  await h.flush();
  assert.equal(JSON.parse(h.storage.get(KEY)).cursor, 50, 'old response cannot affect re-pairing');
  h.requests.at(-1).reject({ status: 401, message: 'expired' });
  await h.flush();
  assert.equal(h.sandbox.PatientSync.isPaired, false);
  assert.equal(h.storage.has(KEY), false);
  assert.match(h.get('sync-status').textContent, /new dashboard code/);
  const after401 = h.requests.length;
  await h.advance(10000);
  assert.equal(h.requests.length, after401, '401 stops retries');

  const storage = new Map([[KEY, JSON.stringify({ server: 'http://localhost:8000', token: 'saved-token',
    patient_id: 'p1', patient_name: 'Saved', cursor: 20 })]]);
  const reload = harness({ storage });
  await reload.advance(0);
  assert.match(reload.requests[0].url, /after=20$/);
  reload.requests[0].resolve(reload.feed(23, [reload.event(21), reload.event(23)]));
  await reload.flush();
  assert.equal(reload.state.alertLog.length, 2, 'reload delivers retained events beyond the saved cursor');
  assert.equal(JSON.parse(storage.get(KEY)).cursor, 23);
  await reload.advance(1000);
  reload.get('notif-toggle').checked = false;
  const initialVibrations = reload.vibrations.length;
  const initialSounds = reload.sounds();
  reload.requests.at(-1).resolve(reload.feed(24, [reload.event(23), reload.event(24)]));
  await reload.flush();
  assert.equal(reload.state.alertLog.length, 3);
  assert.equal(reload.vibrations.length, initialVibrations);
  assert.equal(reload.sounds(), initialSounds, 'browser mute also prevents fallback audio');
  assert.equal(reload.requests[0].opts.redirect, 'error');
  assert.equal(reload.requests[0].opts.mode, 'same-origin');
  await reload.advance(1000);
  await reload.advance(8000);
  assert.match(reload.get('sync-status').textContent, /reconnecting/, 'fetch has an 8s timeout');
  assert.equal(reload.requests.at(-1).opts.signal.aborted, true);

  const preview = harness();
  for (const origin of ['http://public.example', 'https://other.example', 'http://u:p@localhost:8000',
    'http://@localhost:8000', 'http://localhost:8000/path', 'http://localhost:8000/?x=1',
    'http://localhost:8000/#fragment']) {
    preview.get('sync-server').value = origin;
    preview.get('sync-code').value = '123456';
    await preview.get('sync-form').fire('submit');
    assert.equal(preview.requests.length, 0, 'reject origin: ' + origin);
  }
  preview.get('sync-server').value = 'http://localhost:8000';
  preview.get('sync-code').value = '123456';
  preview.get('sync-form').fire('submit');
  const lateClaim = preview.requests.at(-1);
  preview.get('sync-disconnect').fire('click');
  lateClaim.resolve({ token: 'late-token', patient_id: 'p1', patient_name: 'Late', cursor: 0 });
  await preview.flush();
  assert.equal(preview.sandbox.PatientSync.isPaired, false, 'cancelled claim cannot pair later');
  assert.equal(preview.storage.has(KEY), false);

  const phases = harness({ native: true });
  for (const phase of ['watch', 'review', 'urgent']) phases.triggerPhase(phase);
  assert.deepEqual(phases.notifications.map(n => n.androidChannelId),
    ['vt_alerts_watch_v1', 'vt_alerts_review_v4', 'vt_alerts_urgent_v4']);
  assert.equal(phases.vibrations.length, 3);
  phases.get('notif-toggle').checked = false;
  for (const phase of ['watch', 'review', 'urgent']) phases.triggerPhase(phase);
  assert.equal(phases.notifications.length, 3);
  assert.equal(phases.vibrations.length, 3);
  assert.equal(phases.state.alertLog.length, 6);
  const browserAlerts = harness();
  browserAlerts.triggerPhase('watch');
  assert.equal(browserAlerts.sounds(), 1, 'unmuted browser uses audio fallback');
  browserAlerts.get('notif-toggle').checked = false;
  browserAlerts.triggerPhase('urgent');
  assert.equal(browserAlerts.sounds(), 1);

  const unauthorized = harness({ storage: new Map([[KEY, JSON.stringify({ server: 'http://localhost:8000',
    token: 'saved-token', patient_id: 'p1', patient_name: 'Saved', cursor: 0 })]]) });
  await unauthorized.advance(0);
  unauthorized.requests[0].resolve({ message: 'Server restarted' }, 401);
  await unauthorized.flush();
  assert.equal(unauthorized.sandbox.PatientSync.isPaired, false, 'fetch 401 also clears pairing');

  // Exercise the actual bridge wrapper's object serialization and 401 normalization.
  let invocation;
  const bridge = { module: { exports: {} }, require: () => (...args) => { invocation = args; } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'local-plugins/vitaltrack-native/www/vitaltrack-native.js'), 'utf8'), bridge);
  let bridgeError;
  bridge.module.exports.requestSync('http://localhost', '/api/clinical/mobile/claim', 'POST', '', { code: '123456' },
    () => {}, err => { bridgeError = err; });
  assert.equal(invocation[4][4], '{"code":"123456"}');
  invocation[1]({ status: '401', message: 'Expired' });
  assert.equal(bridgeError.status, 401);
  console.log('PASS: dedup, event vitals, native channels, mute, safe text, sequential polling, bounded retry, pause/resume, stale guards, disconnect/re-pair, 401, reload cursor recovery, timeout, origin validation, bridge errors');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
