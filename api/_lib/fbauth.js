// Signing on behalf of the Firebase project, with nothing but Node's own crypto.
//
// Two things are needed and both are plain RS256 JWTs signed with the service account's key,
// so neither is worth a dependency (this project has no package.json and no build step, and
// adding one to mint a token would change how the whole thing deploys):
//
//   mintCustomToken()  — a token the browser exchanges for a Firebase session, carrying the
//                        role this person logged in as. Firestore rules read that role.
//   accessToken()      — an OAuth token letting the serverless functions keep writing to
//                        Firestore once the rules stop allowing anonymous writes.
//
// Required Vercel environment variable: FIREBASE_SERVICE_ACCOUNT — the whole JSON of a
// service-account key from Firebase Console → Project settings → Service accounts.

const crypto = require('crypto');

const IDENTITY_AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');
  let sa;
  // Vercel's dashboard keeps newlines in a pasted value, but a key pasted through a shell
  // often arrives with them escaped — accept both rather than fail with a confusing
  // "invalid PEM" much further down.
  try { sa = JSON.parse(raw); } catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT is missing client_email/private_key');
  sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
  return sa;
}

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function signJwt(payload, sa) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(sa.private_key);
  return `${head}.${body}.${b64url(sig)}`;
}

// The token the browser passes to signInWithCustomToken(). uid identifies the account (the
// role name, so rules can name it directly) and claims travel into request.auth.token.
function mintCustomToken(uid, claims) {
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: sa.client_email, sub: sa.client_email, aud: IDENTITY_AUD,
    iat: now, exp: now + 3600, // Firebase rejects anything longer
    uid: String(uid).slice(0, 128),
    claims: claims || {},
  }, sa);
}

// An OAuth access token for Firestore REST. Cached for as long as it is valid, minus a
// minute, because a serverless instance handles many requests and each mint is a round trip.
let _cached = { token: null, until: 0 };
async function accessToken() {
  if (_cached.token && Date.now() < _cached.until) return _cached.token;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt({
    iss: sa.client_email, scope: DATASTORE_SCOPE, aud: OAUTH_TOKEN_URL,
    iat: now, exp: now + 3600,
  }, sa);
  const r = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(assertion),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google token exchange → ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  _cached = { token: j.access_token, until: Date.now() + Math.max(60, (Number(j.expires_in) || 3600) - 60) * 1000 };
  return _cached.token;
}

const hasServiceAccount = () => !!process.env.FIREBASE_SERVICE_ACCOUNT;

module.exports = { mintCustomToken, accessToken, hasServiceAccount };
