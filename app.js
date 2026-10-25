'use strict';
/* CheckMMG — PWA (iOS / Android). Même logique métier que l'appli Android native.
 * Différence majeure : un navigateur ne peut pas envoyer de SMS tout seul. On ouvre
 * l'appli Messages avec le texte prérempli, l'utilisateur appuie sur « Envoyer »
 * puis confirme ici que c'est fait. */

const APP_VERSION = '0.3.1';
const KEY_PREFS = 'checkmmg.prefs';
const KEY_HIST = 'checkmmg.history';
const KEY_PENDING = 'checkmmg.pending';
const KEY_HINT = 'checkmmg.installHintHidden';

// Aucun numéro de téléphone n'est codé ici (sauf celui de l'administrateur, LIC_ADMIN_PHONE, aussi utilisé en mode test) :
// chaque bénévole saisit le destinataire des SMS et les numéros d'urgence dans la Configuration.
const PIN_SHA256 = '7768e375a15e957a64adf43f42e9c54666a035ab58596e198a4a497bb17d65e8';
const DEFAULT_MMGS = ['Lannion', 'Paimpol', 'St Brieuc', 'Loudéac', 'Carhaix', 'Guingamp', 'Lamballe'];

const DEFAULTS = {
  userName: '', mmgName: '', phone: '',
  multisites: false, mmgList: DEFAULT_MMGS, selectedMmg: '',
  testMode: false,
  astreinte: '', veille: '',
  lvStart: '19:45', lvEnd: '23:00',
  satStart: '14:00', satEnd: '22:00',
  sun1Start: '09:45', sun1End: '13:45',
  sun2Start: '13:45', sun2End: '22:00',
  vacOn: false, vacStart: '', vacEnd: '',
  workOff: [],      // périodes décochées dans « Jours travaillés » ex. "lun_mat" ; vide = tout coché
  privacyAt: 0,     // horodatage d'acceptation de la politique de confidentialité
};

const DAY_NAMES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const DAY_KEYS = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];

/* ---------- stockage ---------- */

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (_) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (_) { toast('Stockage du navigateur indisponible'); return false; }
}

let prefs = { ...DEFAULTS, ...lsGet(KEY_PREFS, {}) };
const savePrefs = () => lsSet(KEY_PREFS, prefs);
const loadHist = () => lsGet(KEY_HIST, []);
const saveHist = (a) => lsSet(KEY_HIST, a);

/* ---------- utilitaires ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');
const fmt = (h, m) => `${pad(h)}:${pad(m)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parse = (s) => {
  const p = String(s).split(':').map(Number);
  return p.length === 2 && !p.some(Number.isNaN) ? p : [8, 0];
};
const toMin = (hhmm) => { const [h, m] = parse(hhmm); return h * 60 + m; };
const gap = (a, b) => Math.abs(toMin(a) - toMin(b));
const dayIdx = (d = new Date()) => (d.getDay() + 6) % 7; // 0 = lundi
const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const isoToDisplay = (iso) => (iso && iso.split('-').length === 3 ? iso.split('-').reverse().join('/') : iso || '');
const fmtDateTime = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.navigator.standalone === true ||
  (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

/** Arrondi au quart d'heure : 0-7 → 0, 8-22 → 15, ... avec report sur l'heure suivante. */
function roundQuarter(h, m) {
  const r = Math.floor((m + 7) / 15) * 15;
  return r === 60 ? [(h + 1) % 24, 0] : [h, r];
}

/** Différence en heures (positif = retard), avec gestion du passage de minuit. */
function diffHours(official, actual) {
  let d = toMin(actual) - toMin(official);
  if (d > 720) d -= 1440; else if (d < -720) d += 1440;
  return d / 60;
}

function fmtOvertime(hours) {
  if (hours === 0) return "À l'heure";
  const sign = hours > 0 ? '+' : '-';
  const total = Math.round(Math.abs(hours) * 60);
  const h = Math.floor(total / 60), m = total % 60;
  if (h === 0) return `${sign}${m}m`;
  if (m === 0) return `${sign}${h}h`;
  return `${sign}${h}h${pad(m)}m`;
}

/* ---------- règles métier (identiques à PreferencesManager) ---------- */

/** Heure officielle "HH:MM". Dim/fériés : avant 13h → G1, sinon G2 (selon l'heure de référence). */
function officialTime(dIdx, isOpening, refHour) {
  if (dIdx <= 4) return prefs[isOpening ? 'lvStart' : 'lvEnd'];
  if (dIdx === 5) return prefs[isOpening ? 'satStart' : 'satEnd'];
  const slot = refHour >= 13 ? 'sun2' : 'sun1';
  return prefs[slot + (isOpening ? 'Start' : 'End')];
}
const suffix = () => (prefs.testMode ? ' Test' : '');
const effectivePhone = () => (prefs.testMode ? LIC_ADMIN_PHONE : prefs.phone);

/** Boutons d'appel d'urgence ; seuls les numéros renseignés dans la Configuration apparaissent. */
function callRow() {
  const b = [[prefs.astreinte, '📞 Astreinte MMG'], [prefs.veille, '📞 Veille Départ.']]
    .filter(([n]) => n).map(([n, l]) => `<a class="btn light" href="tel:${esc(n)}">${l}</a>`);
  return b.length ? `<div class="row" style="margin-top:6px">${b.join('')}</div>` : '';
}
const currentMmg = () => (prefs.multisites ? (prefs.selectedMmg || prefs.mmgName) : prefs.mmgName);
const isConfigured = () => !!(prefs.userName && prefs.mmgName && prefs.phone);
function vacationActive() {
  if (!prefs.vacOn || !prefs.vacStart || !prefs.vacEnd) return false;
  const t = todayIso();
  return t >= prefs.vacStart && t <= prefs.vacEnd;
}

/** Case cochée dans « Jours travaillés » (défaut : oui). Ne sert qu'aux rappels, jamais à bloquer un envoi. */
const isWorking = (dIdx, matin) => !prefs.workOff.includes(`${DAY_KEYS[dIdx]}_${matin ? 'mat' : 'pm'}`);

/** Vrai si l'ouverture du jour devrait déjà être enregistrée (équivalent du rappel Android, appli ouverte). */
function openingDue() {
  if (vacationActive()) return false;
  const now = new Date(), di = dayIdx(now), hour = now.getHours();
  if (!isWorking(di, hour < 13)) return false;
  if (todaysOpening()) return false;
  const nowMin = hour * 60 + now.getMinutes();
  const start = toMin(officialTime(di, true, hour)) - 2;
  const end = toMin(officialTime(di, false, hour));
  return nowMin >= start && (end < start || nowMin <= end);
}

/** Ouverture envoyée aujourd'hui (la plus récente), ou undefined. */
function todaysOpening() {
  const start = dayStart();
  return loadHist()
    .filter((e) => e.type === 'OPENING' && e.dt >= start && e.smsSent)
    .sort((a, b) => b.dt - a.dt)[0];
}

/* ---------- interface commune ---------- */

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

/** Boîte de dialogue. `body` doit déjà être échappé. Un bouton dont fn() renvoie false ne ferme pas. */
function modal(title, body, buttons) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
      <h2>${esc(title)}</h2><div class="dbody">${body}</div><div class="dbtns"></div></div>`;
  const close = () => overlay.remove();
  const box = $('.dbtns', overlay);
  buttons.forEach((b) => {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    if (b.cls) btn.className = b.cls;
    btn.addEventListener('click', () => { if (!b.fn || b.fn(overlay) !== false) close(); });
    box.appendChild(btn);
  });
  document.body.appendChild(overlay);
  return { close, el: overlay };
}

function timeOptions(selected) {
  let html = '';
  for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m += 15) {
    const v = fmt(h, m);
    html += `<option value="${v}"${v === selected ? ' selected' : ''}>${v}</option>`;
  }
  return html;
}

function topbar(title) {
  return `<div class="topbar"><a class="btn back" href="#/">‹ Retour</a><h1>${esc(title)}</h1></div>`;
}

function guard() {
  if (isConfigured()) return true;
  toast('Renseignez d’abord votre nom et votre MMG');
  location.hash = '#/config';
  return false;
}

/* ---------- envoi du SMS (via l'appli Messages) ---------- */

function smsUrl(phone, body) {
  // iOS attend « & » avant body, Android et les autres « ? »
  return `sms:${phone}${isIOS() ? '&' : '?'}body=${encodeURIComponent(body)}`;
}

/** Enregistre l'entrée (SMS non confirmé), ouvre Messages, puis demande la confirmation. */
function sendEntry(entry, onConfirmed) {
  const hist = loadHist();
  entry.id = (hist.reduce((mx, e) => Math.max(mx, e.id || 0), 0)) + 1;
  entry.smsSent = false;
  hist.push(entry);
  if (!saveHist(hist)) return;
  lsSet(KEY_PENDING, entry.id);
  pendingOnConfirmed = onConfirmed;
  askSmsConfirmation(entry);
  location.href = smsUrl(entry.phone, entry.smsContent);
}

let pendingOnConfirmed = null;

function askSmsConfirmation(entry) {
  modal('Envoyez le SMS',
    `Messages s’ouvre avec le texte prêt.\n1. Appuyez sur « Envoyer » dans Messages.\n2. Revenez dans CheckMMG.\n3. Appuyez sur « SMS envoyé ».\n\n<b>${esc(entry.smsContent)}</b>`,
    [
      { label: '✅ SMS envoyé', fn: () => confirmSent(entry.id) },
      { label: '🔁 Rouvrir Messages', cls: 'light', fn: () => { location.href = smsUrl(entry.phone, entry.smsContent); return false; } },
      { label: 'Annuler (non envoyé)', cls: 'ghost', fn: () => { localStorage.removeItem(KEY_PENDING); pendingOnConfirmed = null; location.hash = '#/'; route(); } },
    ]);
}

function confirmSent(id) {
  const hist = loadHist();
  const e = hist.find((x) => x.id === id);
  if (e) { e.smsSent = true; e.smsSentTime = Date.now(); saveHist(hist); }
  try { localStorage.removeItem(KEY_PENDING); } catch (_) { /* ignoré */ }
  const cb = pendingOnConfirmed;
  pendingOnConfirmed = null;
  if (cb) cb(e); else { toast('Enregistré'); location.hash = '#/'; route(); }
}

/** Au démarrage : un SMS préparé mais jamais confirmé (page fermée pendant l'envoi). */
function checkPending() {
  const id = lsGet(KEY_PENDING, null);
  if (id === null) return;
  const e = loadHist().find((x) => x.id === id);
  if (!e || e.smsSent) { try { localStorage.removeItem(KEY_PENDING); } catch (_) { /* ignoré */ } return; }
  askSmsConfirmation(e);
}

/* ---------- écran d'accueil ---------- */

const app = () => $('#app');

function home() {
  const start = dayStart();
  const sentToday = loadHist().filter((e) => e.dt >= start && e.smsSent);
  const openings = sentToday.filter((e) => e.type === 'OPENING').length;
  const closings = sentToday.filter((e) => e.type === 'CLOSING').length;
  const needClose = openings > 0 && closings === 0;
  const vac = vacationActive();
  const hint = isIOS() && !isStandalone() && !lsGet(KEY_HINT, false);

  app().innerHTML = `
    <h1>CheckMMG</h1>
    <p class="sub">Maison Médicale de Garde</p>
    ${hint ? `<div class="banner info">📲 Pour installer l’application : touchez <b>Partager</b> puis <b>Sur l’écran d’accueil</b>.
        <button class="small light" id="hideHint" style="margin-top:8px">J’ai compris</button></div>` : ''}
    ${prefs.testMode ? '<div class="banner test">⚙️ MODE TEST ACTIF — aucun SMS opérationnel</div>' : ''}
    ${vac ? `<a class="banner vac btn" style="display:block;min-height:0;text-align:left" href="#/config">🏖️ MODE VACANCES ACTIF jusqu’au ${esc(isoToDisplay(prefs.vacEnd))}</a>` : ''}
    ${!isConfigured() ? '<div class="banner warn">Configurez votre nom et votre MMG avant le premier envoi.</div>' : ''}
    ${(() => {
      const s = licState();
      if (s === 'WARNING') return `<a class="banner btn" style="display:block;min-height:0;text-align:left;background:#E65100" href="#/licence">⚠️ Licence expire dans ${licDaysRemaining()} jour(s) — Toucher pour renouveler</a>`;
      if (s === 'GRACE') return `<a class="banner btn" style="display:block;min-height:0;text-align:left;background:#B71C1C" href="#/licence">🚨 Licence expirée — période de grâce : ${7 + licDaysRemaining()} jour(s) — Toucher pour renouveler</a>`;
      return '';
    })()}
    ${openingDue() ?'<div class="banner warn">🔔 Rappel : l’ouverture de la MMG n’a pas encore été enregistrée.</div>' : ''}
    <a class="btn big${vac ? '' : ''}" href="#/open" ${vac ? 'aria-disabled="true" style="opacity:.45;pointer-events:none"' : ''}>🔓 Ouverture</a>
    <a class="btn big orange" href="#/close" ${vac ? 'aria-disabled="true" style="opacity:.45;pointer-events:none"' : ''}>🔒 Fermeture${needClose ? '<span class="badge">!</span>' : ''}</a>
    ${needClose ? '<div class="banner warn">⚠️ Ouverture en cours — pensez à enregistrer la fermeture</div>' : ''}
    <a class="btn light" href="#/history">📋 Historique</a>
    <a class="btn light" href="#/config">⚙️ Configuration</a>
    ${callRow()}
    <p class="hint" style="text-align:center;margin-top:18px">CheckMMG PWA v${APP_VERSION} · HAWKUS CORP.<br><a href="#/privacy" style="color:inherit">Politique de confidentialité</a></p>`;
  const h = $('#hideHint');
  if (h) h.addEventListener('click', () => { lsSet(KEY_HINT, true); home(); });
}

/* ---------- ouverture ---------- */

function openingScreen() {
  if (!guard()) return;
  const now = new Date(), di = dayIdx(now);
  const ch = now.getHours(), cm = now.getMinutes();
  const off0 = officialTime(di, true, ch);
  const start = gap(fmt(ch, cm), off0) > 15 ? fmt(...roundQuarter(ch, cm)) : off0;
  const mmgOptions = prefs.mmgList.map((m) => `<option${m === currentMmg() ? ' selected' : ''}>${esc(m)}</option>`).join('');

  app().innerHTML = `${topbar('Ouverture')}
    <div class="card">
      ${prefs.multisites ? `<label for="mmg">MMG</label><select id="mmg">${mmgOptions}</select>` : `<div><b>MMG :</b> ${esc(prefs.mmgName)}</div>`}
      <label>Heure d’ouverture</label>
      <div class="time-big" id="timeBig"></div>
      <div class="row">
        <button class="light" data-t="08:45">08:45</button>
        <button class="light" data-t="13:45">13:45</button>
        <button class="light" data-t="19:45">19:45</button>
      </div>
      <label for="time">Autre heure</label>
      <select id="time">${timeOptions(start)}</select>
      <div class="hint">Heure officielle : <b id="offTime"></b></div>
    </div>
    <div id="late" class="hidden">
      <div class="banner warn">⚠️ Écart de plus de 15 min avec l’heure officielle : indiquez le motif.</div>
      <div class="card"><label for="notes">Motif (obligatoire)</label><textarea id="notes"></textarea></div>
    </div>
    <button id="send">📤 Envoyer le SMS d’ouverture</button>
    <button class="ghost" id="cancel">Annuler</button>`;

  let official = off0;
  const update = () => {
    const t = $('#time').value;
    official = officialTime(di, true, parse(t)[0]);
    $('#timeBig').textContent = t;
    $('#offTime').textContent = official;
    $('#late').classList.toggle('hidden', gap(t, official) <= 15);
  };
  $('#time').addEventListener('change', update);
  document.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { $('#time').value = b.dataset.t; update(); }));
  $('#cancel').addEventListener('click', () => { location.hash = '#/'; });
  update();

  $('#send').addEventListener('click', () => {
    const actual = $('#time').value;
    const late = gap(actual, official) > 15;
    const notes = ($('#notes').value || '').trim();
    if (late && !notes) { toast('Veuillez saisir un motif (écart > 15 min)'); return; }
    if (prefs.multisites) { prefs.selectedMmg = $('#mmg').value; savePrefs(); }
    const mmg = currentMmg() + suffix(), user = prefs.userName + suffix();
    const sms = `Mmg ${mmg} - Ouverture par ${user} - Heure: ${actual}` + (notes ? ` - Notes: ${notes}` : '');
    sendEntry({
      type: 'OPENING', dt: Date.now(), mmg, user, official, actual,
      overtime: diffHours(official, actual), obs: notes || '', smsContent: sms, phone: effectivePhone(),
    }, () => { toast('Ouverture enregistrée !'); location.hash = '#/'; route(); });
  });
}

/* ---------- fermeture ---------- */

function closingScreen() {
  if (!guard()) return;
  const now = new Date(), di = dayIdx(now);
  const ch = now.getHours(), cm = now.getMinutes();
  const op = todaysOpening();
  const refHour = () => (op ? parse(op.actual)[0] : null);
  const offFor = (hour) => officialTime(di, false, refHour() ?? hour);
  const off0 = offFor(ch);
  const start = gap(fmt(ch, cm), off0) > 15 ? fmt(...roundQuarter(ch, cm)) : off0;

  app().innerHTML = `${topbar('Fermeture')}
    <div class="card">
      <div><b>MMG :</b> ${esc(currentMmg())}</div>
      <label>Heure de fermeture</label>
      <div class="time-big" id="timeBig"></div>
      <div class="row">
        <button class="light" data-t="13:45">13:45</button>
        <button class="light" data-t="22:15">22:15</button>
        <button class="light" data-t="23:15">23:15</button>
      </div>
      <label for="time">Autre heure</label>
      <select id="time">${timeOptions(start)}</select>
      <div class="hint">Heure officielle : <b id="offTime"></b></div>
    </div>
    <div class="card">
      <label for="total">Nombre total de patients</label>
      <input id="total" type="number" inputmode="numeric" min="0">
      <label for="seen">Patients vus</label>
      <input id="seen" type="number" inputmode="numeric" min="0">
      <label for="obs">Observations</label>
      <textarea id="obs" placeholder="R.a.S."></textarea>
      <div id="late" class="banner warn hidden" style="margin-top:10px">⚠️ Écart de plus de 15 min avec l’heure officielle : observations obligatoires (pas « R.a.S. »).</div>
    </div>
    <button class="orange" id="send">📤 Envoyer le SMS de fermeture</button>
    <button class="ghost" id="cancel">Annuler</button>`;

  let official = off0;
  const update = () => {
    const t = $('#time').value;
    official = offFor(parse(t)[0]);
    $('#timeBig').textContent = t;
    $('#offTime').textContent = official;
    $('#late').classList.toggle('hidden', gap(t, official) <= 15);
  };
  $('#time').addEventListener('change', update);
  document.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { $('#time').value = b.dataset.t; update(); }));
  $('#cancel').addEventListener('click', () => { location.hash = '#/'; });

  // « Patients vus » suit le total tant que l'utilisateur n'y a pas touché
  let seenEdited = false;
  $('#seen').addEventListener('input', () => { seenEdited = true; });
  $('#total').addEventListener('input', () => { if (!seenEdited) $('#seen').value = $('#total').value; });
  update();

  $('#send').addEventListener('click', () => {
    const actual = $('#time').value;
    const late = gap(actual, official) > 15;
    let obs = ($('#obs').value || '').trim();
    if (late && (!obs || obs === 'R.a.S.')) { toast('Motif requis (écart > 15 min)'); $('#obs').focus(); return; }
    const totalStr = $('#total').value, seenStr = $('#seen').value;
    if (totalStr === '' || seenStr === '') { toast('Remplir tous les champs'); return; }
    const total = parseInt(totalStr, 10), seen = parseInt(seenStr, 10);
    if (!obs) obs = 'R.a.S.';
    const mmg = currentMmg() + suffix(), user = prefs.userName + suffix();
    const sms = `Mmg ${mmg} - Fermeture par ${user} - Heure: ${actual} - Patients: ${seen} - Notes: ${obs}`;
    const entry = {
      type: 'CLOSING', dt: Date.now(), mmg, user, official, actual,
      overtime: diffHours(official, actual), total, seen, obs, smsContent: sms, phone: effectivePhone(),
    };
    sendEntry(entry, () => showSummary(entry, op));
  });
}

function showSummary(c, op) {
  let msg = `MMG : ${c.mmg}\nMédecin : ${c.user}\n\n`;
  if (op) {
    let tot = toMin(c.actual) - toMin(op.actual);
    if (tot < 0) tot += 1440;
    msg += `Ouverture : ${op.official} → ${op.actual}  (${fmtOvertime(op.overtime)})\n`;
    msg += `Fermeture : ${c.official} → ${c.actual}  (${fmtOvertime(c.overtime)})\n`;
    msg += `Durée totale : ${Math.floor(tot / 60)}h${pad(tot % 60)}\n\n`;
  }
  msg += `Patients : ${c.seen} vus / ${c.total} total`;
  modal('Résumé de la journée', esc(msg), [{ label: 'OK', fn: () => { location.hash = '#/'; route(); } }]);
}

/* ---------- historique ---------- */

const typeLabel = (t) => (t === 'OPENING' ? '📤 Ouverture' : t === 'CLOSING' ? '🔐 Fermeture'
  : t === 'PRIVACY_ACCEPTED' ? '🔒 Politique de confidentialité' : t);
const csvType = (t) => (t === 'OPENING' ? 'Ouverture' : t === 'CLOSING' ? 'Fermeture'
  : t === 'PRIVACY_ACCEPTED' ? 'Politique acceptée' : t);

function historyScreen() {
  const list = loadHist().sort((a, b) => b.dt - a.dt);
  const cards = list.map((e) => e.type === 'PRIVACY_ACCEPTED' ? `
    <div class="card entry">
      <div class="t">${typeLabel(e.type)} <span class="m">· ${esc(fmtDateTime(e.dt))}</span></div>
      <div class="m">Acceptée · ${esc(e.user)}</div>
    </div>` : `
    <div class="card entry ${esc(e.type)}">
      <div class="t">${typeLabel(e.type)} <span class="m">· ${esc(fmtDateTime(e.dt))}</span></div>
      <div class="m">MMG : ${esc(e.mmg)} · ${esc(e.user)}</div>
      <div>Officielle ${esc(e.official)} → réelle ${esc(e.actual)} (${esc(fmtOvertime(e.overtime))})</div>
      ${e.type === 'CLOSING' ? `<div>Patients : ${esc(e.seen)} vus / ${esc(e.total)} total</div>` : ''}
      ${e.obs ? `<div class="m">Notes : ${esc(e.obs)}</div>` : ''}
      <div class="${e.smsSent ? 'ok' : 'ko'}">${e.smsSent ? '✓ SMS envoyé' : '✗ SMS non confirmé'}</div>
      <div class="sms">${esc(e.smsContent)}</div>
    </div>`).join('');

  app().innerHTML = `${topbar('Historique')}
    <div class="banner info">Cet historique est enregistré dans ce téléphone uniquement. Exportez-le régulièrement.</div>
    ${list.length ? `<div class="row" style="margin-bottom:12px">
        <button class="light" id="csv">⬇️ CSV</button>
        <button class="light" id="pdf">⬇️ PDF</button>
        <button class="ghost" id="clear">🗑️ Effacer</button></div>${cards}`
      : '<div class="card">Aucun envoi enregistré.</div>'}`;
  const csvBtn = $('#csv'), clr = $('#clear');
  if (csvBtn) csvBtn.addEventListener('click', () => exportCsv(list));
  if ($('#pdf')) $('#pdf').addEventListener('click', () => exportPdf(list));
  if (clr) clr.addEventListener('click', () => modal('Effacer l’historique ?', 'Toutes les entrées seront supprimées de ce téléphone.', [
    { label: 'Effacer', cls: 'danger', fn: () => { saveHist([]); historyScreen(); } },
    { label: 'Annuler', cls: 'ghost' },
  ]));
}

function exportCsv(list) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Type', 'MMG', 'Utilisateur', 'H.Officielle', 'H.Réelle', 'Heures Supp', 'Total Patients', 'Patients Vus', 'Observations', 'SMS Envoyé']];
  list.forEach((e) => rows.push([
    fmtDateTime(e.dt), csvType(e.type), e.mmg, e.user, e.official, e.actual,
    fmtOvertime(e.overtime), e.type === 'CLOSING' ? e.total : '', e.type === 'CLOSING' ? e.seen : '', e.obs, e.smsSent ? 'Oui' : 'Non',
  ]));
  const text = '﻿' + rows.map((r) => r.map(q).join(';')).join('\r\n');
  shareOrDownload(new File([text], 'historique_checkmmg.csv', { type: 'text/csv' }), 'Historique CheckMMG');
}

/* Export PDF sans bibliothèque : A4 paysage, mêmes colonnes que l'appli Android. */

const WIN_ANSI = { '’': 146, '‘': 145, '–': 150, '—': 151, '…': 133, 'œ': 156, 'Œ': 140, '€': 128 };

/** Texte → chaîne littérale PDF (ASCII + échappements octaux WinAnsi). */
function pdfText(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    let c = ch.charCodeAt(0);
    if (WIN_ANSI[ch]) c = WIN_ANSI[ch];
    else if (c > 255 || c < 32) c = 63; // '?'
    if (c === 40 || c === 41 || c === 92) out += '\\' + ch;
    else if (c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return `(${out})`;
}

function buildPdf(list) {
  const W = 842, H = 595, M = 24, HDR = 20, ROW = 18, TITLE = 30;
  const rowsPer = Math.floor((H - M * 2 - TITLE - HDR) / ROW);
  const colX = [0, 90, 175, 250, 315, 370, 430, 510, 560, 610, 730].map((x) => M + x);
  const colW = [90, 85, 75, 65, 55, 60, 80, 50, 50, 120, 80];
  const heads = ['Date/Heure', 'Type', 'MMG', 'Utilisateur', 'H.Off.', 'H.Réelle', 'Heures Supp', 'T.Pax', 'Pax Vus', 'Observations', 'SMS'];
  const clip = (s, w, size) => {
    s = String(s ?? '');
    const max = Math.floor((w - 4) / (size * 0.52));
    return s.length > max ? s.slice(0, Math.max(0, max - 2)) + '..' : s;
  };
  const f = (n) => (Math.round(n * 100) / 100).toString();
  const text = (font, size, x, topY, s) => `BT /${font} ${size} Tf ${f(x)} ${f(H - topY)} Td ${pdfText(s)} Tj ET\n`;
  const rect = (x, topY, w, h) => `${f(x)} ${f(H - topY - h)} ${f(w)} ${f(h)} re f\n`;

  const pages = Math.max(1, Math.ceil(list.length / rowsPer));
  const streams = [];
  for (let p = 0; p < pages; p++) {
    let c = '0 g\n' + text('F2', 16, M, M + 16, `Historique CheckMMG  —  ${fmtDateTime(Date.now()).slice(0, 10)}  (page ${p + 1}/${pages})`);
    const hy = M + TITLE;
    c += '0.129 0.588 0.953 rg\n' + rect(M, hy, W - 2 * M, HDR) + '1 g\n';
    heads.forEach((h, i) => { c += text('F2', 9, colX[i] + 2, hy + 14, clip(h, colW[i], 9)); });
    list.slice(p * rowsPer, (p + 1) * rowsPer).forEach((e, i) => {
      const ry = hy + HDR + i * ROW;
      if (i % 2 === 1) c += '0.941 0.973 1 rg\n' + rect(M, ry, W - 2 * M, ROW);
      c += `0.8 G 0.5 w ${M} ${f(H - ry - ROW)} m ${W - M} ${f(H - ry - ROW)} l S\n0 g\n`;
      const ty = ry + ROW - 5, closing = e.type === 'CLOSING';
      const cells = [fmtDateTime(e.dt), csvType(e.type), e.mmg, e.user, e.official, e.actual, fmtOvertime(e.overtime),
        closing ? e.total : '', closing ? e.seen : '', closing ? e.obs : '', e.type === 'PRIVACY_ACCEPTED' ? '' : (e.smsSent ? 'Oui' : 'Non')];
      cells.forEach((v, k) => { if (v !== '' && v != null) c += text('F1', 8, colX[k] + 2, ty, clip(v, colW[k], 8)); });
    });
    streams.push(c);
  }

  // objets : 1 catalogue, 2 pages, 3 Helvetica, 4 Helvetica-Bold, puis (page, contenu) par page
  let pdf = '%PDF-1.4\n';
  const off = [];
  const obj = (n, body) => { off[n] = pdf.length; pdf += `${n} 0 obj\n${body}\nendobj\n`; };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${streams.map((_, i) => `${5 + 2 * i} 0 R`).join(' ')}] /Count ${pages} >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  streams.forEach((s, i) => {
    obj(5 + 2 * i, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`);
    obj(6 + 2 * i, `<< /Length ${s.length} >>\nstream\n${s}endstream`);
  });
  const n = 5 + 2 * pages;
  const xref = pdf.length;
  pdf += `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let i = 1; i < n; i++) pdf += `${String(off[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Uint8Array.from(pdf, (ch) => ch.charCodeAt(0));
}

function exportPdf(list) {
  if (!list.length) { toast('Aucune donnée à exporter'); return; }
  const rows = [...list].sort((a, b) => b.dt - a.dt);
  shareOrDownload(new File([buildPdf(rows)], 'historique_checkmmg.pdf', { type: 'application/pdf' }), 'Historique CheckMMG');
}

/** Feuille de partage du téléphone si disponible (iOS/Android), sinon téléchargement classique. */
function shareOrDownload(file, title) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title }).catch(() => { /* annulé */ });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- configuration ---------- */

const SCHEDULE_ROWS = [
  ['Lun–Ven', 'lvStart', 'lvEnd'], ['Samedi', 'satStart', 'satEnd'],
  ['Dim/Fériés G1', 'sun1Start', 'sun1End'], ['Dim/Fériés G2', 'sun2Start', 'sun2End'],
];

async function sha256Hex(text) {
  if (!(window.crypto && crypto.subtle)) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Demande le code PIN administrateur ; résout true si correct. */
function askPin() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    modal('Mode test', 'Saisissez le code PIN administrateur.<input id="pin" type="password" inputmode="numeric" autocomplete="off" style="margin-top:10px">', [
      {
        label: 'Valider',
        fn: (ov) => {
          const val = $('#pin', ov).value;
          sha256Hex(val).then((h) => {
            if (h === null) { toast('Navigateur non compatible (HTTPS requis)'); finish(false); }
            else if (h === PIN_SHA256) finish(true);
            else { toast('Code incorrect'); finish(false); }
          });
          return true;
        },
      },
      { label: 'Annuler', cls: 'ghost', fn: () => finish(false) },
    ]);
  });
}

function collectConfig() {
  const v = (id) => ($('#' + id) ? $('#' + id).value.trim() : null);
  const set = (key, id) => { const x = v(id); if (x !== null) prefs[key] = x; };
  set('userName', 'userName'); set('mmgName', 'mmgName'); set('phone', 'phone');
  set('astreinte', 'astreinte'); set('veille', 'veille');
  SCHEDULE_ROWS.forEach(([, a, b]) => { set(a, a); set(b, b); });
  if ($('#multisites')) prefs.multisites = $('#multisites').checked;
  if ($('#vacOn')) {
    prefs.vacOn = $('#vacOn').checked;
    set('vacStart', 'vacStart'); set('vacEnd', 'vacEnd');
  }
}

function configScreen() {
  const sched = SCHEDULE_ROWS.map(([label, a, b]) => `<tr><td>${label}</td>
      <td><select id="${a}">${timeOptions(prefs[a])}</select></td>
      <td><select id="${b}">${timeOptions(prefs[b])}</select></td></tr>`).join('');
  const chips = prefs.mmgList.map((m, i) => `<span class="chip">${esc(m)}<button data-del="${i}" aria-label="Supprimer ${esc(m)}">×</button></span>`).join('');

  app().innerHTML = `${topbar('Configuration')}
    ${prefs.testMode ? '<div class="banner test">⚙️ MODE TEST ACTIF</div>' : ''}
    <div class="card"><h2>Identité</h2>
      <label for="userName">Votre nom</label><input id="userName" value="${esc(prefs.userName)}" autocomplete="name">
      <label for="mmgName">Nom de la MMG</label><input id="mmgName" value="${esc(prefs.mmgName)}">
      <label for="phone">Numéro de destination des SMS</label><input id="phone" type="tel" inputmode="tel" placeholder="ex. +33612345678" value="${esc(prefs.phone)}">
      <div class="hint">Numéro qui reçoit les SMS d’ouverture et de fermeture. En mode test, les SMS partent vers le numéro de test.</div>
    </div>
    <div class="card"><h2>Mode multisites</h2>
      <div class="check"><input id="multisites" type="checkbox"${prefs.multisites ? ' checked' : ''}><label for="multisites">Plusieurs MMG</label></div>
      <div id="mmgBox" class="${prefs.multisites ? '' : 'hidden'}">
        <div class="chips">${chips}</div>
        <div class="row"><input id="newMmg" placeholder="Nouvelle MMG"><button class="light small" id="addMmg" style="flex:none">Ajouter</button></div>
      </div>
    </div>
    <div class="card"><h2>Horaires officiels</h2>
      <table class="sched"><tr><th></th><th>Début</th><th>Fin</th></tr>${sched}</table>
    </div>
    <div class="card"><h2>🏖️ Mode vacances</h2>
      <div class="check"><input id="vacOn" type="checkbox"${prefs.vacOn ? ' checked' : ''}><label for="vacOn">Activer</label></div>
      <label for="vacStart">Début</label><input id="vacStart" type="date" value="${esc(prefs.vacStart)}">
      <label for="vacEnd">Fin</label><input id="vacEnd" type="date" value="${esc(prefs.vacEnd)}">
      <div class="hint">Pendant les vacances, les boutons Ouverture et Fermeture sont désactivés.</div>
    </div>
    <div class="card"><h2>📅 Jours travaillés et rappels</h2>
      <p style="margin:0 0 10px">Choisissez les jours où vous recevez un rappel d’ouverture.</p>
      <a class="btn light" id="goWork" href="#/work" style="margin-bottom:0">Ouvrir</a>
    </div>
    <div class="card"><h2>Numéros d’urgence</h2>
      <label for="astreinte">Astreinte MMG</label><input id="astreinte" type="tel" inputmode="tel" placeholder="facultatif" value="${esc(prefs.astreinte)}">
      <label for="veille">Veille départementale</label><input id="veille" type="tel" inputmode="tel" placeholder="facultatif" value="${esc(prefs.veille)}">
    </div>
    <div class="card"><h2>🔑 Licence</h2>
      <p style="margin:0 0 10px">${esc(LIC_VIEW[licState()][1])} — ${esc(LIC_VIEW[licState()][2]())}</p>
      <a class="btn light" href="#/licence" style="margin-bottom:0">Gérer la licence</a>
    </div>
    <div class="card"><h2>Mode test</h2>
      <div class="check"><input id="testMode" type="checkbox"${prefs.testMode ? ' checked' : ''}><label for="testMode">Activer le mode test</label></div>
      <div class="hint">Protégé par un code PIN. Ajoute « Test » aux noms et envoie vers le numéro de test.</div>
    </div>
    <button id="save">💾 Enregistrer</button>
    <p class="hint" style="text-align:center">CheckMMG PWA v${APP_VERSION} · HAWKUS CORP. · Lannion</p>`;

  $('#multisites').addEventListener('change', () => $('#mmgBox').classList.toggle('hidden', !$('#multisites').checked));

  const addMmg = () => {
    const name = $('#newMmg').value.trim();
    if (!name || name.includes('|')) return;
    collectConfig();
    if (!prefs.mmgList.includes(name)) prefs.mmgList = [...prefs.mmgList, name];
    savePrefs(); configScreen();
  };
  $('#addMmg').addEventListener('click', addMmg);
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    collectConfig();
    prefs.mmgList = prefs.mmgList.filter((_, i) => i !== Number(b.dataset.del));
    savePrefs(); configScreen();
  }));

  $('#testMode').addEventListener('change', async (ev) => {
    const wanted = ev.target.checked;
    ev.target.checked = !wanted; // reste inchangé tant que le PIN n'est pas validé
    if (await askPin()) {
      collectConfig();
      prefs.testMode = wanted;
      savePrefs(); configScreen();
    }
  });

  $('#save').addEventListener('click', () => {
    collectConfig();
    if (!prefs.userName || !prefs.mmgName || !prefs.phone) { toast('Nom, MMG et numéro sont obligatoires'); return; }
    if (prefs.vacOn && (!prefs.vacStart || !prefs.vacEnd)) { toast('Indiquez les dates de début et de fin'); return; }
    if (prefs.vacOn && prefs.vacStart > prefs.vacEnd) { toast('La date de début doit précéder la date de fin'); return; }
    if (prefs.multisites && !prefs.mmgList.length) { toast('Ajoutez au moins une MMG'); return; }
    if (savePrefs()) { toast('Configuration enregistrée'); location.hash = '#/'; }
  });
}

/* ---------- jours travaillés + rappels d'ouverture ---------- */

function workScreen() {
  const rows = DAY_NAMES.map((name, d) => `<tr><td>${name}</td>
      <td style="text-align:center"><input type="checkbox" data-w="${DAY_KEYS[d]}_mat"${isWorking(d, true) ? ' checked' : ''} aria-label="${name} matin"></td>
      <td style="text-align:center"><input type="checkbox" data-w="${DAY_KEYS[d]}_pm"${isWorking(d, false) ? ' checked' : ''} aria-label="${name} après-midi / soir"></td></tr>`).join('');

  app().innerHTML = `${topbar('Jours travaillés')}
    <div class="banner info">Décochez les périodes où vous ne travaillez jamais pour ne plus recevoir de rappel d’ouverture à ce moment-là.</div>
    <div class="banner warn">⚠️ Une case décochée n’empêche jamais d’ouvrir ou de fermer la MMG : elle supprime seulement le rappel.</div>
    <div class="card"><table class="sched"><tr><th>Jour</th><th>Mat</th><th>Apm/Soir</th></tr>${rows}</table></div>
    <button id="saveWork">💾 Sauvegarder</button>
    <div class="card" style="margin-top:18px"><h2>🔔 Rappels d’ouverture</h2>
      <p style="margin:0 0 10px">Une application web ne peut pas sonner toute seule. Ce bouton crée un fichier calendrier : les rappels
      (2 min avant l’heure officielle d’ouverture, jours travaillés uniquement, vacances exclues) sont ajoutés à l’agenda de votre téléphone.</p>
      <button class="light" id="ics">📅 Ajouter les rappels au calendrier</button>
      <div class="hint">Après un changement d’horaires, de jours travaillés ou de vacances : supprimez les anciens rappels « CheckMMG » de l’agenda, puis recommencez.
      Contrairement à l’appli Android, le calendrier ne sait pas si l’ouverture est déjà faite ; l’appli affiche un bandeau si c’est le cas.</div>
    </div>`;

  const read = () => {
    prefs.workOff = [...document.querySelectorAll('[data-w]')].filter((c) => !c.checked).map((c) => c.dataset.w);
    return savePrefs();
  };
  $('#saveWork').addEventListener('click', () => { if (read()) { toast('Jours travaillés enregistrés'); location.hash = '#/config'; } });
  $('#ics').addEventListener('click', () => { if (read()) exportReminders(); });
}

const icsDate = (d, h, m) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(h)}${pad(m)}00`;

/** Contenu .ics : un événement hebdomadaire par créneau d'ouverture, 2 min avant l'heure officielle. */
function buildReminders() {
  const BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const slots = [
    { days: [0, 1, 2, 3, 4], t: prefs.lvStart }, { days: [5], t: prefs.satStart },
    { days: [6], t: prefs.sun1Start }, { days: [6], t: prefs.sun2Start },
  ];
  const nowStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HAWKUS CORP//CheckMMG//FR', 'CALSCALE:GREGORIAN'];
  let count = 0;

  slots.forEach((slot, idx) => {
    const [h, m] = parse(slot.t);
    const at = Math.max(0, h * 60 + m - 2);                 // comme l'alarme Android : max(0, minute - 2)
    const rh = Math.floor(at / 60), rm = at % 60;
    const days = slot.days.filter((d) => isWorking(d, rh < 13));
    if (!days.length) return;
    // première occurrence à partir d'aujourd'hui
    let first = null;
    for (let i = 0; i < 7 && !first; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      if (days.includes(dayIdx(d)) && !(i === 0 && new Date() > new Date(d.getFullYear(), d.getMonth(), d.getDate(), rh, rm))) first = d;
    }
    if (!first) { first = new Date(today); first.setDate(first.getDate() + 7); while (!days.includes(dayIdx(first))) first.setDate(first.getDate() + 1); }
    // exclusions pendant le mode vacances (jusqu'à 1 an)
    const ex = [];
    if (prefs.vacOn && prefs.vacStart && prefs.vacEnd) {
      for (let i = 0; i < 366; i++) {
        const d = new Date(today); d.setDate(d.getDate() + i);
        const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        if (iso >= prefs.vacStart && iso <= prefs.vacEnd && days.includes(dayIdx(d))) ex.push(icsDate(d, rh, rm));
      }
    }
    lines.push('BEGIN:VEVENT',
      `UID:checkmmg-rappel-${idx}@hawkus`, `DTSTAMP:${nowStamp}`,
      `DTSTART:${icsDate(first, rh, rm)}`, `DTEND:${icsDate(first, Math.floor((at + 5) / 60) % 24, (at + 5) % 60)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${days.map((d) => BYDAY[d]).join(',')}`,
      ...(ex.length ? [`EXDATE:${ex.join(',')}`] : []),
      'SUMMARY:CheckMMG — Rappel ouverture',
      'DESCRIPTION:Pensez à enregistrer l’ouverture de la MMG dans CheckMMG.',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:CheckMMG — Rappel ouverture', 'TRIGGER:PT0S', 'END:VALARM',
      'END:VEVENT');
    count++;
  });
  lines.push('END:VCALENDAR');
  return { text: lines.join('\r\n') + '\r\n', count };
}

function exportReminders() {
  const { text, count } = buildReminders();
  if (!count) { toast('Aucune période cochée : pas de rappel à créer'); return; }
  shareOrDownload(new File([text], 'rappels_checkmmg.ics', { type: 'text/calendar' }), 'Rappels CheckMMG');
}

/* ---------- politique de confidentialité ---------- */

const PRIVACY_TEXT = `Éditeur : HAWKUS CORP. — Marc-Olivier Vachon (marco@marco22.fr).

1. Aucune donnée n’est envoyée à un serveur par CheckMMG
CheckMMG n’a aucun compte, aucun cookie de suivi, aucune publicité et aucun service d’analyse. Toutes vos données restent dans le navigateur de votre téléphone. Comme pour tout site web, l’hébergeur de l’application voit que la page a été téléchargée (adresse IP, date) ; il ne reçoit jamais le contenu de vos données.

2. Données stockées dans votre téléphone
• Configuration : nom d’utilisateur, nom de la MMG, numéro destinataire des SMS, numéros d’urgence (astreinte/veille), horaires officiels, mode vacances, jours travaillés.
• Historique des gardes : pour chaque ouverture/fermeture — date, heure, nom de la MMG, utilisateur, écart avec l’horaire officiel, nombre de patients et observations (fermeture), contenu du SMS, statut d’envoi.
• Licence : un identifiant d’installation généré au hasard (sans lien avec votre téléphone ou votre identité), la date d’expiration, un compteur de renouvellement et le code reçu de l’administrateur.
• Acceptation de cette politique : date et heure, conservées dans l’historique.

3. Ce que fait CheckMMG avec ces données
• SMS Ouverture/Fermeture : CheckMMG ouvre l’application Messages de votre téléphone avec le texte prêt, à destination du numéro configuré. C’est vous qui appuyez sur « Envoyer » ; le SMS passe par votre opérateur.
• Appels rapides : les boutons Astreinte/Veille ouvrent le composeur de votre téléphone.
• Licence : à votre demande, CheckMMG ouvre Messages avec un texte prérempli (identifiant d’installation + nom de la MMG) à destination de l’administrateur ; c’est vous qui appuyez sur « Envoyer ». Il répond par SMS avec un code que vous collez dans l’application.
• Rappels : le fichier calendrier est créé sur votre téléphone ; c’est vous qui l’ajoutez à votre agenda.
• Export CSV/PDF : générés sur votre téléphone, partagés uniquement si vous choisissez une destination.

4. Partage avec des tiers
Aucun, hormis les SMS envoyés aux numéros que vous configurez vous-même (opérateur téléphonique classique).

5. Conservation
Tant que vous ne videz pas les données du site ou ne supprimez pas l’application de l’écran d’accueil. Votre téléphone peut aussi effacer ces données après une longue période sans utilisation : exportez régulièrement votre historique.

6. Contact
marco@marco22.fr pour toute question.`;

function privacyScreen(consent) {
  app().innerHTML = `${consent ? '<h1>CheckMMG</h1>' : topbar('Confidentialité')}
    <p class="sub">${consent ? 'Politique de confidentialité — à accepter pour utiliser l’application' : 'Politique de confidentialité'}</p>
    <div class="card" style="white-space:pre-line">${esc(PRIVACY_TEXT)}</div>
    ${consent ? '<button id="accept">✅ J’accepte</button><button class="ghost" id="refuse">Je refuse</button>' : ''}`;
  if (!consent) return;
  $('#accept').addEventListener('click', () => {
    const now = Date.now(), d = new Date(now);
    prefs.privacyAt = now;
    if (!savePrefs()) return;
    const hist = loadHist();
    hist.push({ id: hist.reduce((mx, e) => Math.max(mx, e.id || 0), 0) + 1, type: 'PRIVACY_ACCEPTED', dt: now,
      mmg: '', user: prefs.userName, official: '', actual: fmt(d.getHours(), d.getMinutes()), overtime: 0, smsSent: false, smsContent: '' });
    saveHist(hist);
    location.hash = '#/'; route();
  });
  $('#refuse').addEventListener('click', () => toast('Vous devez accepter la politique de confidentialité pour utiliser CheckMMG.'));
}

/* ---------- licence ---------- */

const LIC_VIEW = {
  VALID: ['#1B5E20', '✅ Licence active', () => `Expire le ${licExpiryStr()} (${licDaysRemaining()} jours)`],
  WARNING: ['#E65100', '⚠️ Licence expire bientôt', () => `Expire le ${licExpiryStr()} — ${licDaysRemaining()} jours restants`],
  GRACE: ['#B71C1C', '🚨 Licence expirée — période de grâce', () => `Expirée le ${licExpiryStr()} — ${7 + licDaysRemaining()} jour(s) de grâce restants`],
  EXPIRED: ['#37474F', '🔴 Licence expirée — lecture seule', () => `Expirée le ${licExpiryStr()} — renouvelez pour restaurer l’accès`],
  CLOCK_TAMPERED: ['#37474F', '🕒 Horloge de l’appareil incorrecte',
    () => 'La date/heure de l’appareil a été reculée. Remettez l’horloge à la bonne date et relancez l’application.'],
  NOT_ACTIVATED: ['#37474F', '⚫ Application non activée', () => 'Envoyez la demande d’activation à l’administrateur.'],
};

function licenceScreen() {
  const state = licState();
  const [color, title, detail] = LIC_VIEW[state];
  const blocked = licBlocked();
  const pending = licHasPending();

  app().innerHTML = `${blocked ? '<h1>CheckMMG</h1><p class="sub">Licence</p>' : topbar('Licence')}
    <div class="card" style="background:${color};color:#fff;border-color:${color}">
      <div style="font-size:18px;font-weight:700">${esc(title)}</div><div>${esc(detail())}</div>
    </div>
    ${blocked && !(prefs.userName && prefs.mmgName) ? `<div class="banner warn">Avant de demander le code, renseignez votre nom et votre MMG : l’administrateur
      en a besoin pour vous identifier. <a class="btn light" href="#/config" style="margin-top:8px">⚙️ Renseigner mon nom et ma MMG</a></div>` : ''}
    <div class="card"><h2>Étape 1 — Demander le code</h2>
      <p style="margin:0 0 10px">${pending
        ? 'Une demande est déjà en cours (valable 7 jours). Renvoyez-la si nécessaire ou attendez la réponse.'
        : 'L’application ouvre Messages avec un texte prêt, à destination de l’administrateur. Appuyez sur « Envoyer ».'}</p>
      <button id="licReq">${pending ? '📤 Renvoyer la demande' : '📤 Envoyer la demande par SMS'}</button>
    </div>
    <div class="card"><h2>Étape 2 — Coller la réponse</h2>
      <p style="margin:0 0 6px">Copiez le SMS de l’administrateur (il commence par <b>MMG|OK|</b>) puis collez-le ici.</p>
      <textarea id="licCode" placeholder="MMG|OK|…|…" autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
      <div class="hint" id="licErr" style="color:var(--ko);font-weight:600"></div>
      <button id="licOk" style="margin-top:10px">✅ Valider</button>
    </div>
    ${blocked ? callRow() : ''}
    <p class="hint" style="text-align:center">ID installation : ${esc(lic.uuid)}</p>`;

  $('#licReq').addEventListener('click', () => {
    location.href = smsUrl(LIC_ADMIN_PHONE, licRequestBody(prefs.mmgName));
    toast('Validez l’envoi dans Messages, puis attendez le code.');
  });
  $('#licOk').addEventListener('click', async () => {
    const btn = $('#licOk');
    btn.disabled = true;
    const err = await licValidate($('#licCode').value);
    btn.disabled = false;
    if (err) { $('#licErr').textContent = err; return; }
    toast('✅ Licence activée — merci !');
    location.hash = '#/'; route();
  });
}

/* ---------- navigation ---------- */

const ROUTES = {
  '': home, open: openingScreen, close: closingScreen, history: historyScreen, config: configScreen,
  work: workScreen, privacy: () => privacyScreen(false), licence: licenceScreen,
};

function route() {
  const key = (location.hash || '#/').replace(/^#\/?/, '');
  if (!prefs.privacyAt && key !== 'privacy') { privacyScreen(true); window.scrollTo(0, 0); return; }
  // licence non valide : tout est bloqué sauf la politique de confidentialité et la configuration (nom/MMG à renseigner avant la demande)
  if (key !== 'privacy' && key !== 'config' && licBlocked()) { licenceScreen(); window.scrollTo(0, 0); return; }
  let screen = ROUTES[key] || home;
  if (vacationActive() && (key === 'open' || key === 'close')) screen = home;
  screen();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', async () => {
  await licInit();
  route();
  checkPending();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* hors ligne non disponible */ });
});
