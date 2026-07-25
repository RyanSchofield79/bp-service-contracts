'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Netlify serverless function — Business Pilot SERVICE CALLS
//
// Host: open-api.businesspilot.co.uk  (the new BPO "Scalar" Open API)
//   • Auth header is still  X-Api-Key
//   • Paths are still       /api/<Controller>/<action>   (POST)
//   • Responses are still   [ { items: [...], itemCount: n } ]
//   • The new API has NO page / pageSize parameters — one request returns the
//     whole matching set, so nothing can be silently cut off part way down.
//   • IMPORTANT: /ServiceCalls/find currently IGNORES dateAddedAfter /
//     dateAddedBefore and returns the full history, so the date window is
//     always re-applied here in code.
//
// Chargeable vs warranty:
//   A service call is CHARGEABLE when its contract is of the service-contract
//   type (default "12. Service Contract"); every other call is WARRANTY.
//
// Debug probes (read-only, fixed allow-list):
//   ?debug=1          call-level diagnostics (statuses, call types, by month)
//   ?debug=leadtypes  the LeadTypes list, so the exact type string is visible
//   ?debug=contracts  contract-type filter result + leadType/pipeline tallies
// ─────────────────────────────────────────────────────────────────────────────
const https = require('https');

const BASE_URL = 'open-api.businesspilot.co.uk';

// The contract type that makes a service call chargeable.
// Override without a code change via the CHARGEABLE_CONTRACT_TYPE env var.
const CHARGEABLE_TYPE = process.env.CHARGEABLE_CONTRACT_TYPE || '12. Service Contract';

// Statuses that count as "closed". Everything else counts as open.
const CLOSED_STATUSES = ['closed', 'cancelled', 'canceled', 'complete', 'completed'];

// Warm-lambda cache — the upstream calls are heavy, so hold results briefly.
const TTL_MS = 10 * 60 * 1000;
const cache = { calls: null, contracts: null };
function cached(key) {
  const e = cache[key];
  return e && (Date.now() - e.at) < TTL_MS ? e.value : null;
}
function store(key, value) { cache[key] = { at: Date.now(), value }; return value; }

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
    req.setTimeout(25000, () => req.destroy(new Error(`Timeout calling ${endpoint}`)));
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
function tally(list, fn, limit) {
  const o = {};
  list.forEach(x => { const v = fn(x) || '(blank)'; o[v] = (o[v] || 0) + 1; });
  return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, limit || 40));
}

// ── Service calls (whole history, cached) ────────────────────────────────────
async function allServiceCalls(apiKey) {
  const hit = cached('calls');
  if (hit) return hit;
  const r = unwrap(await apiPost(apiKey, '/ServiceCalls/find', {}));
  return store('calls', { items: r.items, itemCount: r.itemCount });
}

// ── Contracts (whole history, cached) ────────────────────────────────────────
async function allContracts(apiKey) {
  const hit = cached('contracts');
  if (hit) return hit;
  const r = unwrap(await apiPost(apiKey, '/Contracts/find', {}));
  return store('contracts', { items: r.items, itemCount: r.itemCount });
}

// Contract numbers whose contract is a chargeable service contract.
function chargeableSet(contracts) {
  const target = CHARGEABLE_TYPE.toLowerCase().trim();
  const set = new Set();
  let matched = 0;
  contracts.forEach(c => {
    const lead = c.lead || {};
    const t = String(lead.leadType || '').toLowerCase().trim();
    const p = String(c.currentPipeline || '').toLowerCase().trim();
    if (t === target || t.includes('service contract') || p.includes('service contract')) {
      matched++;
      if (c.contractNumber) set.add(String(c.contractNumber).trim());
    }
  });
  return { set, matched };
}

// ── Netlify handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const API_KEY = process.env.BP_API_KEY;
  if (!API_KEY) return json(500, { error: 'BP_API_KEY environment variable is not configured' });

  const q     = (event && event.queryStringParameters) || {};
  const debug = q.debug || '';

  try {
    // ── targeted read-only probes ────────────────────────────────────────────
    if (debug === 'leadtypes') {
      const [lt, pt] = await Promise.all([
        apiPost(API_KEY, '/LeadTypes/find', {}).catch(e => ({ error: e.message })),
        apiPost(API_KEY, '/ProjectTypes/find', {}).catch(e => ({ error: e.message })),
      ]);
      return json(200, { leadTypes: lt, projectTypes: pt });
    }

    if (debug === 'contracts') {
      const type = q.type || CHARGEABLE_TYPE;
      const filtered = await apiPost(API_KEY, '/Contracts/find', { contractType: type })
        .then(unwrap).catch(e => ({ error: e.message, items: [], itemCount: 0 }));
      const all = await allContracts(API_KEY);
      const sample = all.items[0] || {};
      return json(200, {
        typeTried:          type,
        filteredCount:      filtered.items.length,
        filteredItemCount:  filtered.itemCount,
        filteredError:      filtered.error || null,
        filteredSampleNums: filtered.items.slice(0, 5).map(c => c.contractNumber),
        allContracts:       all.items.length,
        allItemCount:       all.itemCount,
        contractKeys:       Object.keys(sample),
        leadKeys:           Object.keys(sample.lead || {}),
        leadTypes:          tally(all.items, c => (c.lead || {}).leadType),
        pipelines:          tally(all.items, c => c.currentPipeline),
        matchedByRule:      chargeableSet(all.items).matched,
      });
    }

    // ── main path ────────────────────────────────────────────────────────────
    const now            = new Date();
    const currentFyStart = fyStart(now);
    // Reach back to the start of the PREVIOUS financial year so the dashboard
    // can show month-on-month and prior-year comparisons.
    const from = addMonths(currentFyStart, -12);
    const to   = addMonths(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), 1);

    const [callsRaw, contractsRaw] = await Promise.all([
      allServiceCalls(API_KEY),
      allContracts(API_KEY).catch(() => ({ items: [], itemCount: 0 })),
    ]);

    const { set: chargeable, matched } = chargeableSet(contractsRaw.items);

    const inRange = (c) => {
      if (!c.dateAdded) return false;
      const d = new Date(c.dateAdded);
      return d >= from && d < to;
    };

    const mapped = callsRaw.items.filter(inRange).map(c => {
      const numRaw = String(c.contractNumber || '').trim();
      const status = String(c.status || '').trim();
      return {
        id:              c.id,
        contractNumber:  numRaw,
        customer:        String(c.contractName || '').trim(),
        dateAdded:       c.dateAdded || '',
        status,
        isClosed:        CLOSED_STATUSES.includes(status.toLowerCase()),
        callType:        String(c.callType || '').trim(),
        lastAppointment: c.lastAppointmentDate || '',
        engineer:        String(c.lastAppointmentFor || '').trim(),
        billing:         chargeable.has(numRaw) ? 'Chargeable' : 'Warranty',
        monthKey:        monthKey(new Date(c.dateAdded)),
      };
    });

    if (debug) {
      return json(200, {
        host:               BASE_URL,
        rangeFrom:          from.toISOString(),
        rangeTo:            to.toISOString(),
        callsInHistory:     callsRaw.items.length,
        callsItemCount:     callsRaw.itemCount,
        callsInRange:       mapped.length,
        contractsFetched:   contractsRaw.items.length,
        contractsItemCount: contractsRaw.itemCount,
        chargeableType:     CHARGEABLE_TYPE,
        chargeableContracts: chargeable.size,
        matchedByRule:      matched,
        statuses:           tally(mapped, c => c.status),
        callTypes:          tally(mapped, c => c.callType),
        billing:            tally(mapped, c => c.billing),
        byMonth:            tally(mapped, c => c.monthKey, 30),
      });
    }

    return json(200, {
      generatedAt:    new Date().toISOString(),
      fyStart:        currentFyStart.toISOString(),
      rangeFrom:      from.toISOString(),
      chargeableType: CHARGEABLE_TYPE,
      calls:          mapped,
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
