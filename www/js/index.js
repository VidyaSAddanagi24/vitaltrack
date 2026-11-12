/**
 * ══════════════════════════════════════════════════════════════
 *  VitalTrack — www/js/index.js
 *
 *  Dark Apple Fitness-style UI, three activity rings, live
 *  telemetry, native alerts (vibration + local notifications)
 *  and shareable PDF clinical reports.
 *
 *  Vibration lengths:
 *    watch   → 2000 ms single pulse                 (2 s)
 *    review  → 5 × 800 ms pulses, 250 ms gaps       (5 s)
 *    urgent  → 7 × 1200 ms pulses, 200 ms gaps      (9.6 s, heavy)
 * ══════════════════════════════════════════════════════════════
 */

'use strict';

/* ════════════════════════════════════════════════════════════════
   §1  NATIVE CAPABILITY REGISTRY
════════════════════════════════════════════════════════════════ */
const Native = (() => {

  let _cordovaReady      = false;
  let _notificationAvail = false;
  let _deviceAvail       = false;
  let _notifPermGranted  = false;
  let _notifPermWarned   = false;
  let _exactAlarmOk      = false;
  let _notifIdCounter    = 100;
  let _notificationGeneration = 0;

  /**
   * Vibrate the device.
   * @param {number|number[]} pattern
   *   number    → single pulse ms            e.g. 2000
   *   number[]  → [on, off, on, off…] ms     e.g. [800, 250, 800]
   */
  function vibrate(pattern) {
    const tryNav = () => {
      if (typeof navigator.vibrate !== 'function') return false;
      try {
        navigator.vibrate(pattern);
        console.log('[Vibration] navigator.vibrate', pattern);
        return true;
      } catch (e) {
        console.warn('[Vibration] navigator.vibrate failed:', e);
        return false;
      }
    };

    if (tryNav()) return;

    // Legacy native service — iOS, or older plugin builds that ship it
    if (_cordovaReady && typeof cordova !== 'undefined' && cordova.exec) {
      const onErr = e => {
        console.warn('[Vibration] exec failed:', e);
        tryNav();
      };
      if (Array.isArray(pattern) && pattern.length > 1) {
        cordova.exec(null, onErr, 'Vibration', 'vibrateWithPattern', [pattern, -1]);
      } else if (Array.isArray(pattern) && pattern.length === 1) {
        cordova.exec(null, onErr, 'Vibration', 'vibrate', [pattern[0]]);
      } else if (typeof pattern === 'number' && pattern > 0) {
        cordova.exec(null, onErr, 'Vibration', 'vibrate', [pattern]);
      }
      return;
    }

    console.info('[Vibration] No vibration API available on this platform');
  }

  /* ──────────────────────────────────────────────────────────────
     LOCAL NOTIFICATIONS
  ────────────────────────────────────────────────────────────── */

  /**
   * Schedule a native OS notification ~1 second from now.
   * @param {Object} opts
   */
  function scheduleNotification(opts) {
    // Re-check after asynchronous permission requests as well as at alert time.
    if (!alertsEnabled()) return;
    if (!_notificationAvail) {
      console.info('[Notification] Plugin not available');
      return;
    }

    if (!_notifPermGranted) {
      console.warn('[Notification] Permission missing — requesting before schedule');
      const generation = _notificationGeneration;
      cordova.plugins.notification.local.requestPermission(granted => {
        if (generation !== _notificationGeneration || !alertsEnabled()) return;
        _notifPermGranted = granted;
        if (granted) scheduleNotification(opts);
        else UI.updateNativeBadges(true, false, _cordovaReady);
      });
      return;
    }

    const id = _notifIdCounter++;

    /*
     * The three alert channels are pre-created natively by the
     * vitaltrack-native plugin with the exact vibration patterns and
     * res/raw siren tones. On API 26+ Android ignores per-notification
     * vibration/sound, so the channel ID is all that matters here.
     */
    const payload = {
      id:          id,
      title:       opts.title,
      text:        opts.text,
      sound:       opts.sound || 'res://vt_urgent',
      trigger:     { at: Date.now() + 1000, type: 'calendar' },
      androidChannelId:          opts.channelId || 'vt_alerts_urgent_v4',
      androidChannelName:        'VitalTrack Health Alerts',
      androidChannelImportance:  4,     // IMPORTANCE_HIGH → heads-up banner
      androidChannelEnableVibration: true,
      androidChannelSoundUsage:  opts.soundUsage || 4,
      androidAllowWhileIdle:     true,
      androidWakeUpScreen:       true,
      androidLockscreen:         true,
      data:        Object.assign({ ts: Date.now() }, opts.data || {}),
    };

    cordova.plugins.notification.local.schedule(
      payload,
      () => console.log('[Notification] Scheduled id=' + id)
    );
  }

  function cancelAllNotifications() {
    _notificationGeneration++;
    if (!_notificationAvail) return;
    cordova.plugins.notification.local.cancelAll(
      () => console.log('[Notification] All cancelled')
    );
  }

  /* ──────────────────────────────────────────────────────────────
     PERMISSION BOOTSTRAP
  ────────────────────────────────────────────────────────────── */
  function _bootstrapNotificationPermissions(onDone) {
    if (!_notificationAvail) { onDone(false, false); return; }

    cordova.plugins.notification.local.requestPermission((granted) => {
      _notifPermGranted = granted;
      console.log('[Notification] POST_NOTIFICATIONS:', granted ? 'GRANTED' : 'DENIED');

      if (!granted) {
        if (!_notifPermWarned) {
          _notifPermWarned = true;
          UI.showInAppBanner(
            'watch',
            'Notifications blocked',
            'Enable notifications for VitalTrack in Settings → Apps → VitalTrack',
            12000
          );
        }
        onDone(false, false);
        return;
      }

      if (typeof cordova.plugins.notification.local.canScheduleExactAlarms === 'function') {
        cordova.plugins.notification.local.canScheduleExactAlarms((canSchedule) => {
          _exactAlarmOk = canSchedule;
          console.log('[Notification] SCHEDULE_EXACT_ALARM:', canSchedule ? 'OK' : 'DENIED (inexact fallback)');
          onDone(granted, canSchedule);
        });
      } else {
        onDone(granted, true);
      }
    });
  }

  /* ──────────────────────────────────────────────────────────────
     DEVICE INFO
  ────────────────────────────────────────────────────────────── */
  function getDeviceInfo() {
    if (_deviceAvail && typeof device !== 'undefined') {
      return {
        model:    device.model    || 'Unknown',
        platform: device.platform || 'Unknown',
        version:  device.version  || '—',
        uuid:     (device.uuid || '').substring(0, 8) + '…',
        cordova:  device.cordova  || (typeof cordova !== 'undefined' ? cordova.version : '—'),
      };
    }
    const ua = navigator.userAgent;
    return {
      model:    /Android/i.test(ua) ? 'Android Browser' : /iPhone|iPad/i.test(ua) ? 'iOS WebView' : 'Web Browser',
      platform: /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : 'Browser',
      version:  (ua.match(/Android (\d+\.\d+)/) || ['','—'])[1],
      uuid:     'browser-mode',
      cordova:  'N/A',
    };
  }

  /* ──────────────────────────────────────────────────────────────
     INIT
  ────────────────────────────────────────────────────────────── */
  function init(cordovaAvailable, onReady) {
    _cordovaReady = cordovaAvailable;
    _deviceAvail  = typeof device !== 'undefined';

    _notificationAvail = cordovaAvailable &&
                         typeof cordova              !== 'undefined' &&
                         typeof cordova.plugins      !== 'undefined' &&
                         typeof cordova.plugins.notification !== 'undefined' &&
                         typeof cordova.plugins.notification.local !== 'undefined';

    console.log('[Native.init]',
      'cordova=', cordovaAvailable,
      'notifications=', _notificationAvail,
      'device=', _deviceAvail
    );

    if (_notificationAvail) {
      _bootstrapNotificationPermissions((granted, exactOk) => {
        UI.updateNativeBadges(true, granted, cordovaAvailable);
        if (onReady) onReady({ granted, exactOk });
      });
    } else {
      UI.updateNativeBadges(true, false, cordovaAvailable);
      if (onReady) onReady({ granted: false, exactOk: false });
    }
  }

  return {
    init,
    vibrate,
    scheduleNotification,
    cancelAllNotifications,
    getDeviceInfo,
    get notifAvail()       { return _notificationAvail; },
    get notifPermGranted() { return _notifPermGranted; },
  };
})();


/* ════════════════════════════════════════════════════════════════
   §2  GLOBAL STATE
════════════════════════════════════════════════════════════════ */
const state = {
  hr: 72, spo2: 98, rr: 16, temp: 36.6,
  steps: 0, heartPts: 0, calories: 0, km: 0.0, moveMin: 0,
  weeklyPts: 0,
  stepGoal: 5000, hpGoal: 20,
  calGoal: 500, moveGoal: 30,
  goalAchieved: [false, false, false, false, false, false, false],
  telemetryRunning: false,
  mainIntervalId: null,
  activityIntervalId: null,
  audioCtx: null,
  alertLog: [],
  reports: [],
};

const DAYS = ['S','M','T','W','T','F','S'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_LONG = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const WEEKDAYS_LONG = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
let cycleElapsed = 0;
let vitalsTickN  = 0;


/* ════════════════════════════════════════════════════════════════
   §3  DOM HELPERS
════════════════════════════════════════════════════════════════ */
const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const alertsEnabled = () => $('notif-toggle')?.checked !== false;
const patientSyncActive = () => !!(window.PatientSync &&
  (window.PatientSync.isPaired || window.PatientSync.isConnecting));

const pad2 = n => String(n).padStart(2, '0');
const fmtClock = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const fmtDate = d => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;


/* ════════════════════════════════════════════════════════════════
   §4  UI MODULE
════════════════════════════════════════════════════════════════ */
const UI = (() => {

  let _phase = 'idle';

  function setSplashStatus(msg) {
    const el = $('splash-status');
    if (el) el.textContent = msg;
  }

  function hideSplash() {
    const splash = $('device-splash');
    const app    = $('app');
    const nav    = $('bottom-nav');
    if (splash) {
      splash.style.transition = 'opacity .5s';
      splash.style.opacity    = '0';
      setTimeout(() => { if (splash.parentNode) splash.remove(); }, 520);
    }
    if (app) app.style.display = '';
    if (nav) nav.style.display = '';
  }

  function updateNativeBadges(vibration, notifications, network) {
    function _set(id, active) {
      const el = $(id); if (!el) return;
      const dot = el.querySelector('.nb-dot');
      el.style.borderColor = active ? 'rgba(48,209,88,.45)' : 'rgba(56,56,58,1)';
      el.style.color       = active ? '#30D158' : 'rgba(235,235,245,.32)';
      if (dot) dot.style.background = active ? '#30D158' : 'rgba(235,235,245,.32)';
    }
    _set('nb-vibration',    vibration);
    _set('nb-notification', notifications);
    // Sync owns the network badge; native API availability is not connectivity.
  }

  function setDevicePill(label, connected) {
    const lbl  = $('device-label');
    const dot  = $('device-dot');
    const pill = $('device-pill');
    if (pill) pill.style.borderColor = connected ? 'rgba(48,209,88,.45)' : 'rgba(56,56,58,1)';
    if (lbl) {
      lbl.textContent = label || 'Native';
      lbl.style.color = connected ? '#30D158' : 'rgba(235,235,245,.60)';
    }
    if (dot) dot.style.background = connected ? '#30D158' : '#8E8E93';
  }

  function fillDeviceCard(info) {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('native-model',    info.model);
    set('native-platform', `Platform: ${info.platform}  ·  Cordova: ${info.cordova}`);
    set('native-version',  `OS: ${info.version}  ·  UUID: ${info.uuid}`);
  }

  function _applyDot() {
    const dot = $('pulse-dot'); if (!dot) return;
    dot.className = 'pulse-dot';
    if (!state.telemetryRunning && !window.PatientSync?.isConnected) return;
    if (_phase === 'watch' || _phase === 'review' || _phase === 'urgent') {
      dot.classList.add('alert-' + _phase);
    } else {
      dot.classList.add('active');
    }
  }

  function setPulseDotPhase(phase) {
    _phase = phase;
    _applyDot();
  }

  function setTelemetryStatus(status, timer, running) {
    const statusEl = $('telemetry-status');
    const timerEl  = $('telemetry-timer');
    const btn      = $('btn-tele-toggle');
    if (statusEl) statusEl.textContent = status;
    if (timerEl)  timerEl.textContent  = timer || '';
    if (btn) {
      btn.textContent = running ? 'Stop' : 'Start';
      btn.className   = 'pill-btn' + (running ? ' running' : '');
    }
    _applyDot();
  }

  function updateVitals(s, prev) {
    function _set(id, val, unit, trendId, pVal) {
      const el = $(id);
      if (el) {
        el.textContent = `${val == null ? '—' : val} `;
        const unitEl = document.createElement('span');
        unitEl.textContent = unit;
        el.appendChild(unitEl);
        const card = el.closest('.metric-tile');
        if (card) {
          card.classList.remove('vital-flash');
          void card.offsetWidth;
          card.classList.add('vital-flash');
        }
      }
      const tr = $(trendId);
      if (tr) tr.textContent = val > pVal ? '↑' : val < pVal ? '↓' : '↔';
    }
    _set('v-hr',   s.hr,   'BPM',    'trend-hr',   prev.hr);
    _set('v-spo2', s.spo2, '%',      'trend-spo2', prev.spo2);
    _set('v-rr',   s.rr,   'br/min', 'trend-rr',   prev.rr);
    _set('v-temp', s.temp, '°C',     'trend-temp', prev.temp);
  }

  function updateChartCurrents(s) {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('chart-hr-val',   s.hr ?? '—');
    set('chart-spo2-val', s.spo2 ?? '—');
    set('chart-rr-val',   s.rr ?? '—');
    set('chart-temp-val', s.temp ?? '—');
  }

  function updateChartStats(vital, min, avg, max) {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set(`${vital}-min`, min);
    set(`${vital}-avg`, avg);
    set(`${vital}-max`, max);
  }

  function updateHomeStats(s) {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('legend-move',     s.calories);
    set('legend-exercise', s.moveMin);
    set('legend-stand',    s.heartPts);
    set('tile-steps',      s.steps.toLocaleString());
    set('tile-km',         s.km.toFixed(1));
    set('tile-min',        s.moveMin);
    set('tile-weekly',     s.weeklyPts);
    set('val-steps',       s.steps.toLocaleString());
    set('val-hp',          s.heartPts);
    set('weekly-pts',      s.weeklyPts);
    function _bar(id, val, max) {
      const el = $(id);
      if (el) el.style.width = Math.min(100, (val/max)*100) + '%';
    }
    _bar('prog-steps',  s.steps,    s.stepGoal);
    _bar('prog-hp',     s.heartPts, s.hpGoal);
    _bar('prog-weekly', s.weeklyPts, 150);
    set('goals-count', s.goalAchieved.filter(Boolean).length);
  }

  function buildGoalsWeek(achieved) {
    const container = $('goals-week'); if (!container) return;
    const today = new Date().getDay();
    container.innerHTML = '';
    DAYS.forEach((d, i) => {
      const done = achieved[i], isToday = i === today;
      const wrap = document.createElement('div');
      wrap.className = 'day-ring' + (isToday ? ' today' : '');
      const C = 2 * Math.PI * 12;
      wrap.innerHTML = `
        <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
          <circle cx="15" cy="15" r="12" stroke="rgba(255,255,255,.12)" stroke-width="3" fill="none"/>
          <circle cx="15" cy="15" r="12"
            stroke="${done ? '#92E82A' : 'rgba(255,255,255,.12)'}" stroke-width="3"
            fill="${done ? 'rgba(146,232,42,.16)' : 'none'}"
            stroke-dasharray="${C}" stroke-dashoffset="${done ? 0 : C}"
            stroke-linecap="round" transform="rotate(-90 15 15)"/>
        </svg>
        <div class="day-label">${d}</div>`;
      container.appendChild(wrap);
    });
  }

  function setWeeklyRange() {
    const now = new Date();
    const mon = new Date(now); mon.setDate(now.getDate() - now.getDay() + 1);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const el = $('weekly-range');
    if (el) el.textContent = `${mon.getDate()} – ${sun.getDate()} ${MONTHS[sun.getMonth()]}`;
  }

  function setHeaderDate() {
    const now = new Date();
    const el = $('summary-eyebrow');
    if (el) el.textContent =
      `${WEEKDAYS_LONG[now.getDay()]}, ${MONTHS_LONG[now.getMonth()]} ${now.getDate()}`;
  }

  /* In-app overlay banners */
  const ICONS = {
    watch: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    review: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 3h9l4 4v14H6V3Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 11h6M9 15h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    urgent: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3 22 20H2L12 3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="17.2" r="1.1" fill="currentColor"/></svg>',
  };

  const _timers = {};
  const TAGS = { watch: 'Watch', review: 'Review', urgent: 'Emergency' };

  function showInAppBanner(type, title, msg, autoDismiss = 7000) {
    const container = $('notification-container'); if (!container) return;
    const old = container.querySelector(`.notif-banner.${type}`);
    if (old) old.remove();
    const banner = document.createElement('div');
    banner.className = `notif-banner ${type}`;
    banner.setAttribute('role', 'alert');
    banner.innerHTML = `
      <div class="notif-icon">${ICONS[type] || ICONS.watch}</div>
      <div class="notif-body">
        <div class="notif-headline">
          <span class="notif-title"></span>
          <span class="notif-tag">${TAGS[type] || 'Alert'}</span>
        </div>
        <div class="notif-msg"></div>
      </div>
      <button class="notif-close" aria-label="Dismiss">✕</button>
      ${autoDismiss > 0 ? '<div class="notif-progress"></div>' : ''}`;

    banner.querySelector('.notif-title').textContent = title;
    banner.querySelector('.notif-msg').textContent = msg;
    const bar = banner.querySelector('.notif-progress');
    if (bar) bar.style.animationDuration = autoDismiss + 'ms';

    banner.querySelector('.notif-close').addEventListener('click', () => _dismiss(banner, type));
    container.appendChild(banner);
    clearTimeout(_timers[type]);
    if (autoDismiss > 0) _timers[type] = setTimeout(() => _dismiss(banner, type), autoDismiss);
  }
  function _dismiss(banner, type) {
    if (!banner.parentNode) return;
    banner.style.cssText += ';opacity:0;transform:translateY(14px) scale(.985);transition:all .26s ease';
    setTimeout(() => banner.remove(), 270);
    clearTimeout(_timers[type]);
  }

  function addLogEntry(type, text) {
    state.alertLog.unshift({ type, text, at: Date.now() });
    if (state.alertLog.length > 200) state.alertLog.length = 200;

    const log = $('activity-log'); if (!log) return;
    const empty = log.querySelector('.log-empty'); if (empty) empty.remove();
    const colors = { watch: '#FFD60A', review: '#1EE4E1', urgent: '#FF453A' };
    const ts = fmtClock(new Date());
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `
      <div class="log-dot" style="background:${colors[type] || 'rgba(235,235,245,.32)'}"></div>
      <div class="log-time">${ts}</div>
      <div class="log-text"></div>`;
    entry.querySelector('.log-text').textContent = text;
    log.insertBefore(entry, log.firstChild);
    while (log.children.length > 50) log.removeChild(log.lastChild);
  }

  function setTab(name) {
    const btn = document.querySelector(`.nav-btn[data-tab="${name}"]`);
    if (!btn) return;
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'reports' && typeof Reports !== 'undefined') Reports.refresh();
  }

  function activeTab() {
    const p = document.querySelector('.tab-panel.active');
    return p ? p.id.replace('tab-', '') : '';
  }

  function initNav() {
    $$('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });
  }

  return {
    setSplashStatus, hideSplash,
    updateNativeBadges, setDevicePill, fillDeviceCard,
    setTelemetryStatus, setPulseDotPhase,
    updateVitals, updateChartCurrents, updateChartStats,
    updateHomeStats, buildGoalsWeek, setWeeklyRange, setHeaderDate,
    showInAppBanner, addLogEntry, setTab, activeTab, initNav,
  };
})();


/* ════════════════════════════════════════════════════════════════
   §5  WEB AUDIO ENGINE
════════════════════════════════════════════════════════════════ */
const Audio = (() => {
  let generation = 0;
  function later(fn, delay) {
    const current = generation;
    setTimeout(() => { if (current === generation && alertsEnabled()) fn(); }, delay);
  }
  function stop() {
    generation++;
    if (state.audioCtx) state.audioCtx.close().catch(() => {});
    state.audioCtx = null;
  }
  function _ctx() {
    if (!state.audioCtx) {
      try { state.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch(e) {}
    }
    if (state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume();
    return state.audioCtx;
  }
  function tone(freq, dur, type = 'sine', vol = 0.28) {
    if (!alertsEnabled()) return;
    const ctx = _ctx(); if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.type = type;
      g.gain.setValueAtTime(vol, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + dur);
    } catch(e) {}
  }
  const chime = () => { tone(880,0.2,'sine',0.25); later(()=>tone(1100,0.2,'sine',0.2),240); };
  const alert = () => { tone(660,0.15,'square',0.2); later(()=>tone(880,0.15,'square',0.2),190); later(()=>tone(660,0.15,'square',0.2),380); };
  /* Fallback alarm when native notifications are unavailable: 8 wailing
     sweeps over ~5 s, louder than the notification tones. */
  const alarm = () => {
    if (!alertsEnabled()) return;
    const ctx = _ctx(); if (!ctx) return;
    for (let i = 0; i < 8; i++) {
      later(() => {
        try {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.connect(g); g.connect(ctx.destination);
          osc.type = 'sawtooth';
          const t = ctx.currentTime;
          osc.frequency.setValueAtTime(680, t);
          osc.frequency.linearRampToValueAtTime(1320, t + 0.28);
          osc.frequency.linearRampToValueAtTime(680, t + 0.56);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.4, t + 0.03);
          g.gain.setValueAtTime(0.4, t + 0.5);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
          osc.start(t);
          osc.stop(t + 0.62);
        } catch (e) {}
      }, i * 620);
    }
  };
  const prime = () => _ctx();
  return { chime, alert, alarm, prime, stop };
})();


/* ════════════════════════════════════════════════════════════════
   §6  CHART.JS GRAPHS (dark)
════════════════════════════════════════════════════════════════ */
const Charts = (() => {
  const MAX = 20;
  const charts = {};
  const COLORS = { hr: '#FF375F', spo2: '#1EE4E1', rr: '#92E82A', temp: '#FFD60A' };

  function _cfg(color, fill, unit, yMin, yMax) {
    return {
      type: 'line',
      data: { labels: [], datasets: [{
        label: unit, data: [], borderColor: color,
        backgroundColor: fill, borderWidth: 2, fill: true, tension: 0.42,
        pointRadius: 0, pointHoverRadius: 4, pointBackgroundColor: color,
      }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 350 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: { label: ctx => `${ctx.parsed.y} ${unit}` },
            backgroundColor: '#2C2C2E',
            titleColor: '#FFFFFF',
            bodyColor: 'rgba(235,235,245,.60)',
            borderColor: '#3A3A3C',
            borderWidth: 1,
            displayColors: false,
            cornerRadius: 10,
            padding: 10,
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: 'rgba(235,235,245,.32)', font: { size: 9 }, maxTicksLimit: 5, maxRotation: 0 },
          },
          y: {
            min: yMin, max: yMax,
            grid: { color: 'rgba(255,255,255,.07)' },
            border: { display: false },
            ticks: { color: 'rgba(235,235,245,.32)', font: { size: 9 }, maxTicksLimit: 5 },
          },
        },
      },
    };
  }

  function init() {
    if (typeof Chart === 'undefined') {
      console.warn('[Charts] Chart.js not available');
      return;
    }
    const ctx = id => $(id)?.getContext('2d');
    charts.hr   = new Chart(ctx('chartHR'),   _cfg(COLORS.hr,   'rgba(255,55,95,.12)',  'BPM',   50,120));
    charts.spo2 = new Chart(ctx('chartSpO2'), _cfg(COLORS.spo2, 'rgba(30,228,225,.10)', '%',     90,101));
    charts.rr   = new Chart(ctx('chartRR'),   _cfg(COLORS.rr,   'rgba(146,232,42,.10)', 'br/min', 8, 30));
    charts.temp = new Chart(ctx('chartTemp'), _cfg(COLORS.temp, 'rgba(255,214,10,.10)', '°C',    35, 40));
  }

  function push(label, s) {
    if (!charts.hr) return;
    function _p(chart, val) {
      chart.data.labels.push(label);
      chart.data.datasets[0].data.push(val);
      if (chart.data.labels.length > MAX) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
      }
      chart.update('none');
    }
    _p(charts.hr, s.hr); _p(charts.spo2, s.spo2); _p(charts.rr, s.rr); _p(charts.temp, s.temp);
  }

  function stats(arr) {
    arr = (arr || []).filter(Number.isFinite);
    if (!arr.length) return { min: '—', avg: '—', max: '—' };
    return {
      min: Math.min(...arr),
      avg: +(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1),
      max: Math.max(...arr),
    };
  }

  function updateStats() {
    if (!charts.hr) return;
    ['hr','spo2','rr','temp'].forEach(k => {
      const s = stats(charts[k].data.datasets[0].data);
      UI.updateChartStats(k, s.min, s.avg, s.max);
    });
  }

  function summary() {
    const out = {};
    ['hr','spo2','rr','temp'].forEach(k => {
      out[k] = charts[k] ? stats(charts[k].data.datasets[0].data)
                         : { min: '—', avg: '—', max: '—' };
    });
    return out;
  }

  function seed() {
    const now = Date.now();
    const rnd = (lo, hi, dp) => {
      const v = Math.random()*(hi-lo)+lo;
      return dp ? +v.toFixed(dp) : Math.round(v);
    };
    for (let i = 10; i >= 1; i--) {
      const t = new Date(now - i * 3000);
      push(fmtClock(t), {
        hr: rnd(65,85), spo2: rnd(96,100), rr: rnd(13,19), temp: rnd(36.1,37.1,1),
      });
    }
    updateStats();
  }

  function clear() {
    Object.values(charts).forEach(chart => {
      chart.data.labels = [];
      chart.data.datasets[0].data = [];
      chart.update('none');
    });
    updateStats();
  }

  return { init, push, updateStats, seed, clear, summary, colors: COLORS };
})();


/* ════════════════════════════════════════════════════════════════
   §7  THREE-RING CANVAS
════════════════════════════════════════════════════════════════ */
const Ring = (() => {
  const SIZE = 200, C = SIZE / 2, START = -Math.PI / 2;
  const RINGS = [
    { key: 'move',     r: 84, lw: 16, color: '#FA114F', track: 'rgba(250,17,79,.22)'  },
    { key: 'exercise', r: 64, lw: 16, color: '#92E82A', track: 'rgba(146,232,42,.22)' },
    { key: 'stand',    r: 44, lw: 16, color: '#1EE4E1', track: 'rgba(30,228,225,.22)' },
  ];

  let ctx = null;
  let raf = null;
  const shown  = { move: 0, exercise: 0, stand: 0 };
  const target = { move: 0, exercise: 0, stand: 0 };
  const clamp = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

  function init() {
    const c = $('metricRing'); if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width  = SIZE * dpr;
    c.height = SIZE * dpr;
    ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, SIZE, SIZE);
    RINGS.forEach(ring => {
      ctx.beginPath();
      ctx.arc(C, C, ring.r, 0, Math.PI * 2);
      ctx.strokeStyle = ring.track;
      ctx.lineWidth = ring.lw;
      ctx.lineCap = 'butt';
      ctx.stroke();

      const v = clamp(shown[ring.key]);
      if (v > 0.001) {
        ctx.beginPath();
        ctx.arc(C, C, ring.r, START, START + Math.PI * 2 * v);
        ctx.strokeStyle = ring.color;
        ctx.lineWidth = ring.lw;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      const ang = START + Math.PI * 2 * v;
      ctx.beginPath();
      ctx.arc(C + ring.r * Math.cos(ang), C + ring.r * Math.sin(ang), ring.lw * 0.26, 0, Math.PI * 2);
      ctx.fillStyle = ring.color;
      ctx.fill();
    });
  }

  function update(s) {
    target.move     = clamp(s.calories / s.calGoal);
    target.exercise = clamp(s.moveMin  / s.moveGoal);
    target.stand    = clamp(s.heartPts / s.hpGoal);
    animate();
  }

  function animate() {
    if (!ctx) return;
    cancelAnimationFrame(raf);
    const from = { move: shown.move, exercise: shown.exercise, stand: shown.stand };
    const t0 = performance.now();
    const DUR = 900, STAGGER = 70;

    function step(now) {
      RINGS.forEach((ring, i) => {
        const p = Math.max(0, Math.min(1, (now - t0 - i * STAGGER) / DUR));
        const eased = 1 - Math.pow(1 - p, 3);
        shown[ring.key] = from[ring.key] + (target[ring.key] - from[ring.key]) * eased;
      });
      draw();
      if (now < t0 + DUR + STAGGER * RINGS.length) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
  }

  return { init, update };
})();


/* ════════════════════════════════════════════════════════════════
   §8  VITALS SIMULATION
════════════════════════════════════════════════════════════════ */
function walk(val, min, max, step, dp = 0) {
  const c = Math.min(max, Math.max(min, val + (Math.random()-0.5)*2*step));
  return dp ? +c.toFixed(dp) : Math.round(c);
}
function simulateVitals() {
  const prev = { hr:state.hr, spo2:state.spo2, rr:state.rr, temp:state.temp };
  state.hr   = walk(state.hr,   55,108,3);
  state.spo2 = walk(state.spo2, 94,100,1);
  state.rr   = walk(state.rr,   10,24,1);
  state.temp = walk(state.temp, 35.8,38.5,0.1,1);
  return prev;
}
function simulateActivity() {
  state.steps    += Math.round(Math.random()*18+7);
  state.heartPts += Math.random()>0.6?1:0;
  state.calories += Math.round(Math.random()*3+1);
  state.km        = +(state.steps*0.00075).toFixed(2);
  state.moveMin  += Math.random()>0.4?1:0;
  state.weeklyPts = state.heartPts;
  const today = new Date().getDay();
  if (state.steps>=state.stepGoal && state.heartPts>=state.hpGoal) state.goalAchieved[today]=true;
}


/* ════════════════════════════════════════════════════════════════
   §9  TELEMETRY STATE MACHINE (60-second cycle)
   T+20s watch · T+40s review · T+60s urgent → loop
════════════════════════════════════════════════════════════════ */

const PHASE_CONFIG = {
  watch: {
    type:     'watch',
    title:    'Watch Alert — Routine Check-in',
    textFn:   s => `HR ${s.hr} BPM · SpO₂ ${s.spo2}% · Temp ${s.temp}°C`,
    vibrate:  2000,                                            // 2 s single pulse
    channelId: 'vt_alerts_watch_v1',
    sound:    'res://vt_watch',
    soundUsage: 5,                                             // USAGE_NOTIFICATION
    fallbackSound: () => Audio.chime(),
    dismiss:  8000,
    hold:     2600,
  },
  review: {
    type:     'review',
    title:    'Review Notification',
    textFn:   s => `Resp. Rate ${s.rr} br/min · Please review vitals`,
    /* 5 pulses of 800 ms with 250 ms gaps = 5000 ms */
    vibrate:  [800, 250, 800, 250, 800, 250, 800, 250, 800],
    channelId: 'vt_alerts_review_v4',
    sound:    'res://vt_review',
    soundUsage: 5,
    fallbackSound: () => Audio.alert(),
    dismiss:  11000,
    hold:     5700,
  },
  urgent: {
    type:     'urgent',
    title:    'URGENT HEALTH ALERT',
    textFn:   s => `Immediate review! HR ${s.hr} BPM · SpO₂ ${s.spo2}%`,
    /* 5 heavy pulses of 1800 ms with 250 ms gaps = 10000 ms */
    vibrate:  [1800, 250, 1800, 250, 1800, 250, 1800, 250, 1800],
    channelId: 'vt_alerts_urgent_v4',
    sound:    'res://vt_urgent',
    soundUsage: 4,                                             // USAGE_ALARM → loud, bypasses silent
    fallbackSound: () => Audio.alarm(),
    dismiss:  20000,
    hold:     10300,
  },
};

let _lastPhase = -1;

function triggerPhase(phase, clinicalEvent) {
  const cfg = PHASE_CONFIG[phase]; if (!cfg) return;
  const title = clinicalEvent ? clinicalEvent.title : cfg.title;
  const text  = clinicalEvent ? clinicalEvent.text : cfg.textFn(state);

  // Muted alerts still appear in the banner/log, but never reach native APIs.
  if (alertsEnabled()) {
    Native.vibrate(cfg.vibrate);
    Native.scheduleNotification({
      title,
      text,
      channelId: cfg.channelId,
      sound: cfg.sound,
      soundUsage: cfg.soundUsage,
      data: { phase, hr: state.hr, spo2: state.spo2, ts: Date.now() },
    });
    if (!Native.notifAvail || !Native.notifPermGranted) cfg.fallbackSound();
  }

  UI.showInAppBanner(cfg.type, title, text, cfg.dismiss);

  /* 5. Alert log + report history */
  UI.addLogEntry(cfg.type, `${title} — ${text}`);

  UI.setPulseDotPhase(cfg.type);
  // Live connection status must remain owned by sync, including during outages.
  if (clinicalEvent || patientSyncActive()) return;
  const statusMap = {
    watch:  'Watch alert — routine check-in',
    review: 'Review alert — vitals need attention',
    urgent: 'URGENT — immediate review required',
  };
  UI.setTelemetryStatus(statusMap[phase], '', true);

  setTimeout(() => {
    if (!state.telemetryRunning) return;
    UI.setPulseDotPhase('running');
    UI.setTelemetryStatus('Session running', '', true);
  }, cfg.hold);

  console.log(`[Telemetry] "${phase}" fired at T+${cycleElapsed}s`);
}

const PHASE_AT = { watch: 20, review: 40, urgent: 60 };

function startTelemetry() {
  if (state.telemetryRunning || patientSyncActive()) return;
  // Explicit demo restart after disconnect; never mix demo samples with live ones.
  Object.assign(state, { hr: 72, spo2: 98, rr: 16, temp: 36.6 });
  Charts.clear();
  Audio.prime();
  state.telemetryRunning = true;
  cycleElapsed = 0; vitalsTickN = 0; _lastPhase = -1;
  UI.setPulseDotPhase('running');
  UI.setTelemetryStatus('Session running', 'Recording…', true);

  state.activityIntervalId = setInterval(() => {
    simulateActivity();
    Ring.update(state);
    UI.updateHomeStats(state);
    UI.buildGoalsWeek(state.goalAchieved);
    if (UI.activeTab() === 'reports') Reports.refresh();
    Reports.refreshStats();
  }, 2500);

  state.mainIntervalId = setInterval(() => {
    cycleElapsed++; vitalsTickN++;

    const cycleT = cycleElapsed % PHASE_AT.urgent || PHASE_AT.urgent;
    const nextT  = cycleT <= PHASE_AT.watch  ? PHASE_AT.watch  :
                   cycleT <= PHASE_AT.review ? PHASE_AT.review : PHASE_AT.urgent;
    const holdActive = _lastPhase !== 0;
    UI.setTelemetryStatus('Session running', holdActive ? `Next alert in ${nextT - cycleT}s` : '', true);

    if (vitalsTickN % 2 === 0) {
      const prev = simulateVitals();
      UI.updateVitals(state, prev);
      UI.updateChartCurrents(state);
      Charts.push(fmtClock(new Date()), state);
      Charts.updateStats();
    }

    const t = cycleElapsed % PHASE_AT.urgent;
    if      (t === PHASE_AT.watch  && _lastPhase < 1) { _lastPhase = 1; triggerPhase('watch'); }
    else if (t === PHASE_AT.review && _lastPhase < 2) { _lastPhase = 2; triggerPhase('review'); }
    else if (t === 0 && cycleElapsed > 0)             { _lastPhase = 0; triggerPhase('urgent'); }
  }, 1000);
}

function stopTelemetry() {
  if (!state.telemetryRunning) return;
  state.telemetryRunning = false;
  clearInterval(state.mainIntervalId);
  clearInterval(state.activityIntervalId);
  cycleElapsed = 0; vitalsTickN = 0; _lastPhase = -1;
  Native.cancelAllNotifications();
  UI.setTelemetryStatus('Session stopped', 'Start to record vitals', false);
  UI.setPulseDotPhase('idle');
}


/* ════════════════════════════════════════════════════════════════
   §10  REPORTS — PDF GENERATION + SHARING
════════════════════════════════════════════════════════════════ */
const Reports = (() => {

  const PATIENT = {
    name: 'Khaled',
    gender: 'Male',
    dob: '25 Jun 2006',
    dobDate: new Date(2006, 5, 25),
    email: 'khaled@vitaltrack.app',
    phone: '',
    height: null,
    weight: null,
  };

  /* Called by the profile editor whenever the user saves their details. */
  function setPatient(p) {
    if (!p) return;
    PATIENT.name   = p.name || PATIENT.name;
    PATIENT.gender = p.gender || '—';
    PATIENT.email  = p.email || '';
    PATIENT.phone  = p.phone || '';
    PATIENT.height = p.height || null;
    PATIENT.weight = p.weight || null;
    if (p.dobDate instanceof Date) {
      PATIENT.dobDate = p.dobDate;
      PATIENT.dob = p.dob || PATIENT.dob;
    }
  }

  const INK    = [17, 17, 19];
  const MUTED  = [110, 110, 115];
  const LINE   = [228, 228, 232];
  const PINK   = [250, 17, 79];
  const GREEN  = [70, 160, 30];

  function age() {
    const now = new Date();
    let a = now.getFullYear() - PATIENT.dobDate.getFullYear();
    const m = now.getMonth() - PATIENT.dobDate.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < PATIENT.dobDate.getDate())) a--;
    return a;
  }

  function stamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  }

  function reportId() {
    return 'VT-' + stamp().replace('_', '-');
  }

  function alertCounts() {
    return state.alertLog.reduce((acc, a) => {
      acc[a.type] = (acc[a.type] || 0) + 1;
      return acc;
    }, { watch: 0, review: 0, urgent: 0 });
  }

  /* ── PDF builder ───────────────────────────────────────────── */
  function buildDoc(id) {
    const jspdfNS = window.jspdf;
    if (!jspdfNS || !jspdfNS.jsPDF) throw new Error('PDF engine unavailable');
    const doc = new jspdfNS.jsPDF({ unit: 'pt', format: 'a4', compress: true });

    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const M = 46;
    const CW = W - M * 2;
    let y = 0;

    const stats = Charts.summary();
    const counts = alertCounts();
    const goalsDone = state.goalAchieved.filter(Boolean).length;
    const generated = new Date();

    function text(v) { return String(v); }

    function ensure(need) {
      if (y + need <= H - 58) return;
      doc.addPage();
      y = 52;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(INK[0], INK[1], INK[2]);
      doc.text('VitalTrack · Clinical Report', M, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
      doc.text(id, W - M, y, { align: 'right' });
      doc.setDrawColor(LINE[0], LINE[1], LINE[2]);
      doc.setLineWidth(0.75);
      doc.line(M, y + 8, W - M, y + 8);
      y += 26;
    }

    function heading(label) {
      ensure(30);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(PINK[0], PINK[1], PINK[2]);
      doc.text(label.toUpperCase(), M, y);
      y += 13;
    }

    /* Header */
    doc.setFillColor(0, 0, 0);
    doc.rect(0, 0, W, 108, 'F');

    doc.setLineWidth(5);
    doc.setDrawColor(250, 17, 79);  doc.circle(54, 54, 22, 'S');
    doc.setDrawColor(146, 232, 42); doc.circle(54, 54, 14, 'S');
    doc.setDrawColor(30, 228, 225); doc.circle(54, 54, 6, 'S');

    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(21);
    doc.text('VitalTrack', 88, 50);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(235, 235, 245);
    doc.text('Clinical Vitals & Activity Report', 88, 66);

    doc.setFontSize(8);
    doc.setTextColor(170, 170, 176);
    doc.text('REPORT', W - M, 38, { align: 'right' });
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(10);
    doc.text(id, W - M, 52, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(170, 170, 176);
    doc.text(`${fmtDate(generated)} · ${fmtClock(generated)}`, W - M, 66, { align: 'right' });

    y = 136;

    /* Patient */
    heading('Patient');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(INK[0], INK[1], INK[2]);
    doc.text(PATIENT.name, M, y);
    y += 15;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    const patientMeta = [
      PATIENT.gender,
      `Born ${PATIENT.dob}`,
      `Age ${age()}`,
      PATIENT.email,
      PATIENT.phone,
    ].filter(Boolean).join('  ·  ');
    doc.text(patientMeta, M, y);

    const bmi = PATIENT.height && PATIENT.weight
      ? (PATIENT.weight / ((PATIENT.height / 100) ** 2)).toFixed(1) : null;
    const bodyMeta = [
      PATIENT.height ? `Height ${PATIENT.height} cm` : '',
      PATIENT.weight ? `Weight ${PATIENT.weight} kg` : '',
      bmi ? `BMI ${bmi}` : '',
    ].filter(Boolean).join('  ·  ');
    if (bodyMeta) {
      y += 13;
      doc.text(bodyMeta, M, y);
    }
    y += 20;

    /* Vitals table */
    heading('Clinical vitals');
    table(
      ['Metric', 'Current', 'Min', 'Avg', 'Max', 'Reference'],
      [
        ['Heart rate',  `${state.hr} BPM`,       text(stats.hr.min),   text(stats.hr.avg),   text(stats.hr.max),   '60–100 BPM'],
        ['Blood oxygen',`${state.spo2} %`,       text(stats.spo2.min), text(stats.spo2.avg), text(stats.spo2.max), '95–100 %'],
        ['Respiration', `${state.rr} br/min`,    text(stats.rr.min),   text(stats.rr.avg),   text(stats.rr.max),   '12–20 br/min'],
        ['Temperature', `${state.temp} °C`,      text(stats.temp.min), text(stats.temp.avg), text(stats.temp.max), '36.1–37.5 °C'],
      ],
      [126, 92, 52, 52, 52, CW - 374]
    );

    /* Activity */
    heading('Activity summary');
    statBoxes([
      { label: 'Steps',    value: state.steps.toLocaleString() },
      { label: 'Distance', value: `${state.km.toFixed(1)} km` },
      { label: 'Calories', value: `${state.calories}` },
      { label: 'Active',   value: `${state.moveMin} min` },
    ]);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    doc.text(
      `Heart Points ${state.heartPts} of ${state.hpGoal}  ·  Weekly ${state.weeklyPts} of 150  ·  ${goalsDone} of 7 days achieved`,
      M, y
    );
    y += 22;

    /* 7-day goals */
    heading('7-day goals');
    drawGoalWeek(state.goalAchieved);
    y += 8;

    /* Alerts */
    heading('Alert history');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(INK[0], INK[1], INK[2]);
    doc.text(`Watch ${counts.watch}   ·   Review ${counts.review}   ·   Urgent ${counts.urgent}`, M, y);
    y += 16;

    const recent = state.alertLog.slice(0, 8);
    if (!recent.length) {
      doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
      doc.setFontSize(9);
      doc.text('No alerts recorded in this session.', M, y);
      y += 16;
    } else {
      recent.forEach(a => {
        const msg = String(a.text).replace(/\s+/g, ' ').trim();
        const lines = doc.splitTextToSize(msg, CW - 118);
        ensure(lines.length * 11 + 8);

        const col = a.type === 'urgent' ? [217, 48, 37]
                  : a.type === 'review' ? [0, 145, 142]
                  : [176, 128, 0];
        doc.setFillColor(col[0], col[1], col[2]);
        doc.circle(M + 3, y + 2.5, 2.6, 'F');

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
        doc.text(fmtClock(new Date(a.at)), M + 12, y + 5);

        doc.setFont('helvetica', 'bold');
        doc.setTextColor(INK[0], INK[1], INK[2]);
        doc.text(a.type.toUpperCase(), M + 60, y + 5);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(60, 60, 64);
        doc.text(lines, M + 118, y + 5);

        y += Math.max(15, lines.length * 11 + 4);
      });
    }

    y += 6;
    ensure(34);
    doc.setDrawColor(LINE[0], LINE[1], LINE[2]);
    doc.setLineWidth(0.75);
    doc.line(M, y, W - M, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    doc.text(
      doc.splitTextToSize(
        'Generated by VitalTrack from device telemetry. This report supports clinical review and does not replace medical judgement.',
        CW
      ),
      M, y
    );

    /* Footer on every page */
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setDrawColor(LINE[0], LINE[1], LINE[2]);
      doc.setLineWidth(0.75);
      doc.line(M, H - 44, W - M, H - 44);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(140, 140, 145);
      doc.text('VitalTrack · com.ishan.vitaltrack', M, H - 32);
      doc.text(`Page ${i} of ${pages}`, W - M, H - 32, { align: 'right' });
    }

    return doc;

    /* ── local helpers ── */
    function table(headers, rows, widths) {
      const total = widths.reduce((a, b) => a + b, 0);
      ensure(24 + rows.length * 20);

      doc.setFillColor(245, 245, 247);
      doc.rect(M, y - 11, total, 22, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);

      let x = M;
      headers.forEach((h, i) => {
        const isLeft = i === 0;
        doc.text(h.toUpperCase(), isLeft ? x + 6 : x + widths[i] - 6, y + 3,
                 { align: isLeft ? 'left' : 'right' });
        x += widths[i];
      });
      y += 22;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);

      rows.forEach(row => {
        let xx = M;
        row.forEach((cell, i) => {
          doc.setTextColor(INK[0], INK[1], INK[2]);
          const isLeft = i === 0 || i === row.length - 1;
          doc.text(String(cell), isLeft ? xx + 6 : xx + widths[i] - 6, y + 11,
                   { align: isLeft ? 'left' : 'right' });
          xx += widths[i];
        });
        doc.setDrawColor(LINE[0], LINE[1], LINE[2]);
        doc.setLineWidth(0.5);
        doc.line(M, y + 18, M + total, y + 18);
        y += 20;
      });

      y += 8;
    }

    function statBoxes(items) {
      ensure(72);
      const gap = 8;
      const w = (CW - gap * 3) / 4;
      const h = 56;

      items.forEach((it, i) => {
        const x = M + i * (w + gap);
        doc.setFillColor(245, 245, 247);
        doc.roundedRect(x, y, w, h, 8, 8, 'F');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.5);
        doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
        doc.text(it.label.toUpperCase(), x + 10, y + 17);

        doc.setFontSize(15);
        doc.setTextColor(INK[0], INK[1], INK[2]);
        doc.text(it.value, x + 10, y + 40);
      });

      y += h + 16;
    }

    function drawGoalWeek(achieved) {
      ensure(64);
      const step = (CW - 40) / 6;
      const cy = y + 14;
      const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

      labels.forEach((d, i) => {
        const cx = M + 20 + step * i;
        const done = achieved[i];

        if (done) {
          doc.setFillColor(PINK[0], PINK[1], PINK[2]);
          doc.circle(cx, cy, 11, 'F');
          doc.setTextColor(255, 255, 255);
        } else {
          doc.setDrawColor(LINE[0], LINE[1], LINE[2]);
          doc.setLineWidth(1);
          doc.circle(cx, cy, 11, 'S');
          doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
        }

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.text(d, cx, cy + 3, { align: 'center' });

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.5);
        doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
        doc.text(String(i + 1), cx, cy + 24, { align: 'center' });
      });

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
      doc.text(`${achieved.filter(Boolean).length} of 7 days achieved`, M, cy + 42);
      y = cy + 48;
    }
  }

  /* ── Generation / sharing ─────────────────────────────────── */
  function generate() {
    const id = reportId();
    const doc = buildDoc(id);
    const dataUri = doc.output('datauristring');
    const b64 = dataUri.split('base64,').pop() || '';
    const entry = {
      id,
      name: `VitalTrack_Report_${PATIENT.name}_${stamp()}.pdf`,
      at: Date.now(),
      size: Math.max(1, Math.round(b64.length * 0.75 / 1024)),
      dataUri,
    };
    state.reports.unshift(entry);
    if (state.reports.length > 10) state.reports.pop();
    renderHistory();
    return entry;
  }

  function sharePdf(entry) {
    const plugin = window.plugins && window.plugins.socialsharing;
    const message = `VitalTrack clinical report for ${PATIENT.name} · ${fmtDate(new Date(entry.at))}`;

    if (plugin && typeof plugin.shareWithOptions === 'function') {
      plugin.shareWithOptions({
        message,
        subject: `VitalTrack report — ${PATIENT.name}`,
        files: [entry.dataUri],
        chooserTitle: 'Share patient report',
      }, () => {
        console.log('[Reports] Shared', entry.name);
      }, err => {
        console.warn('[Reports] Native share failed:', err);
        fallbackShare(entry);
      });
      return;
    }
    fallbackShare(entry);
  }

  async function fallbackShare(entry) {
    try {
      const b64 = entry.dataUri.split('base64,').pop() || '';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const file = new File([blob], entry.name, { type: 'application/pdf' });

      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        await navigator.share({ files: [file], title: 'VitalTrack report' });
        return;
      }
    } catch (e) {
      console.warn('[Reports] Web Share unavailable:', e);
    }
    download(entry);
  }

  function download(entry) {
    try {
      const a = document.createElement('a');
      a.href = entry.dataUri;
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1200);
      UI.showInAppBanner('review', 'Report saved',
        `${entry.name} was sent to your downloads.`, 6000);
    } catch (e) {
      UI.showInAppBanner('urgent', 'Sharing unavailable',
        'No share target is available on this device.', 9000);
    }
  }

  function summaryText() {
    const bmi = PATIENT.height && PATIENT.weight
      ? (PATIENT.weight / ((PATIENT.height / 100) ** 2)).toFixed(1) : null;
    return [
      `VitalTrack · ${fmtDate(new Date())} ${fmtClock(new Date())}`,
      `Patient: ${PATIENT.name} (${PATIENT.gender}, born ${PATIENT.dob}${PATIENT.phone ? ', ' + PATIENT.phone : ''})`,
      PATIENT.height || PATIENT.weight
        ? `Body: ${[PATIENT.height ? `${PATIENT.height} cm` : '', PATIENT.weight ? `${PATIENT.weight} kg` : '', bmi ? `BMI ${bmi}` : ''].filter(Boolean).join(' · ')}`
        : '',
      '',
      `Heart rate: ${state.hr} BPM`,
      `Blood oxygen: ${state.spo2}%`,
      `Respiration: ${state.rr} br/min`,
      `Temperature: ${state.temp} °C`,
      '',
      `Steps: ${state.steps.toLocaleString()} / ${state.stepGoal.toLocaleString()}`,
      `Heart points: ${state.heartPts} / ${state.hpGoal}`,
      `Weekly heart points: ${state.weeklyPts} / 150`,
      `Alerts this session: ${state.alertLog.length}`,
    ].join('\n');
  }

  function shareSummary() {
    const text = summaryText();
    const plugin = window.plugins && window.plugins.socialsharing;

    if (plugin && typeof plugin.shareWithOptions === 'function') {
      plugin.shareWithOptions({
        message: text,
        subject: `VitalTrack summary — ${PATIENT.name}`,
        chooserTitle: 'Share patient summary',
      }, () => {}, () => {
        if (navigator.share) navigator.share({ title: 'VitalTrack summary', text }).catch(() => copySummary(text));
        else copySummary(text);
      });
      return;
    }
    if (navigator.share) {
      navigator.share({ title: 'VitalTrack summary', text }).catch(() => copySummary(text));
      return;
    }
    copySummary(text);
  }

  function copySummary(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => UI.showInAppBanner('review', 'Summary copied',
          'Paste it into any messaging or email app.', 6000))
        .catch(() => UI.showInAppBanner('watch', 'Sharing unavailable',
          'No share target is available on this device.', 8000));
    } else {
      UI.showInAppBanner('watch', 'Sharing unavailable',
        'No share target is available on this device.', 8000);
    }
  }

  /* ── UI sync ──────────────────────────────────────────────── */
  function refresh() {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };

    const now = new Date();
    set('report-sub', `Live data · updated ${fmtClock(now)} · PDF`);

    set('report-patient', `${PATIENT.name} · ${PATIENT.gender} · ${PATIENT.dob}`);
    set('report-vitals', `HR ${state.hr} · SpO₂ ${state.spo2}% · RR ${state.rr} · ${state.temp}°C`);
    set('report-activity',
      `${state.steps.toLocaleString()} steps · ${state.km.toFixed(1)} km · ${state.calories} kcal · ${state.moveMin} min`);
    set('report-goals', `${state.goalAchieved.filter(Boolean).length} of 7 achieved`);
    set('report-alerts', `${state.alertLog.length} recorded`);

    refreshStats();
  }

  function refreshStats() {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('report-stat-hr', state.hr);
    set('report-stat-spo2', state.spo2);
    set('report-stat-alerts', state.alertLog.length);
  }

  function renderHistory() {
    const box = $('report-history'); if (!box) return;

    if (!state.reports.length) {
      box.innerHTML = '<div class="empty-state">Reports you generate stay on this screen, ready to share again.</div>';
      return;
    }

    box.innerHTML = state.reports.map((r, i) => `
      <div class="report-row">
        <span class="report-row-ico">
          <svg viewBox="0 0 24 24" fill="none"><path d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
        </span>
        <span class="report-row-info">
          <span class="report-row-name">${r.id}</span>
          <span class="report-row-meta">${fmtDate(new Date(r.at))} · ${fmtClock(new Date(r.at))} · ${r.size} KB</span>
        </span>
        <button class="report-row-share" type="button" data-report-idx="${i}">Share</button>
      </div>`).join('');

    box.querySelectorAll('[data-report-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = state.reports[Number(btn.dataset.reportIdx)];
        if (entry) sharePdf(entry);
      });
    });
  }

  function init() {
    $('btn-share-report')?.addEventListener('click', () => {
      const btn = $('btn-share-report');
      btn.disabled = true;
      btn.textContent = 'Preparing PDF…';
      setTimeout(() => {
        try {
          const entry = generate();
          btn.disabled = false;
          btn.textContent = 'Share PDF report';
          refresh();
          sharePdf(entry);
        } catch (e) {
          console.error('[Reports]', e);
          btn.disabled = false;
          btn.textContent = 'Share PDF report';
          UI.showInAppBanner('urgent', 'Report failed',
            `The PDF could not be generated. ${e.message || ''}`.trim(), 10000);
        }
      }, 60);
    });

    $('btn-share-summary')?.addEventListener('click', shareSummary);

    refresh();
    renderHistory();
  }

  return { init, refresh, refreshStats, renderHistory, setPatient };
})();


/* ════════════════════════════════════════════════════════════════
   §11  PATIENT PROFILE — persisted personal details
════════════════════════════════════════════════════════════════ */
const Profile = (() => {
  const KEY = 'vitaltrack.profile.v1';
  const DEFAULT = {
    name: 'Khaled',
    email: 'khaled@vitaltrack.app',
    phone: '',
    gender: 'Male',
    dob: '2006-06-25',
    blood: '',
    height: '',
    weight: '',
  };

  let data = { ...DEFAULT };

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') data = { ...DEFAULT, ...saved };
    } catch (e) {
      console.warn('[Profile] could not read saved details:', e);
    }
  }

  function write() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); }
    catch (e) { console.warn('[Profile] could not persist details:', e); }
  }

  function dobParts(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!m) return null;
    return { y: +m[1], m: +m[2] - 1, d: +m[3] };
  }

  function dobLabel(value) {
    const p = dobParts(value);
    if (!p) return '—';
    return `${p.d} ${MONTHS[p.m]} ${p.y}`;
  }

  function age() {
    const p = dobParts(data.dob);
    if (!p) return null;
    const now = new Date();
    let a = now.getFullYear() - p.y;
    const md = now.getMonth() - p.m;
    if (md < 0 || (md === 0 && now.getDate() < p.d)) a--;
    return a;
  }

  function setText(id, v) { const el = $(id); if (el) el.textContent = v; }

  function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function bmi() {
    const h = num(data.height), w = num(data.weight);
    if (!h || !w) return null;
    return w / ((h / 100) ** 2);
  }

  function render() {
    setText('profile-avatar', (data.name.trim().charAt(0) || '?').toUpperCase());
    setText('profile-name', data.name || 'Patient');
    setText('profile-email', data.email || 'No email');
    setText('profile-gender', data.gender || '—');
    setText('profile-dob', dobLabel(data.dob));
    setText('profile-age', age() == null ? '—' : age());
    setText('profile-height', num(data.height) ? `${num(data.height)} cm` : '—');
    setText('profile-weight', num(data.weight) ? `${num(data.weight)} kg` : '—');
    const b = bmi();
    setText('profile-bmi', b == null ? '—' : b.toFixed(1));
    setText('profile-phone', data.phone || '—');
    setText('profile-blood', data.blood || '—');

    const parts = dobParts(data.dob);
    Reports.setPatient({
      name: data.name,
      gender: data.gender,
      email: data.email,
      phone: data.phone,
      dob: dobLabel(data.dob),
      dobDate: parts ? new Date(parts.y, parts.m, parts.d) : null,
      height: num(data.height),
      weight: num(data.weight),
    });
    Reports.refresh();
  }

  function fillForm() {
    $('pf-name').value = data.name;
    $('pf-email').value = data.email;
    $('pf-phone').value = data.phone;
    $('pf-gender').value = data.gender;
    $('pf-dob').value = data.dob;
    $('pf-blood').value = data.blood;
    $('pf-height').value = data.height;
    $('pf-weight').value = data.weight;
    $('pf-error').textContent = '';
  }

  function openSheet() {
    fillForm();
    const sheet = $('profile-sheet');
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeSheet() {
    const sheet = $('profile-sheet');
    sheet.hidden = true;
    document.body.style.overflow = '';
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  function save(ev) {
    ev.preventDefault();
    const name   = $('pf-name').value.trim();
    const email  = $('pf-email').value.trim();
    const phone  = $('pf-phone').value.trim();
    const dob    = $('pf-dob').value;
    const height = $('pf-height').value.trim();
    const weight = $('pf-weight').value.trim();
    const err    = $('pf-error');

    if (!name) { err.textContent = 'Please enter a name.'; $('pf-name').focus(); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      err.textContent = 'Please enter a valid email address.';
      $('pf-email').focus();
      return;
    }
    if (height && !(num(height) >= 40 && num(height) <= 260)) {
      err.textContent = 'Height should be between 40 and 260 cm.';
      $('pf-height').focus();
      return;
    }
    if (weight && !(num(weight) >= 2 && num(weight) <= 500)) {
      err.textContent = 'Weight should be between 2 and 500 kg.';
      $('pf-weight').focus();
      return;
    }
    const parts = dobParts(dob);
    if (!parts) { err.textContent = 'Please enter your date of birth.'; $('pf-dob').focus(); return; }
    const born = new Date(parts.y, parts.m, parts.d);
    if (born > new Date()) { err.textContent = 'Date of birth cannot be in the future.'; return; }

    data = {
      name,
      email,
      phone,
      gender: $('pf-gender').value,
      dob,
      blood: $('pf-blood').value,
      height: height ? String(num(height)) : '',
      weight: weight ? String(num(weight)) : '',
    };
    write();
    render();
    closeSheet();
    UI.showInAppBanner('review', 'Details saved',
      'Your personal details were updated on the profile and in reports.', 6000);
  }

  function init() {
    read();
    render();

    const sheet = $('profile-sheet');
    $('profile-edit-btn')?.addEventListener('click', openSheet);
    $('profile-cancel')?.addEventListener('click', closeSheet);
    $('profile-cancel-2')?.addEventListener('click', closeSheet);
    $('profile-form')?.addEventListener('submit', save);
    sheet?.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

    const dobInput = $('pf-dob');
    if (dobInput) dobInput.max = new Date().toISOString().slice(0, 10);
  }

  return { init, openSheet, closeSheet, age };
})();


/* ════════════════════════════════════════════════════════════════
   §11  BOOT SEQUENCE
════════════════════════════════════════════════════════════════ */
/*
 * Android runs edge to edge (AndroidEdgeToEdge=true), so the WebView spans
 * the full screen and the real status/navigation bar heights arrive from the
 * native bridge. Without this the tab bar sits under the gesture bar and the
 * header sits under the clock.
 */
function applyInsets() {
  if (typeof VitalTrackNative === 'undefined' || !VitalTrackNative.getInsets) return;
  VitalTrackNative.getInsets(
    insets => {
      if (!insets) return;
      const root = document.documentElement.style;
      if (typeof insets.top   === 'number') root.setProperty('--inset-top',    insets.top + 'px');
      if (typeof insets.bottom === 'number') root.setProperty('--inset-bottom', insets.bottom + 'px');
      console.log('[Insets]', insets);
    },
    err => console.warn('[Insets] failed:', err)
  );
}

function onDOMReady() {
  UI.setHeaderDate();
  UI.setWeeklyRange();
  UI.buildGoalsWeek(state.goalAchieved);
  UI.updateHomeStats(state);
  UI.initNav();

  Charts.init();
  Ring.init();
  if (!patientSyncActive()) Charts.seed();

  const noTrend = { hr:state.hr, spo2:state.spo2, rr:state.rr, temp:state.temp };
  UI.updateVitals(state, noTrend);
  UI.updateChartCurrents(state);

  $('btn-tele-toggle')?.addEventListener('click', () => {
    state.telemetryRunning ? stopTelemetry() : startTelemetry();
  });

  $('notif-toggle')?.addEventListener('change', e => {
    if (!e.target.checked) {
      Native.cancelAllNotifications();
      Native.vibrate(0);
      Audio.stop();
      UI.showInAppBanner('watch', 'Alerts muted',
        'Pending native notifications were cancelled.', 6000);
    } else if (typeof cordova !== 'undefined') {
      Native.init(true, ({ granted }) => {
        if (!granted) UI.showInAppBanner('watch', 'Notifications blocked',
          'Enable notifications for VitalTrack in system settings.', 10000);
      });
    }
  });

  $('test-watch')?.addEventListener('click',  () => triggerPhase('watch'));
  $('test-review')?.addEventListener('click', () => triggerPhase('review'));
  $('test-urgent')?.addEventListener('click', () => triggerPhase('urgent'));

  Reports.init();
  Profile.init();
  window.PatientSync?.init();

  UI.setSplashStatus('Waiting for device…');
}

function onDeviceReady() {
  console.log('[Boot] deviceready — Cordova', typeof cordova !== 'undefined' ? cordova.version : '?');
  UI.setSplashStatus('Loading native APIs…');

  const notifPlugin = typeof cordova !== 'undefined' &&
                      cordova.plugins && cordova.plugins.notification &&
                      cordova.plugins.notification.local;

  // Register tap handlers before permission bootstrap so they are never lost
  if (notifPlugin) {
    notifPlugin.on('click', () => {
      UI.setTab('health');
    });
    notifPlugin.on('trigger', n => console.log('[Notification] trigger id=' + n.id));
  }

  Native.init(true, ({ granted, exactOk }) => {
    console.log(`[Boot] Notifications: permission=${granted}, exactAlarm=${exactOk}`);
  });

  if (typeof VitalTrackNative !== 'undefined') {
    VitalTrackNative.applySystemBars();
    applyInsets();
    setTimeout(applyInsets, 600);
    setTimeout(applyInsets, 1800);
  }
  window.addEventListener('resize', applyInsets);
  window.addEventListener('orientationchange', () => setTimeout(applyInsets, 320));
  document.addEventListener('resume', () => setTimeout(applyInsets, 120));

  const info = Native.getDeviceInfo();
  UI.fillDeviceCard(info);
  UI.setDevicePill(info.platform, true);
  window.PatientSync?.ready();

  setTimeout(() => {
    UI.hideSplash();
    console.log('[Boot] App shell visible');
  }, 700);
}

function onBrowserFallback() {
  console.info('[Boot] No Cordova — browser mode');
  UI.setSplashStatus('Browser mode (native APIs unavailable)');
  Native.init(false, () => {});
  UI.setDevicePill('Browser', false);
  UI.fillDeviceCard(Native.getDeviceInfo());
  if (typeof cordova === 'undefined') window.PatientSync?.ready();
  setTimeout(() => UI.hideSplash(), 500);
}

/* ── Entry point ─────────────────────────────────────────────── */
let _nativeBooted = false;
let _domReady     = false;

/*
 * Register deviceready immediately. Registering it inside a DOMContentLoaded
 * handler can miss the event if Cordova fires it first, which silently leaves
 * the app in "browser mode" — no vibration, no notifications.
 */
document.addEventListener('deviceready', () => {
  _nativeBooted = true;
  if (_domReady) onDeviceReady();
}, false);

document.addEventListener('DOMContentLoaded', () => {
  _domReady = true;
  onDOMReady();
  if (typeof cordova === 'undefined') {
    onBrowserFallback();
    return;
  }
  if (_nativeBooted) { onDeviceReady(); return; }
  setTimeout(() => {
    if (_nativeBooted) return;
    if (!$('device-splash')) return;
    console.warn('[Boot] deviceready timeout — falling back');
    onBrowserFallback();
  }, 6000);
});
