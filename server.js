require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3002;

const SHOPIFY_HOST  = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const CT_ACCOUNT_ID = process.env.CT_ACCOUNT_ID;
const CT_PASSCODE   = process.env.CT_PASSCODE;
const CT_HOST       = 'in1.api.clevertap.com';

// ── IST date helpers ──────────────────────────────────────────────────────────

function istDate(daysAgo = 0) {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

// ── Shopify helpers ───────────────────────────────────────────────────────────

function shopifyGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: SHOPIFY_HOST,
        path: urlPath,
        method: 'GET',
        headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
      },
      (res) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try { resolve({ body: JSON.parse(data), link: res.headers['link'] || '' }); }
          catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function nextShopifyPath(link) {
  for (const part of link.split(',')) {
    if (part.includes('rel="next"')) {
      const m = part.match(/<([^>]+)>/);
      if (m) { const u = new URL(m[1]); return u.pathname + u.search; }
    }
  }
  return null;
}

const APP_SOURCE = '296686223361'; // HomeRun mobile app source_name

async function fetchOrdersForDate(dateStr) {
  const min = encodeURIComponent(`${dateStr}T00:00:00+05:30`);
  const max = encodeURIComponent(`${dateStr}T23:59:59+05:30`);
  let urlPath = `/admin/api/2024-01/orders.json?status=any&created_at_min=${min}&created_at_max=${max}&limit=250&fields=id,created_at,source_name,customer,line_items,shipping_address,note,tags`;
  const orders = [];
  while (urlPath) {
    const { body, link } = await shopifyGet(urlPath);
    orders.push(...(body.orders || []));
    urlPath = nextShopifyPath(link);
  }
  return orders;
}

// ── Business logic ────────────────────────────────────────────────────────────

// [1-9A-Z]? makes the check-digit before Z optional, catching 14-char entries missing one character
const GST_REGEX = /[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]?Z[0-9A-Z]/;

function isB2B(order) {
  const company = (order.shipping_address?.company || '').toUpperCase();
  if (!company) return false;
  // Match GST as-is, or after stripping spaces/commas (catches "29ABKFM, 5470D1Z2" style entries)
  return GST_REGEX.test(company) || GST_REGEX.test(company.replace(/[\s,]/g, ''));
}

function isBulkOrder(order) {
  return (order.line_items || []).some(
    item => Array.isArray(item.discount_allocations) && item.discount_allocations.length > 0
  );
}

// Tags accumulate (e.g. a 5-time buyer has _1 through _5 all present).
// Take the MAX number across all bulk_price_ordered_N tags to get true order count.
function getBulkOrderNumber(customer) {
  if (!customer?.tags) return 0;
  const tags = customer.tags.split(',').map(t => t.trim());
  const nums = tags
    .filter(t => /^bulk_price_ordered_\d+$/.test(t))
    .map(t => parseInt(t.split('_').pop(), 10));
  return nums.length ? Math.max(...nums) : 0;
}

function blankCounts() {
  return {
    totalOrders: 0, newCustomerOrders: 0, returningCustomerOrders: 0,
    b2bOrders: 0, b2cOrders: 0, b2bNewCustomers: 0, b2cNewCustomers: 0,
    totalBulkOrders: 0, firstTimeBulk: 0, repeatBulk: 0, b2bBulk: 0, b2cBulk: 0,
  };
}

function computeMetrics(orders) {
  const total = blankCounts();
  const app   = blankCounts();
  const web   = blankCounts();

  for (const order of orders) {
    const isApp = order.source_name === APP_SOURCE;
    const buckets = [total, isApp ? app : web];

    for (const m of buckets) m.totalOrders++;

    // customer.created_at matching order date identifies new customers
    // (Shopify creates customer accounts on first order; orders_count not in embedded object)
    const isNew = order.customer?.created_at?.slice(0, 10) === order.created_at?.slice(0, 10);
    const b2b   = isB2B(order);
    const bulk  = isBulkOrder(order);

    for (const m of buckets) {
      if (isNew) m.newCustomerOrders++;
      else m.returningCustomerOrders++;

      if (b2b) { m.b2bOrders++; if (isNew) m.b2bNewCustomers++; }
      else     { m.b2cOrders++; if (isNew) m.b2cNewCustomers++; }

      if (bulk) {
        m.totalBulkOrders++;
        if (b2b) m.b2bBulk++; else m.b2cBulk++;
        const n = getBulkOrderNumber(order.customer);
        if (n === 1)    m.firstTimeBulk++;
        else if (n > 1) m.repeatBulk++;
      }
    }
  }

  return { total, app, web };
}

// ── CleverTap helpers ─────────────────────────────────────────────────────────

function ctRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'X-CleverTap-Account-Id': CT_ACCOUNT_ID,
      'X-CleverTap-Passcode':   CT_PASSCODE,
    };
    if (payload) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: CT_HOST, path: urlPath, method, headers }, (res) => {
      let out = '';
      res.on('data', c => (out += c));
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch (e) { reject(new Error(`CT parse: ${out.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ctPoll(reqId, retries = 10, delayMs = 600) {
  for (let i = 0; i < retries; i++) {
    await sleep(delayMs);
    const r = await ctRequest('GET', `/1/counts/events.json?req_id=${reqId}`);
    if (r.status === 'success') return r;
    if (r.status === 'fail')    throw new Error(r.error || 'CT query failed');
  }
  throw new Error('CT polling timeout');
}

async function fetchCTCount(eventName, props, dateStr) {
  const d    = parseInt(dateStr.replace(/-/g, ''), 10);
  const body = { event_name: eventName, from: d, to: d };
  if (props && props.length) body.event_properties = props;
  try {
    const init = await ctRequest('POST', '/1/counts/events.json', body);
    if (init.status === 'success') return typeof init.count === 'number' ? init.count : null;
    if (!init.req_id)              throw new Error(`No req_id: ${JSON.stringify(init)}`);
    const result = await ctPoll(init.req_id);
    return typeof result.count === 'number' ? result.count : null;
  } catch (e) {
    console.error(`[CT] ${eventName}:`, e.message);
    return null;
  }
}

function getDatesInRange(from, to) {
  const dates = [];
  const cur   = new Date(from + 'T00:00:00Z');
  const end   = new Date(to   + 'T00:00:00Z');
  while (cur <= end && dates.length < 31) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const cache     = {};
const CACHE_TTL  = 15 * 60 * 1000;

const convCache = {};
const CONV_TTL  = 15 * 60 * 1000;

// ── Product → collection map (built from products CSV) ───────────────────────
// Keys are CT-searchable substrings (title up to first comma), values are collection names.
const PRODUCT_MAP = (() => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'data', 'product-map.json'), 'utf8');
    return JSON.parse(raw).map;
  } catch (e) {
    console.error('[product-map] failed to load:', e.message);
    return {};
  }
})();

// [ { key: 'Ultratech PPC Cement', collection: 'Cement' }, ... ]
const PRODUCT_ENTRIES = Object.entries(PRODUCT_MAP).map(([key, collection]) => ({ key, collection }));

// ── CT range count (from/to as date strings) ──────────────────────────────────

async function fetchCTCountRange(eventName, props, fromStr, toStr) {
  const f = parseInt(fromStr.replace(/-/g, ''), 10);
  const t = parseInt(toStr.replace(/-/g, ''), 10);
  const body = { event_name: eventName, from: f, to: t };
  if (props && props.length) body.event_properties = props;
  try {
    const init = await ctRequest('POST', '/1/counts/events.json', body);
    if (init.status === 'success') return typeof init.count === 'number' ? init.count : 0;
    if (!init.req_id) return 0;
    const result = await ctPoll(init.req_id);
    return typeof result.count === 'number' ? result.count : 0;
  } catch (e) {
    return 0;
  }
}

const appProductsCache = {};
const APP_PROD_TTL     = 30 * 60 * 1000;

function isFresh(entry) {
  return entry && Date.now() - entry.ts < CACHE_TTL;
}

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/metrics', async (req, res) => {
  try {
    // D-7 = same day last week = 7 days before D-1 = 8 days before today
    const d1 = istDate(1);
    const d2 = istDate(2);
    const d7 = istDate(8);

    if (isFresh(cache[d1])) {
      return res.json({ success: true, ...cache[d1].payload, cached: true });
    }

    const [orders1, orders2, orders7] = await Promise.all([
      fetchOrdersForDate(d1),
      fetchOrdersForDate(d2),
      fetchOrdersForDate(d7),
    ]);

    const payload = {
      dates:   { d1, d2, d7 },
      metrics: {
        d1: computeMetrics(orders1),
        d2: computeMetrics(orders2),
        d7: computeMetrics(orders7),
      },
      fetchedAt: new Date().toISOString(),
    };

    cache[d1] = { payload, ts: Date.now() };
    res.json({ success: true, ...payload, cached: false });
  } catch (err) {
    console.error('[/api/metrics]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Conversion funnel API ─────────────────────────────────────────────────────

app.get('/api/conversion', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ success: false, error: 'from and to required' });

  const todayStr      = istDate(0);
  const rangeHasToday = getDatesInRange(from, to).includes(todayStr);
  const cacheKey      = `${from}_${to}`;

  if (!rangeHasToday && convCache[cacheKey] && Date.now() - convCache[cacheKey].ts < CONV_TTL) {
    return res.json({ success: true, data: convCache[cacheKey].data, cached: true });
  }

  try {
    const dates = getDatesInRange(from, to);
    const data  = [];

    for (const dateStr of dates) {
      const [
        webSessions, productAdded, cartPage,   webOrders,
        appLaunched, cartScreen,   appOrders,
      ] = await Promise.all([
        fetchCTCount('Web Session Started', null, dateStr),
        fetchCTCount('Added to Cart',       null, dateStr),
        fetchCTCount('Page Browsed',   [{ name: 'Title',     operator: 'equals', value: 'Your Shopping Cart' }], dateStr),
        fetchCTCount('Order Created',  [{ name: 'CT Source', operator: 'equals', value: 'Web' }],               dateStr),
        fetchCTCount('App Launched',   null, dateStr),
        fetchCTCount('Screen Loaded',  [{ name: 'name',      operator: 'equals', value: 'Cart' }],              dateStr),
        fetchCTCount('Order Placed',   null, dateStr),
      ]);

      data.push({
        date: dateStr,
        web:  { sessions: webSessions, productAdded, cartPage,   orders: webOrders  },
        app:  { launched: appLaunched, productAdded, cartScreen, orders: appOrders  },
      });
    }

    if (!rangeHasToday) convCache[cacheKey] = { data, ts: Date.now() };
    res.json({ success: true, data });
  } catch (err) {
    console.error('[/api/conversion]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── App Product Added by category ────────────────────────────────────────────

app.get('/api/app-products', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ success: false, error: 'from and to required' });

  const cacheKey = `v2_${from}_${to}`;
  const cached   = appProductsCache[cacheKey];
  if (cached && Date.now() - cached.ts < APP_PROD_TTL) {
    return res.json({ success: true, app: cached.app, web: cached.web, categories: cached.categories, cached: true });
  }

  try {
    const dates      = getDatesInRange(from, to);
    const BATCH      = 50;
    // CT SDK is CleverTap's auto-set property: 'Web' for browser events
    const WEB_FILTER = [{ name: 'CT SDK', operator: 'equals', value: 'Web' }];

    const aRows = [], wRows = [];
    await Promise.all(dates.map(async (dateStr) => {
      const appTotals = {};
      const webTotals = {};

      for (let i = 0; i < PRODUCT_ENTRIES.length; i += BATCH) {
        const slice = PRODUCT_ENTRIES.slice(i, i + BATCH);
        const [appRes, webRes] = await Promise.all([
          // App = total (no SDK filter — overwhelmingly mobile)
          Promise.all(slice.map(({ key }) =>
            fetchCTCount('Added to Cart', [{ name: 'title', operator: 'contains', value: key }], dateStr)
          )),
          Promise.all(slice.map(({ key }) =>
            fetchCTCount('Added to Cart', [{ name: 'title', operator: 'contains', value: key }, ...WEB_FILTER], dateStr)
          )),
        ]);
        slice.forEach(({ collection }, j) => {
          appTotals[collection] = (appTotals[collection] || 0) + (appRes[j] || 0);
          webTotals[collection] = (webTotals[collection] || 0) + (webRes[j] || 0);
        });
      }

      const toRow = (totals) => {
        const row = { date: dateStr };
        for (const [k, v] of Object.entries(totals)) if (v > 0) row[k] = v;
        return row;
      };
      aRows.push(toRow(appTotals));
      wRows.push(toRow(webTotals));
    }));

    const sort    = rows => rows.sort((a, b) => a.date.localeCompare(b.date));
    const appRows = sort(aRows);
    const webRows = sort(wRows);

    const totals = {};
    for (const row of appRows) {
      for (const [k, v] of Object.entries(row)) {
        if (k !== 'date') totals[k] = (totals[k] || 0) + v;
      }
    }
    const categories = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);

    appProductsCache[cacheKey] = { app: appRows, web: webRows, categories, ts: Date.now() };
    res.json({ success: true, app: appRows, web: webRows, categories });
  } catch (err) {
    console.error('[/api/app-products]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ATC diagnostic: test which filter gives web data ─────────────────────────

app.get('/api/debug-atc', async (req, res) => {
  const date = req.query.date || istDate(1);
  const filters = [
    { label: 'no filter (total)',        props: null },
    { label: 'CT SDK = Web',             props: [{ name: 'CT SDK',    operator: 'equals', value: 'Web'     }] },
    { label: 'CT SDK = Android',         props: [{ name: 'CT SDK',    operator: 'equals', value: 'Android' }] },
    { label: 'CT SDK = iOS',             props: [{ name: 'CT SDK',    operator: 'equals', value: 'iOS'     }] },
    { label: 'CT Source = Web',          props: [{ name: 'CT Source', operator: 'equals', value: 'Web'     }] },
    { label: 'source = web',             props: [{ name: 'source',    operator: 'equals', value: 'web'     }] },
    { label: 'platform = web',           props: [{ name: 'platform',  operator: 'equals', value: 'web'     }] },
    { label: 'platform = Web',           props: [{ name: 'platform',  operator: 'equals', value: 'Web'     }] },
  ];
  const results = {};
  for (const { label, props } of filters) {
    results[label] = await fetchCTCount('Added to Cart', props, date);
  }
  res.json({ date, results });
});

// ── Static + start ────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  ◆ HomeRun Daily Dashboard\n  → http://localhost:${PORT}\n`);
  });
}

module.exports = app;
