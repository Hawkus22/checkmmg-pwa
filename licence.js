'use strict';
/* Licence CheckMMG (PWA) — même cycle de vie que l'appli Android (90 jours, avertissement à 14 jours,
 * 7 jours de grâce, anti-rejeu, anti-recul d'horloge) mais vérifiée par SIGNATURE À CLÉ PUBLIQUE.
 *
 * La page ne contient que la clé publique : elle sait vérifier un code, jamais en fabriquer.
 * La clé privée reste chez l'administrateur (tools/pwa-licence/pwa_licence_signer.js).
 *
 * SMS de demande (PWA → admin) : CMMG|UUID|CONTACT|CHALL|TS|VER|CTR   avec VER = 2
 * SMS de réponse (admin → PWA) : MMG|OK|SIGNATURE|EXP   ou   MMG|REJECT|raison|0
 * Données signées : CMMG-PWA|1|OK|UUID|CHALL|TS|CTR|EXP   (ECDSA P-256 / SHA-256, signature r||s en base64url)
 */

const LIC_KEY = 'checkmmg.licence';
const LIC_ADMIN_PHONE = '+33786824344';
const LIC_PROTO_VER = 2;
// Clé publique (point non compressé P-256, base64). Générée par « pwa_licence_signer.js keygen ».
const LIC_PUBKEY = 'BC0JuicscM6cdDfVaOa7udeJuZwLFahyI2tMUFS5eQVOX/CRPb3zeOQgqomlmOaWlyNj24kqgK/kz3bBQ3NHRFY=';

const LIC_DAY = 24 * 60 * 60 * 1000;
const LIC_WARNING = 14 * LIC_DAY;
const LIC_GRACE = 7 * LIC_DAY;
const LIC_CHALLENGE_VALIDITY = 7 * LIC_DAY;
const LIC_MAX_EXPIRY = 91 * LIC_DAY;           // une expiration plus lointaine est refusée
const LIC_ROLLBACK_TOLERANCE = 5 * 60 * 1000;  // dérive d'horloge / fuseau tolérée
const LIC_BLACKLIST_MAX = 50;
const LIC_TRIAL_DAYS = 6;                      // essai accordé d'office au premier lancement
const LIC_TRIAL_MS = LIC_TRIAL_DAYS * LIC_DAY;
const LIC_B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const LIC_EMPTY = { uuid: '', act: null, counter: 0, challenge: '', challengeTs: 0, lastSeen: 0, used: [], trialStart: 0 };
let lic = { ...LIC_EMPTY };
let licOk = true;   // false si la signature enregistrée ne se vérifie plus (données modifiées)

function licLoad() {
  try { lic = { ...LIC_EMPTY, ...JSON.parse(localStorage.getItem(LIC_KEY) || '{}') }; }
  catch (_) { lic = { ...LIC_EMPTY }; }
  if (!lic.uuid) { lic.uuid = licUuid(); licSave(); }
  // Période d'essai : accordée une seule fois, au premier chargement d'une installation jamais activée.
  // Elle n'est jamais ré-accordée ensuite (installation déjà activée, ou essai déjà consommé).
  if (!lic.act && !lic.trialStart) { lic.trialStart = Date.now(); licSave(); }
}
function licSave() { try { localStorage.setItem(LIC_KEY, JSON.stringify(lic)); } catch (_) { /* ignoré */ } }

function licUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 10 octets aléatoires → 16 caractères Base32 (comme CryptoHelper.generateChallenge). */
function licChallenge() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = '', buf = 0, bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += LIC_B32[(buf >> bits) & 31]; }
    buf &= (1 << bits) - 1;
  }
  return out;
}

/** Doit rester identique à signedData() dans tools/pwa-licence/pwa_licence_signer.js. */
const licData = (uuid, chall, ts, ctr, exp) => `CMMG-PWA|1|OK|${uuid}|${chall}|${ts}|${ctr}|${exp}`;

const licB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function licVerifySig(data, sigB64url) {
  if (!(window.crypto && crypto.subtle)) throw new Error('HTTPS requis');
  const key = await crypto.subtle.importKey('raw', licB64(LIC_PUBKEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, licB64(sigB64url), new TextEncoder().encode(data));
}

/** Au démarrage : recharge l'état et revérifie la signature de l'activation (détecte toute modification). */
async function licInit() {
  licLoad();
  licOk = true;
  if (!lic.act) return;
  try {
    const a = lic.act;
    licOk = await licVerifySig(licData(lic.uuid, a.chall, a.ts, a.ctr, a.exp), a.sig);
  } catch (_) { licOk = false; }
}

/** Repère anti-recul d'horloge : n'avance jamais en arrière. */
function licTouch(now) {
  if (now > lic.lastSeen) {
    const stale = now - lic.lastSeen > 60 * 1000;
    lic.lastSeen = now;
    if (stale) licSave();
  }
}

/** État d'une installation jamais activée : TRIAL pendant 6 jours, puis TRIAL_ENDED (pas de période de grâce). */
function licTrialState() {
  if (!lic.trialStart) return 'NOT_ACTIVATED';
  const now = Date.now();
  if (lic.lastSeen > 0 && now < lic.lastSeen - LIC_ROLLBACK_TOLERANCE) return 'CLOCK_TAMPERED';
  if (now >= lic.trialStart + LIC_TRIAL_MS) return 'TRIAL_ENDED';
  licTouch(now);
  return 'TRIAL';
}

/** Jours d'essai restants (arrondi au-dessus : 6 le premier jour, 1 le dernier). */
const licTrialDays = () => Math.max(0, Math.ceil((lic.trialStart + LIC_TRIAL_MS - Date.now()) / LIC_DAY));

/** NOT_ACTIVATED | TRIAL | TRIAL_ENDED | VALID | WARNING | GRACE | EXPIRED | CLOCK_TAMPERED */
function licState() {
  if (!lic.act) return licTrialState();
  if (!licOk) return 'EXPIRED';
  const now = Date.now();
  if (lic.lastSeen > 0 && now < lic.lastSeen - LIC_ROLLBACK_TOLERANCE) return 'CLOCK_TAMPERED';
  const remaining = lic.act.exp - now;
  let s;
  if (remaining > LIC_WARNING) s = 'VALID';
  else if (remaining > 0) s = 'WARNING';
  else if (-remaining < LIC_GRACE) s = 'GRACE';
  else s = 'EXPIRED';
  // le repère anti-recul n'avance jamais en arrière, ni quand l'appli est bloquée
  if (s !== 'EXPIRED' && now > lic.lastSeen) {
    const stale = now - lic.lastSeen > 60 * 1000;
    lic.lastSeen = now;
    if (stale) licSave();
  }
  return s;
}

const licBlocked = () => ['NOT_ACTIVATED', 'TRIAL_ENDED', 'EXPIRED', 'CLOCK_TAMPERED'].includes(licState());
const licDaysRemaining = () => (lic.act ? Math.trunc((lic.act.exp - Date.now()) / LIC_DAY) : 0);
const licExpiryStr = () => {
  if (lic.act) return new Date(lic.act.exp).toLocaleDateString('fr-FR');
  return lic.trialStart ? new Date(lic.trialStart + LIC_TRIAL_MS).toLocaleDateString('fr-FR') : '—';
};
const licHasPending = () => !!lic.challenge && Date.now() - lic.challengeTs < LIC_CHALLENGE_VALIDITY;

/** Corps du SMS de demande ; réutilise le challenge en cours s'il a moins de 7 jours. */
function licRequestBody(mmgName) {
  if (!licHasPending()) {
    lic.challenge = licChallenge();
    lic.challengeTs = Date.now();
    licSave();
  }
  const contact = (mmgName || '').trim().replace(/\|/g, '-') || 'MMG';
  return ['CMMG', lic.uuid, contact, lic.challenge, lic.challengeTs, LIC_PROTO_VER, lic.counter].join('|');
}

/** Valide la réponse collée par l'utilisateur. Renvoie null si succès, sinon un message d'erreur. */
async function licValidate(input) {
  const entered = String(input || '').trim();
  if (!entered.startsWith('MMG|')) return 'Collez la réponse complète reçue par SMS (elle commence par « MMG| »).';
  const p = entered.split('|');
  if (p.length !== 4) return 'Format de réponse invalide.';
  const [, type, sig, expStr] = p;
  if (type === 'REJECT' || type === 'ERROR') return `Demande refusée par l’administrateur : ${sig}`;
  if (type !== 'OK') return 'Format de réponse invalide.';

  if (!lic.challenge) return 'Aucune demande en attente — envoyez d’abord la demande.';
  if (Date.now() - lic.challengeTs > LIC_CHALLENGE_VALIDITY) {
    lic.challenge = ''; lic.challengeTs = 0; licSave();
    return 'Demande expirée (> 7 jours) — générez-en une nouvelle.';
  }
  if (lic.used.includes(lic.challenge)) return 'Ce challenge a déjà été utilisé (anti-rejeu).';

  const exp = Number(expStr), now = Date.now();
  if (!Number.isFinite(exp) || exp <= now || exp > now + LIC_MAX_EXPIRY) return 'Date d’expiration invalide dans la réponse.';

  let ok;
  try { ok = await licVerifySig(licData(lic.uuid, lic.challenge, lic.challengeTs, lic.counter, exp), sig); }
  catch (e) { return e.message === 'HTTPS requis' ? 'Navigateur non compatible (HTTPS requis).' : 'Code invalide — vérifiez la réponse collée.'; }
  if (!ok) return 'Code invalide — vérifiez la réponse collée.';

  lic.act = { chall: lic.challenge, ts: lic.challengeTs, ctr: lic.counter, exp, sig };
  lic.used = [...lic.used, lic.challenge].slice(-LIC_BLACKLIST_MAX);
  lic.counter += 1;
  lic.challenge = ''; lic.challengeTs = 0;
  lic.lastSeen = Math.max(lic.lastSeen, now);
  licOk = true;
  licSave();
  return null;
}
