// Yandex Cloud Function «data-api», behind the API gateway at /db/{rest+}. See api.js for the
// routes and core.js for the rules; this file only wires them to YDB, the bucket and the
// request/response shape of a function called through API Gateway.

'use strict';

const { createApi } = require('./api');
const store = require('./store-ydb');
const files = require('./files');
const auth = require('./auth');
const { createAccounts } = require('./accounts');
const images = require('./images');

const accounts = createAccounts({ store, auth });
const api = createApi({ store, auth, files, accounts, images });

// HEAD /service-manager.html (routed here by the gateway): only tabs still running a version
// from before the move ask this — the current page asks /app-version. Their version check
// read nothing but an ETag, which Yandex's bucket doesn't pass on, so they never reloaded; and
// since Firebase was locked they can't check a password either, telling everyone it's wrong.
// An ETag that changes every four minutes (they check every three) makes them reload into
// the current page within a few minutes of being looked at.
const OLD_TAB_PATH = /\/service-manager\.html$/;

module.exports.handler = async function (event, context) {
  if (OLD_TAB_PATH.test(String(event.url || event.path || '').split('?')[0])) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ETag: '"reload-' + Math.floor(Date.now() / 240000) + '"' }, body: '', isBase64Encoded: false };
  }
  const params = event.params || event.pathParams || {};
  let rest = params.rest;
  if (rest == null) rest = String(event.url || event.path || '').split('?')[0].replace(/^.*?\/db\//, '');
  const query = event.multiValueQueryStringParameters || event.queryStringParameters || {};
  const body = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body || '');
  // Who is calling, for counting failed sign-ins: the client's address as the gateway saw it.
  const h = event.headers || {};
  const ip = (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp)
    || String(h['X-Forwarded-For'] || h['x-forwarded-for'] || '').split(',')[0].trim() || h['X-Real-Ip'] || null;
  // The function's own service account, for calls to other Yandex services (the image search).
  const iamToken = context && context.token && context.token.access_token;
  const res = await api.handle({ method: event.httpMethod, rest, query, headers: h, body, ip, iamToken });
  return { statusCode: res.status, headers: res.headers, body: res.body, isBase64Encoded: false };
};
