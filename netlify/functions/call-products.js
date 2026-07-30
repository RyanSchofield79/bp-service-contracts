'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Netlify serverless function — PRODUCT TYPE LOOKUP for service calls
//
// Why this is a separate endpoint:
//   A Business Pilot service call carries no product information at all. The
//   raw /ServiceCalls/find record is:
//     id, contractId, contractNumber, contractName, dateAdded, dateUpdated,
//     status, lastAppointmentDate, lastAppointmentFor, callType,
//     primaryReasonForCall, routeOfIssue, responseForCall, customerSigned,
//     noFurtherAction, revisitRequired, estimatedTimeOnSite, branch
//   Product type lives on the LEAD behind the contract (productType1/2/3), so
//   the only way to get it onto a call is to join on contract number.
//
//   That join cannot be done cheaply. Service calls in the reporting window
//   reference ~1,500 different contracts, and they are overwhelmingly the
//   ORIGINAL INSTALL contracts rather than service contracts — only ~60 of them
//   appear in the "12 - Service" filtered set. So the whole contract book has to
//   be read: 37k+ records, roughly 25-30 seconds upstream. Bolting that onto
//   /api/service-calls would take a page load from ~9s to ~40s.
//
//   Instead the dashboard renders first and calls this endpoint in the
//   background, then fills the product charts in when it answers. The result is
//   held in the warm lambda for 30 minutes, so repeat loads are immediate.
//
// Response is index-encoded to keep it small:
//   { types: ["01 - Upvc Windows & Doors (01)", ...],
//     map:   { "28992": 0, "31007": 2, ... } }
// ─────────────────────────────────────────────────────────────────────────────
const https = require('https');

const BASE_URL = 'open-api.businesspilot.co.uk';

// Long TTL: the underlying pull is expensive and product type on a historic
// contract does not change.
const TTL_MS = 30 * 60 * 1000;
let cache = null;
let inFlight = null;

function apiPost(apiKey, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const options = {
      hostname: BASE_URL,
      path:     `/api${endpoint}`,
      method:   'POST',
      headers:  {
        'X-Api-Key':      apiKey,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept':         'application/json',
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try   { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error(`JSON parse error on ${endpoint}: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} on ${endpoint}: ${raw.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    // Deliberately long: the unfiltered contract pull is the slow part.
    req.setTimeout(55000, () => req.destroy(new Error(`Timeout calling ${endpoint}`)));
    req.write(payload);
    req.end();
  });
}

function unwrap(resp) {
  const result = Array.isArray(resp) ? resp[0] : resp;
  return {
    items:     (result && result.items)     || [],
    itemCount: (result && result.itemCount) || 0,
  };
}

async function buildMap(apiKey) {
  const r = unwrap(await apiPost(apiKey, '/Contracts/find', {}));

  const types = [];
  const index = new Map();
  const map   = {};
  let withProduct = 0;

  r.items.forEach(c => {
    const numRaw = String(c.contractNumber || '').trim();
    if (!numRaw) return;
    const lead = c.lead || {};
    const product = String(lead.productType1 || lead.productType2 || lead.productType3 || '').trim();
    if (!product) return;               // leave it out; the page shows these as "Not recorded"
    withProduct++;
    if (!index.has(product)) { index.set(product, types.length); types.push(product); }
    map[numRaw] = index.get(product);
  });

  return {
    generatedAt: new Date().toISOString(),
    contracts:   r.items.length,
    itemCount:   r.itemCount,
    withProduct,
    types,
    map,
  };
}

// One shared promise, so two page loads landing together do not both pay the
// 30-second cost.
function getMap(apiKey, bypass) {
  if (!bypass && cache && (Date.now() - cache.at) < TTL_MS) return Promise.resolve(cache.value);
  if (inFlight) return inFlight;
  inFlight = buildMap(apiKey)
    .then(value => { cache = { at: Date.now(), value }; inFlight = null; return value; })
    .catch(err  => { inFlight = null; throw err; });
  return inFlight;
}

exports.handler = async (event) => {
  const API_KEY = process.env.BP_API_KEY;
  if (!API_KEY) return json(500, { error: 'BP_API_KEY environment variable is not configured' });

  const q = (event && event.queryStringParameters) || {};

  try {
    const value = await getMap(API_KEY, q.fresh === '1');
    return json(200, value);
  } catch (err) {
    return json(502, { error: err.message });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Cache-Control':               'no-store',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
