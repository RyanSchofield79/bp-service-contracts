'use strict';
const https = require('https');

const BASE_URL  = 'api-zapier.businesspilot.co.uk';
const PAGE_SIZE = 500;

// ── Low-level HTTPS POST to the BP API ────────────────────────────────────────────
function apiPost(apiKey, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
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
    req.write(payload);
    req.end();
  });
}

// ── Fetch all contracts (paginated) ─────────────────────────────────────────────────
async function fetchAllContracts(apiKey) {
  const fetchFrom = new Date();
  fetchFrom.setFullYear(fetchFrom.getFullYear() - 5);
  const fetchFromISO = fetchFrom.toISOString();

  let all  = [];
  let page = 1;

  while (true) {
    const resp = await apiPost(apiKey, '/Contracts/find', {
      dateAddedAfter: fetchFromISO,
      page,
      pageSize: PAGE_SIZE,
    });

    const result    = Array.isArray(resp) ? resp[0] : resp;
    const items     = result.items     || [];
    const itemCount = result.itemCount || 0;

    if (items.length === 0) break;  // no items → done

    all = all.concat(items);

    // Three stop conditions:
    // 1. We received fewer items than requested → this is the last page
    //    (handles APIs that ignore pageSize and return their own default)
    // 2. We have collected at least as many items as itemCount says exist
    // 3. Guard: no more pages possible
    if (items.length < PAGE_SIZE) break;
    if (all.length >= itemCount)  break;

    page++;
  }

  return all;
}

// ── Netlify handler ────────────────────────────────────────────────────────────
exports.handler = async (event, context) => {
  const API_KEY = process.env.BP_API_KEY;

  if (!API_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'BP_API_KEY environment variable is not configured' }),
    };
  }

  try {
    const raw = await fetchAllContracts(API_KEY);

    // Map to the fields the dashboard needs
    const mapped = raw.map(c => {
      const lead    = c.lead    || {};
      const contact = lead.contact || {};
      return {
        contractNumber:     String(c.contractNumber || ''),
        customer:           (contact.contactName || contact.companyName || '').trim(),
        contractStatus:     c.currentStatus         || '',
        contractStatusDate: c.currentStatusDate      || '',
        productType:        lead.productType1 || lead.productType2 || lead.productType3 || '',
        netValue:           parseFloat(c.confirmedNetSaleValue) || 0,
        balance:            parseFloat(c.balance || c.balanceDue) || 0,
        installStart:       c.installStart           || '',
        contractType:       lead.leadType            || '',
        currentPipeline:    c.currentPipeline        || '',
      };
    });

    // Keep only live service contracts
    const contracts = mapped.filter(c => {
      const pipeline = (c.currentPipeline || '').toLowerCase();
      const type     = (c.contractType    || '').toLowerCase();

      // Must be in the service pipeline or have service lead type
      if (!pipeline.includes('service') && !type.includes('service')) return false;

      // Exclude completed / cancelled / on hold
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
