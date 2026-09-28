// A cheap "is there any drafting work waiting?" signal, kept in the drafts lease document.
//
// Every message in the group nudges api/telegram/build-drafts.js, and each nudge used to run
// a query over the whole last 24 hours of messages, all topics, every returned document a
// billed read — so the daily read count grew with the square of group activity. At a few
// hundred messages a day that alone would exhaust the Firestore read quota the whole app
// shares. Instead the webhook records when watched-topic messages arrive, and a nudge reads
// this one document to decide whether the full query is needed at all.
//
//   pendingSince  — the oldest watched-topic message that may still be unprocessed
//                   (null: nothing pending; missing: not initialised yet)
//   lastWatchedAt — when (server clock) the latest watched-topic message was captured
//
// All functions here are pure (they take Firestore fields and return fields to write), so
// they can run inside updateDoc and be unit-tested without a database.

const { fsString } = require('./firestore');

const DRAFTS_LEASE_DOC = 'appdata/_drafts_lease';

function toMs(v) {
  const s = v && typeof v.stringValue === 'string' ? v.stringValue : '';
  const t = s ? Date.parse(s) : NaN;
  return isNaN(t) ? null : t;
}
const isoField = ms => fsString(new Date(ms).toISOString());

// Two servers' clocks (the webhook's and the check's) are compared below; this much slack
// covers any drift between them, at the cost of at most one extra check.
const CAPTURE_SKEW_MS = 5000;

// Webhook, on capturing a watched-topic message dated msgMs (Telegram's send time, whole
// seconds). capturedMs is the webhook's own clock taken AFTER the message was written to
// telegram_messages — that, not msgMs, is what says whether a check's query could have seen
// it: a message sent a moment before a check started, but written a moment after its query
// ran, has msgMs before the check and was still missed by it.
function signalOnCapture(fields, msgMs, capturedMs) {
  const seen = capturedMs == null ? msgMs : capturedMs;
  const last = toMs(fields.lastWatchedAt), pend = toMs(fields.pendingSince);
  return {
    lastWatchedAt: isoField(last == null ? seen : Math.max(last, seen)),
    pendingSince: isoField(pend == null ? msgMs : Math.min(pend, msgMs)),
  };
}

// After a full check whose message fetch started at fetchMs. remainingOldestMs is the oldest
// watched-topic message that check did not process (still settling, or beyond its batch),
// or null. Returns the fields to write, or null when nothing changes.
function signalAfterCheck(fields, remainingOldestMs, fetchMs) {
  let next = remainingOldestMs;
  const last = toMs(fields.lastWatchedAt);
  // A watched message captured after this check's fetch began may not have been seen by it —
  // keep a marker no later than the fetch so a later nudge still looks. Clearing the signal
  // here would silently forget that message until the evening cron.
  if (last != null && last > fetchMs - CAPTURE_SKEW_MS) next = next == null ? fetchMs : Math.min(next, fetchMs);
  const cur = toMs(fields.pendingSince);
  const curIsNull = !!(fields.pendingSince && 'nullValue' in fields.pendingSince);
  if (next == null ? curIsNull : next === cur) return null;
  return { pendingSince: next == null ? { nullValue: null } : isoField(next) };
}

// Whether a plain nudge (not the cron, not the app's button) needs the full check.
function nudgeGate(fields, nowMs, settleMs) {
  if (!fields.pendingSince) return { go: true, reason: 'signal not initialised' };
  const pend = toMs(fields.pendingSince);
  if (pend == null) return { go: false, reason: 'nothing pending' };
  if (pend > nowMs - settleMs) return { go: false, reason: 'not settled yet' };
  return { go: true, reason: 'settled work pending' };
}

module.exports = { DRAFTS_LEASE_DOC, signalOnCapture, signalAfterCheck, nudgeGate };
