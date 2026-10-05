// Yandex Cloud Function «data-api», behind the API gateway at /db/{rest+}. See api.js for the
// routes and core.js for the rules; this file only wires them to YDB, the bucket and the
// request/response shape of a function called through API Gateway.

'use strict';

const { createApi } = require('./api');
const store = require('./store-ydb');
const files = require('./files');
const auth = require('./auth');
const { createAccounts } = require('./accounts');

const accounts = createAccounts({ store, auth });
const api = createApi({ store, auth, files, accounts });

module.exports.handler = async function (event) {
  const params = event.params || event.pathParams || {};
  let rest = params.rest;
  if (rest == null) rest = String(event.url || event.path || '').split('?')[0].replace(/^.*?\/db\//, '');
  const query = event.multiValueQueryStringParameters || event.queryStringParameters || {};
  const body = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body || '');
  // Who is calling, for counting failed sign-ins: the client's address as the gateway saw it.
  const h = event.headers || {};
  const ip = (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp)
    || String(h['X-Forwarded-For'] || h['x-forwarded-for'] || '').split(',')[0].trim() || h['X-Real-Ip'] || null;
  const res = await api.handle({ method: event.httpMethod, rest, query, headers: h, body, ip });
  return { statusCode: res.status, headers: res.headers, body: res.body, isBase64Encoded: false };
};
