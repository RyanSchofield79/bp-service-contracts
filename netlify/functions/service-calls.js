'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Netlify serverless function — Business Pilot SERVICE CALLS
//
// Host: open-api.businesspilot.co.uk  (the new BPO "Scalar" Open API)
//   • Auth header is still  X-Api-Key
//   • Paths are still       /api/<Controller>/<action>   (POST)
//   • Responses are still   [ { items: [...], itemCount: n } ]
//   • NOTE: the new API has NO page / pageSize parameters. A request returns
//     the whole matching set. To stay safely inside any server-side cap we
//     verify items.length against itemCount and, if short, re-fetch the range
//     month-by-month using dateAddedAfter / dateAddedBefore.
//
// Chargeable vs warranty:
//   A service call is CHARGEABLE when its contract is of the service-contract
//   type (default "12. Service Contract"); every other call is WARRANTY.
//   The contract list is fetched once and reduced to a Set of contract numbers.
//
// Debug: GET /api/service-calls?debug=1 returns the distinct status / callType
//        values and the contract-type match counts instead of the dataset.
// ─────────────────────────────────────────────────────────────────────────────
const https = require('https');

const BASE_URL = 'open-api.businesspilot.co.uk';

// The contract type that makes a service call chargeable.
// Override without a code change via the CHARGEABLE_CONTRACT_TYPE env var.
const CHARGEABLE_TYPE = process.env.CHARGEABLE_CONTRACT_TYPE || '12. Service Contract';

// Statuses that count as "closed". Everything else counts as open.
const CLOSED_STATUSES = ['closed', 'cancelled', 'canceled', 'complete', 'completed'];

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
          catch (e) { reject(new Error(`JSON parse error on ${endpoint}: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} on ${endpoint}: ${raw.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// BP wraps find results in an array → [ { items, itemCount } ]
function unwrap(resp) {
  const result = Array.isArray(resp) ? resp[0] : resp;
  return {
    items:     (result && result.items)     || [],
    itemCount: (result && result.itemCount) || 0,
  };
}

// ── Date helpers ─────────────────────────────────────────────────────────────
// Financial year runs 1 April → 31 March.
function fyStart(d) {
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 3 ? new Date(Date.UTC(y, 3, 1)) : new Date(Date.UTC(y - 1, 3, 1));
}
function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function addMonths(d, n) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

// ── Fetch service calls over a date range ────────────────────────────────────
// One request for the whole range; if the API returns fewer rows than it says
// exist, fall back to one request per calendar month and merge.
async function fetchServiceCalls(apiKey, fromDate, toDate) {
  const whole = unwrap(await apiPost(apiKey, '/ServiceCalls/find', {
    dateAddedAfter:  fromDate.toISOString(),
    dateAddedBefore: toDate.toISOString(),
  }));

  if (whole.items.length >= whole.itemCount) {
    return { items: whole.items, windowed: false };
  }

  // Truncated → walk month by month (in parallel, a few at a time).
  const windows = [];
  for (let m = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1));
       m < toDate;
       m = addMonths(m, 1)) {
    windows.push([m, addMonths(m, 1)]);
  }

  const byId = new Map();
  whole.items.forEach(c => byId.set(c.id, c));

  const CONCURRENCY = 4;
  for (let i = 0; i < windows.length; i += CONCURRENCY) {
    const slice = windows.slice(i, i + CONCURRENCY);
    const parts = await Promise.all(slice.map(([a, b]) => apiPost(apiKey, '/ServiceCalls/find', {
      dateAddedAfter:  a.toISOString(),
      dateAddedBefore: b.toISOString(),
    })));
    parts.forEach(p => unwrap(p).items.forEach(c => byId.set(c.id, c)));
  }

  return { items: [...byId.values()], windowed: true };
}

// ── Fetch the set of contract numbers that are chargeable service contracts ──
async function fetchChargeableContractNumbers(apiKey) {
  const fetchFrom = new Date();
  fetchFrom.setUTCFullYear(fetchFrom.getUTCFullYear() - 10);

  // Preferred: let the API filter by contract type (one small response).
  let items = [];
  try {
    items = unwrap(await apiPost(apiKey, '/Contracts/find', {
      dateAddedAfter: fetchFrom.toISOString(),
      contractType:   CHARGEABLE_TYPE,
    })).items;
  } catch (e) {
    items = [];
  }

  // Fallback: pull everything and match on lead.leadType ourselves. Also used
  // when the type filter silently matches nothing.
  let usedFallback = false;
  if (items.length === 0) {
    usedFallback = true;
    const all = unwrap(await apiPost(apiKey, '/Contracts/find', {
      dateAddedAfter: fetchFrom.toISOString(),
    })).items;
    const target = CHARGEABLE_TYPE.toLowerCase().trim();
    items = all.filter(c => {
      const t = ((c.lead && c.lead.leadType) || '').toLowerCase().trim();
      return t === target || t.includes('service contract');
    });
  }

  const set = new Set();
  items.forEach(c => { if (c.contractNumber) set.add(String(c.contractNumber).trim()); });
  return { set, usedFallback, matched: items.length };
}

// ── Netlify handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const API_KEY = process.env.BP_API_KEY;
  if (!API_KEY) {
    return json(500, { error: 'BP_API_KEY environment variable is not configured' });
  }

  const debug = !!(event && event.queryStringParameters && event.queryStringParameters.debug);

  try {
    const now = new Date();
    const currentFyStart = fyStart(now);
    // Reach back to the start of the PREVIOUS financial year so the dashboard
    // can show month-on-month and prior-year comparisons.
    const from = addMonths(currentFyStart, -12);
    const to   = addMonths(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), 1);

    const [calls, chargeable] = await Promise.all([
      fetchServiceCalls(API_KEY, from, to),
      fetchChargeableContractNumbers(API_KEY),
    ]);

    const mapped = calls.items.map(c => {
      const num    = String(c.contractNumber || '').trim();
      const status = (c.status || '').trim();
      return {
        id:              c.id,
        contractNumber:  num,
        customer:        (c.contractName || '').trim(),
        dateAdded:       c.dateAdded  || '',
        dateUpdated:     c.dateUpdated || '',
        status,
        isClosed:        CLOSED_STATUSES.includes(status.toLowerCase()),
        callType:        (c.callType || '').trim(),
        reason:          (c.primaryReasonForCall || '').trim(),
        lastAppointment: c.lastAppointmentDate || '',
        engineer:        (c.lastAppointmentFor || '').trim(),
        revisitRequired: !!c.revisitRequired,
        branch:          (c.branch && c.branch.branchName) || '',
        billing:         chargeable.set.has(num) ? 'Chargeable' : 'Warranty',
        monthKey:        c.dateAdded ? monthKey(new Date(c.dateAdded)) : '',
      };
    }).filter(c => c.dateAdded);

    if (debug) {
      const distinct = (key) => {
        const counts = {};
        mapped.forEach(c => { const v = c[key] || '(blank)'; counts[v] = (counts[v] || 0) + 1; });
        return counts;
      };
      const months = {};
      mapped.forEach(c => { months[c.monthKey] = (months[c.monthKey] || 0) + 1; });
      return json(200, {
        host: BASE_URL,
        rangeFrom: from.toISOString(),
        rangeTo: to.toISOString(),
        totalCalls: mapped.length,
        windowedFetch: calls.windowed,
        chargeableType: CHARGEABLE_TYPE,
        chargeableContractsMatched: chargeable.matched,
        chargeableUsedFallback: chargeable.usedFallback,
        statuses: distinct('status'),
        callTypes: distinct('callType'),
        billing: distinct('billing'),
        byMonth: months,
      });
    }

    return json(200, {
      generatedAt: new Date().toISOString(),
      fyStart:     currentFyStart.toISOString(),
      rangeFrom:   from.toISOString(),
      chargeableType: CHARGEABLE_TYPE,
      calls:       mapped,
    });

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
