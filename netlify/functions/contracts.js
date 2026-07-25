'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Netlify serverless function — Business Pilot LIVE SERVICE CONTRACTS
//
// Migrated to the new BPO Open API host: open-api.businesspilot.co.uk
//   • Auth header unchanged:    X-Api-Key
//   • Path shape unchanged:     POST /api/Contracts/find
//   • Response shape unchanged: [ { items: [...], itemCount: n } ]
//   • The new API has NO page / pageSize parameters — one request returns the
//     whole matching set, so nothing gets silently cut off part way down. We
//     still compare items.length against itemCount and surface a warning.
//   • The new API IGNORES dateAddedAfter / dateAddedBefore, so an unfiltered
//     request pulls the entire history and is slow enough to hit the Netlify
//     function timeout. We therefore ask the API for the service-contract type
//     directly ("12 - Service"), which is both correct and fast.
// ─────────────────────────────────────────────────────────────────────────────
const https = require('https');

const BASE_URL      = 'open-api.businesspilot.co.uk';
const SERVICE_TYPE  = process.env.CHARGEABLE_CONTRACT_TYPE || '12 - Service';

// Warm-lambda cache — the upstream response is large, so hold it briefly.
const TTL_MS = 10 * 60 * 1000;
let cache = null;

// ── Low-level HTTPS POST to the BP API ───────────────────────────────────────
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
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('Timeout calling ' + endpoint)));
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

// ── Fetch service contracts ──────────────────────────────────────────────────
async function fetchServiceContracts(apiKey) {
  if (cache && (Date.now() - cache.at) < TTL_MS) return cache.value;

  // Fast, correct path — let the API return only the service-contract type.
  let r = unwrap(await apiPost(apiKey, '/Contracts/find', { contractType: SERVICE_TYPE }));

  // Safety net: if the type filter matches nothing, fall back to everything and
  // filter locally the way the dashboard always has.
  let source = 'typeFilter';
  if (r.items.length === 0) {
    source = 'fullScan';
    r = unwrap(await apiPost(apiKey, '/Contracts/find', {}));
    r.items = r.items.filter(c => {
      const pipeline = String(c.currentPipeline || '').toLowerCase();
      const type     = String((c.lead || {}).leadType || '').toLowerCase();
      return pipeline.includes('service') || type.includes('service');
    });
  }

  const value = { items: r.items, itemCount: r.itemCount, source };
  cache = { at: Date.now(), value };
  return value;
}

// ── Netlify handler ──────────────────────────────────────────────────────────
exports.handler = async () => {
  const API_KEY = process.env.BP_API_KEY;

  if (!API_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'BP_API_KEY environment variable is not configured' }),
    };
  }

  try {
    const raw = await fetchServiceContracts(API_KEY);

    // Map to the fields the dashboard needs
    const mapped = raw.items.map(c => {
      const lead    = c.lead    || {};
      const contact = lead.contact || {};
      return {
        contractNumber:     String(c.contractNumber || ''),
        customer:           (contact.contactName || contact.companyName || '').trim(),
        contractStatus:     c.currentStatus         || '',
        contractStatusDate: c.currentStatusDate     || '',
        productType:        lead.productType1 || lead.productType2 || lead.productType3 || '',
        netValue:           parseFloat(c.confirmedNetSaleValue) || 0,
        balance:            parseFloat(c.balance || c.balanceDue) || 0,
        installStart:       c.installStart          || '',
        contractType:       lead.leadType           || '',
        currentPipeline:    c.currentPipeline       || '',
      };
    });

    // Keep only LIVE service contracts — exclude completed / cancelled / on hold
    const contracts = mapped.filter(c => {
      const status = (c.contractStatus || '').toLowerCase().trim();
      if (status === 'completed')  return false;
      if (status === 'cancelled')  return false;
      if (status === 'on hold')    return false;
      return true;
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type':                'application/json',
        'Cache-Control':               'no-store',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(contracts),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
