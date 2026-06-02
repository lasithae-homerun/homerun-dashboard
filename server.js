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

async function fetchOrdersInRange(fromDate, toDate) {
  const min = encodeURIComponent(`${fromDate}T00:00:00+05:30`);
  const max = encodeURIComponent(`${toDate}T23:59:59+05:30`);
  let urlPath = `/admin/api/2024-01/orders.json?status=any&created_at_min=${min}&created_at_max=${max}&limit=250&fields=id,source_name,line_items`;
  const orders = [];
  while (urlPath) {
    const { body, link } = await shopifyGet(urlPath);
    orders.push(...(body.orders || []));
    urlPath = nextShopifyPath(link);
  }
  return orders;
}

async function fetchOrdersForBasket(fromDate, toDate) {
  const min = encodeURIComponent(`${fromDate}T00:00:00+05:30`);
  const max = encodeURIComponent(`${toDate}T23:59:59+05:30`);
  let urlPath = `/admin/api/2024-01/orders.json?status=any&created_at_min=${min}&created_at_max=${max}&limit=250&fields=id,total_price,customer,shipping_address,line_items`;
  const orders = [];
  while (urlPath) {
    const { body, link } = await shopifyGet(urlPath);
    orders.push(...(body.orders || []));
    urlPath = nextShopifyPath(link);
  }
  return orders;
}

// Shopify's embedded customer in Orders API doesn't include orders_count.
// Fetch it separately in batches of 250 by customer ID.
async function fetchCustomerOrderCounts(customerIds) {
  const counts = new Map();
  const ids = [...customerIds].filter(Boolean);
  for (let i = 0; i < ids.length; i += 250) {
    const batch = ids.slice(i, i + 250).join(',');
    const { body } = await shopifyGet(`/admin/api/2024-01/customers.json?ids=${batch}&limit=250&fields=id,orders_count`);
    for (const c of (body.customers || [])) {
      counts.set(String(c.id), c.orders_count ?? 1);
    }
  }
  return counts;
}

// ── Business logic ────────────────────────────────────────────────────────────

function isB2B(order) {
  const company = (order.shipping_address?.company || '').trim();
  if (!company) return false;
  // Strip spaces/commas then check: alphanumeric only AND contains both letters and digits
  const s = company.replace(/[\s,]/g, '');
  return /^[A-Za-z0-9]+$/.test(s) && /[A-Za-z]/.test(s) && /[0-9]/.test(s);
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

async function ctPollProfiles(reqId, retries = 10, delayMs = 600) {
  for (let i = 0; i < retries; i++) {
    await sleep(delayMs);
    const r = await ctRequest('GET', `/1/counts/profiles.json?req_id=${reqId}`);
    if (r.status === 'success') return r;
    if (r.status === 'fail')    throw new Error(r.error || 'CT profile count failed');
  }
  throw new Error('CT profile count polling timeout');
}

// Convert IST datetime string ("2026-05-31T00:00:00") to Unix seconds
function istToUnix(dtStr) {
  const s = dtStr.length > 10 ? dtStr : dtStr + 'T00:00:00';
  return Math.floor(new Date(s + '+05:30').getTime() / 1000);
}

// Normalise a CT timestamp to Unix seconds.
// CT's profiles export stores last_seen as a 14-digit YYYYMMDDHHMMSS string (IST).
// Event exports use the same format. Unix seconds are 10-digit.
function ctTsToUnix(ts) {
  if (!ts) return 0;
  const s = String(ts);
  if (s.length === 14) {
    return Math.floor(
      new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}+05:30`).getTime() / 1000
    );
  }
  const n = Number(ts);
  if (!isFinite(n) || n <= 0) return 0;
  return n > 1e11 ? Math.floor(n / 1000) : n; // handle ms just in case
}

// Count unique users who fired eventName ≥1 times in [fromISO, toISO] (IST datetimes)
async function fetchProfileCount(eventName, fromISO, toISO, eventProperties = null) {
  const ef = { name: eventName, from: istToUnix(fromISO), to: istToUnix(toISO), operator: 'ge', value: 1 };
  if (eventProperties) ef.event_properties = eventProperties;
  const body = { event_filters: [ef], profile_filters: [] };
  try {
    const init = await ctRequest('POST', '/1/counts/profiles.json', body);
    if (init.status === 'success') return typeof init.count === 'number' ? init.count : null;
    if (!init.req_id) throw new Error(`No req_id: ${JSON.stringify(init).slice(0, 200)}`);
    const result = await ctPollProfiles(init.req_id);
    return typeof result.count === 'number' ? result.count : null;
  } catch (e) {
    console.error(`[CT profile count] ${eventName}:`, e.message);
    return null;
  }
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

// Export all records for an event in a date range via cursor pagination
async function exportCTEvents(eventName, fromD, toD) {
  const init = await ctRequest('POST', '/1/events.json', { event_name: eventName, from: fromD, to: toD });
  if (!init.cursor) throw new Error(`Events export no cursor for ${eventName}: ${JSON.stringify(init).slice(0, 200)}`);
  const records = [];
  let cursor = init.cursor;
  while (cursor) {
    const page = await ctRequest('GET', `/1/events.json?cursor=${cursor}`);
    records.push(...(page.records || []));
    cursor = page.next_cursor || page.cursor || null;
  }
  return records;
}

// Decode HTML entities from CT-stored strings (&amp; → &)
function htmlDecode(str) {
  return typeof str === 'string' ? str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
}

// Match a CT product title to a category using the product-map
function matchCategory(rawTitle) {
  if (!rawTitle) return null;
  const title = htmlDecode(rawTitle).toLowerCase();
  for (const { key, collection } of PRODUCT_ENTRIES) {
    if (title.includes(key.toLowerCase())) return collection;
  }
  return null;
}

// Convert CT YYYYMMDDHHMMSS timestamp (14-digit number) to YYYY-MM-DD
function tsToISTDate(ts) {
  const s = String(ts);
  if (s.length < 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

async function fetchCTCountRange(eventName, eventProps, profileFilters, fromD, toD) {
  const body = { event_name: eventName, from: fromD, to: toD };
  if (eventProps     && eventProps.length)     body.event_properties = eventProps;
  if (profileFilters && profileFilters.length) body.profile_filters  = profileFilters;
  try {
    const init = await ctRequest('POST', '/1/counts/events.json', body);
    if (init.status === 'success') return typeof init.count === 'number' ? init.count : null;
    if (!init.req_id)              throw new Error(`No req_id: ${JSON.stringify(init)}`);
    const result = await ctPoll(init.req_id);
    return typeof result.count === 'number' ? result.count : null;
  } catch (e) {
    console.error(`[CT range] ${eventName}:`, e.message);
    return null;
  }
}

function getDatesInRange(from, to) {
  const dates = [];
  const cur   = new Date(from.slice(0, 10) + 'T00:00:00Z');
  const end   = new Date(to.slice(0, 10)   + 'T00:00:00Z');
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


const appProductsCache = {};
const APP_PROD_TTL     = 30 * 60 * 1000;

// Shopify product/variant ID → product title map (lazy, 6h TTL)
// CT events store product_id as either a Product GID or ProductVariant GID — map both.
let productLookupCache = null;
let productLookupFetchedAt = 0;
const PRODUCT_LOOKUP_TTL = 6 * 60 * 60 * 1000;

async function getProductLookup() {
  if (productLookupCache && Date.now() - productLookupFetchedAt < PRODUCT_LOOKUP_TTL) return productLookupCache;
  const map = {};
  let url = '/admin/api/2024-01/products.json?limit=250&fields=id,title,variants';
  while (url) {
    const { body, link } = await shopifyGet(url);
    for (const p of body.products || []) {
      map[String(p.id)] = p.title;
      for (const v of p.variants || []) {
        map[String(v.id)] = p.title;
      }
    }
    url = nextShopifyPath(link);
  }
  productLookupCache = map;
  productLookupFetchedAt = Date.now();
  console.log(`[product-lookup] built ${Object.keys(map).length} entries`);
  return map;
}

// Extract numeric ID from a Shopify GID string or plain ID
function extractShopifyId(gidOrId) {
  if (!gidOrId) return null;
  const s = String(gidOrId);
  const m = s.match(/(\d+)$/);
  return m ? m[1] : null;
}

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
        webSessions, webProductAdded, cartPage,   webOrders,
        appLaunched, appProductAdded, cartScreen, appOrders,
      ] = await Promise.all([
        fetchCTCount('Web Session Started', null, dateStr),
        fetchCTCount('Added to Cart',       null, dateStr),   // web ATC event
        fetchCTCount('Page Browsed',   [{ name: 'Title',     operator: 'equals', value: 'Your Shopping Cart' }], dateStr),
        fetchCTCount('Order Created',  [{ name: 'CT Source', operator: 'equals', value: 'Web' }],               dateStr),
        fetchCTCount('App Launched',   null, dateStr),
        fetchCTCount('Product Added',  null, dateStr),        // app ATC event
        fetchCTCount('Screen Loaded',  [{ name: 'name',      operator: 'equals', value: 'Cart' }],              dateStr),
        fetchCTCount('Order Placed',   null, dateStr),
      ]);

      data.push({
        date: dateStr,
        web:  { sessions: webSessions, productAdded: webProductAdded, cartPage,   orders: webOrders  },
        app:  { launched: appLaunched, productAdded: appProductAdded, cartScreen, orders: appOrders  },
      });
    }

    if (!rangeHasToday) convCache[cacheKey] = { data, ts: Date.now() };
    res.json({ success: true, data });
  } catch (err) {
    console.error('[/api/conversion]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── App/Web Product Added by category ────────────────────────────────────────

app.get('/api/app-products', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ success: false, error: 'from and to required' });

  const cacheKey = `v17_${from.slice(0, 10)}_${to.slice(0, 10)}`;
  const cached   = appProductsCache[cacheKey];
  if (cached && Date.now() - cached.ts < APP_PROD_TTL) {
    return res.json({ success: true, app: cached.app, web: cached.web, categories: cached.categories, appSkusOrdered: cached.appSkusOrdered, webSkusOrdered: cached.webSkusOrdered, cached: true });
  }

  try {
    const fromD = parseInt(from.slice(0, 10).replace(/-/g, ''), 10);
    const toD   = parseInt(to.slice(0, 10).replace(/-/g, ''), 10);
    const dates = getDatesInRange(from, to);

    // Export all events + product lookup + orders in parallel
    const [appEvents, webEvents, productLookup, orders] = await Promise.all([
      exportCTEvents('Product Added', fromD, toD),
      exportCTEvents('Added to Cart', fromD, toD),
      getProductLookup(),
      fetchOrdersInRange(from.slice(0, 10), to.slice(0, 10)),
    ]);

    // Resolve Shopify product title from CT event_props.
    // App events:  product_id (Product or Variant GID), variant_id (Variant GID), variant (Variant GID or option string)
    // Web events:  'Product ID' / 'Variant ID' (plain numeric, no GID prefix)
    function resolveTitle(props) {
      const pid = extractShopifyId(props?.product_id || props?.['Product ID']);
      const vid = extractShopifyId(props?.variant_id || props?.['Variant ID']) || extractShopifyId(props?.variant);
      return (pid && productLookup[pid]) || (vid && productLookup[vid]) || null;
    }

    // Build per-date row maps
    const appMap = {}, webMap = {};
    for (const d of dates) { appMap[d] = { date: d }; webMap[d] = { date: d }; }

    for (const ev of appEvents) {
      const d = tsToISTDate(ev.ts);
      if (!appMap[d]) continue;
      // Shopify lookup (product_id / variant_id) wins; CT product_name as fallback
      const resolved = resolveTitle(ev.event_props);
      const cat = matchCategory(resolved || '')
        || matchCategory(ev.event_props?.product_name || '')
        || 'Other';
      appMap[d][cat] = (appMap[d][cat] || 0) + 1;
    }

    for (const ev of webEvents) {
      const d = tsToISTDate(ev.ts);
      if (!webMap[d]) continue;
      // Web: Shopify lookup by Product ID/Variant ID first; CT Title+VariantTitle as fallback
      const resolved = resolveTitle(ev.event_props);
      const ctTitle = [
        ev.event_props?.Title || ev.event_props?.title || '',
        ev.event_props?.['Variant Title'] || '',
      ].filter(Boolean).join(' ');
      const cat = matchCategory(resolved || '')
        || matchCategory(ctTitle)
        || 'Other';
      webMap[d][cat] = (webMap[d][cat] || 0) + 1;
    }

    const appRows = dates.map(d => appMap[d]);
    const webRows = dates.map(d => webMap[d]);

    // Sort categories by app total desc; "Other" always last
    const totals = {};
    for (const row of appRows) {
      for (const [k, v] of Object.entries(row)) {
        if (k !== 'date') totals[k] = (totals[k] || 0) + v;
      }
    }
    const categories = Object.keys(totals).filter(k => k !== 'Other').sort((a, b) => totals[b] - totals[a]);
    if (totals['Other']) categories.push('Other');

    // Unique SKUs ordered per collection, split by sales channel (app vs web)
    const appSkuSets = {}, webSkuSets = {};
    for (const order of orders) {
      const sets = order.source_name === APP_SOURCE ? appSkuSets : webSkuSets;
      for (const item of order.line_items || []) {
        const pid = String(item.product_id || '');
        const vid = String(item.variant_id || '');
        const cat = matchCategory(item.title || '')
          || (pid && matchCategory(productLookup[pid] || ''))
          || (vid && matchCategory(productLookup[vid] || ''))
          || 'Other';
        if (!sets[cat]) sets[cat] = new Set();
        sets[cat].add(item.sku || vid || `${pid}-${vid}`);
      }
    }
    const appSkusOrdered = {}, webSkusOrdered = {};
    for (const [cat, s] of Object.entries(appSkuSets)) appSkusOrdered[cat] = s.size;
    for (const [cat, s] of Object.entries(webSkuSets)) webSkusOrdered[cat] = s.size;

    appProductsCache[cacheKey] = { app: appRows, web: webRows, categories, appSkusOrdered, webSkusOrdered, ts: Date.now() };
    res.json({ success: true, app: appRows, web: webRows, categories, appSkusOrdered, webSkusOrdered });
  } catch (err) {
    console.error('[/api/app-products]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── App User Segments (by order count × active/churned) ──────────────────
// CT's counts API ignores profile_filters; use profiles export instead.
// Each profile record includes lifetime event data (count + last_seen per event).
// OC bucket  ← events['Order Placed'].count (or 'Charged' as fallback)
// Active     ← last purchase event last_seen > 30 days ago cutoff

const userSegsCache = {};
const USER_SEGS_TTL = 30 * 60 * 1000;

async function exportCTProfiles(eventName, fromD, toD, eventProperties = null, profileFilters = null) {
  const body = { event_name: eventName, from: fromD, to: toD };
  if (eventProperties) body.event_properties = eventProperties;
  if (profileFilters)  body.profile_filters  = profileFilters;
  const init = await ctRequest('POST', '/1/profiles.json', body);
  if (!init.cursor) throw new Error(`Profiles export no cursor: ${JSON.stringify(init).slice(0, 200)}`);
  const seen = new Set();
  const profiles = [];
  let cursor = init.cursor;
  while (cursor) {
    const page = await ctRequest('GET', `/1/profiles.json?cursor=${cursor}`);
    for (const p of (page.records || [])) {
      const id = p.objectId || p.identity || JSON.stringify(p).slice(0, 80);
      if (!seen.has(id)) { seen.add(id); profiles.push(p); }
    }
    cursor = page.next_cursor || page.cursor || null;
  }
  return profiles;
}

function ocBucket(profile) {
  const ev  = profile.events || {};
  const oc  = ev['Order Placed']?.count || ev['Charged']?.count || 0;
  if (oc >= 5) return 'OC=5+';
  return `OC=${oc}`;
}

function isActive(profile, cutoffSec) {
  const ev   = profile.events || {};
  const last = Math.max(ev['Order Placed']?.last_seen || 0, ev['Charged']?.last_seen || 0);
  return last > cutoffSec;
}

app.get('/api/user-segments', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ success: false, error: 'from and to required' });

  const cacheKey = `userseg_v2_${from.slice(0, 10)}_${to.slice(0, 10)}`;
  const cached   = userSegsCache[cacheKey];
  if (cached && Date.now() - cached.ts < USER_SEGS_TTL) {
    return res.json({ success: true, active: cached.active, churned: cached.churned, cached: true });
  }

  const fromD      = parseInt(from.slice(0, 10).replace(/-/g, ''), 10);
  const toD        = parseInt(to.slice(0, 10).replace(/-/g, ''), 10);
  const cutoffSec  = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const OC_LABELS  = ['OC=0', 'OC=1', 'OC=2', 'OC=3', 'OC=4', 'OC=5+'];

  try {
    const [appProfiles, atcProfiles, orderProfiles] = await Promise.all([
      exportCTProfiles('App Launched',  fromD, toD),
      exportCTProfiles('Product Added', fromD, toD),
      exportCTProfiles('Order Placed',  fromD, toD),
    ]);

    // Build empty buckets
    const mkBuckets = () => Object.fromEntries(OC_LABELS.map(b => [b, { oc: b, appLaunched: 0, atc: 0, orderPlaced: 0 }]));
    const active  = mkBuckets();
    const churned = mkBuckets();

    for (const p of appProfiles) {
      const row = isActive(p, cutoffSec) ? active : churned;
      row[ocBucket(p)].appLaunched++;
    }
    for (const p of atcProfiles) {
      const row = isActive(p, cutoffSec) ? active : churned;
      row[ocBucket(p)].atc++;
    }
    for (const p of orderProfiles) {
      const row = isActive(p, cutoffSec) ? active : churned;
      row[ocBucket(p)].orderPlaced++;
    }

    const result = {
      active:  OC_LABELS.map(b => active[b]),
      churned: OC_LABELS.map(b => churned[b]),
    };

    userSegsCache[cacheKey] = { ...result, ts: Date.now() };
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[/api/user-segments]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Lifecycle Segments ─────────────────────────────────────────────────────────

// B2B user IDs are pre-fetched via CT profiles export (GSTIN exists filter) because
// the events export only embeds a subset of profileData and often omits custom properties.
let   b2bUserIds    = new Set();
let   b2bIdsFetchTs = 0;
const B2B_IDS_TTL   = 6 * 60 * 60 * 1000; // refresh every 6 hours

async function ensureB2BIds() {
  if (Date.now() - b2bIdsFetchTs < B2B_IDS_TTL) return;
  try {
    const init = await ctRequest('POST', '/1/profiles.json', {
      profile_filters: [{ name: 'GSTIN', operator: 'exists' }],
    });
    if (!init.cursor) {
      console.warn('[B2B IDs] no cursor from profiles export, skipping');
      b2bIdsFetchTs = Date.now();
      return;
    }
    const ids = new Set();
    let cursor = init.cursor;
    while (cursor) {
      const page = await ctRequest('GET', `/1/profiles.json?cursor=${cursor}`);
      for (const p of (page.records || [])) {
        const id = p.identity || p.objectId;
        if (id) ids.add(String(id));
      }
      cursor = page.next_cursor || null;
    }
    b2bUserIds    = ids;
    b2bIdsFetchTs = Date.now();
    console.log(`[B2B IDs] fetched ${ids.size} B2B users (GSTIN exists)`);
  } catch (e) {
    console.error('[B2B IDs] fetch failed:', e.message);
    b2bIdsFetchTs = Date.now(); // don't retry immediately
  }
}

const lifecycleCache = {};
const LIFECYCLE_TTL  = 60 * 60 * 1000;
const LC_SEG_KEYS    = [
  'overall',
  'b2c_new', 'b2c_early', 'b2c_active', 'b2c_power', 'b2c_churned',
  'b2b_new', 'b2b_early', 'b2b_active', 'b2b_power', 'b2b_churned',
];

// B2B detection: check pre-fetched b2bUserIds set (populated from CT profiles export with
// GSTIN filter). Falls back to checking profileData.gstin in case the set is empty.
// B2C recency window = 60 days; B2B = 30 days.
// B2C thresholds: Early OC 1–2, Active OC 3–10, Power OC 11+
// B2B thresholds: Early OC 1–5, Active OC 6–20, Power OC 21+
function classifyLifecycleSegment(profile, b2cChurnCutoff, b2bChurnCutoff) {
  if (!profile) return 'b2c_new';
  const pd    = profile.profileData || {};
  const ev    = profile.events || {};
  const oc    = Number(pd.orderscount ?? pd['Orders Count'] ?? pd['orders_count'] ?? 0);
  const uid      = profile.identity || profile.objectId;
  const gstin    = pd.gstin || pd.GSTIN;
  const hasGstin = !!(gstin && String(gstin).trim() && String(gstin).trim().toLowerCase() !== 'null');
  const usertype = (pd.usertype || '').toLowerCase();
  const tags     = (pd.tags || '').toLowerCase().split(',').map(t => t.trim());
  const isB2B = (uid && b2bUserIds.size > 0 && b2bUserIds.has(String(uid))) ||
                hasGstin ||
                usertype.startsWith('business') ||
                tags.includes('business');
  const pfx   = isB2B ? 'b2b' : 'b2c';
  const churnCutoff  = isB2B ? b2bChurnCutoff : b2cChurnCutoff;
  const lastCharged  = ctTsToUnix(ev['Charged']?.last_seen || 0);
  const isRecent     = lastCharged > churnCutoff;

  if (oc === 0)  return `${pfx}_new`;
  if (!isRecent) return `${pfx}_churned`;
  if (isB2B) {
    if (oc <= 5)  return 'b2b_early';   // OC 1–5
    if (oc <= 20) return 'b2b_active';  // OC 6–20
    return 'b2b_power';                  // OC 21+
  }
  if (oc <= 2)   return 'b2c_early';    // OC 1–2
  if (oc <= 10)  return 'b2c_active';   // OC 3–10
  return 'b2c_power';                    // OC 11+
}

// Classify a Shopify order into a lifecycle segment for basket analysis.
// B2B via shipping_address.company; oc = customer.orders_count from Customers API.
// orders_count includes the current order, so pastOC = oc - 1 matches CT's orderscount.
function classifyShopifySegment(order, oc) {
  const b2b    = isB2B(order);
  const pastOC = oc - 1;  // orders_count includes this order; past OC = prior orders
  if (pastOC === 0) return b2b ? 'b2b_new' : 'b2c_new';
  if (b2b) {
    if (pastOC <= 5)  return 'b2b_early';
    if (pastOC <= 20) return 'b2b_active';
    return 'b2b_power';
  }
  if (pastOC <= 2)  return 'b2c_early';
  if (pastOC <= 10) return 'b2c_active';
  return 'b2c_power';
}

app.get('/api/lifecycle-segments', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ success: false, error: 'from and to required' });

  await ensureB2BIds();
  const cacheKey = `lifecycle_v28_${from.slice(0, 10)}_${to.slice(0, 10)}`;
  const cached   = lifecycleCache[cacheKey];
  if (cached && Date.now() - cached.ts < LIFECYCLE_TTL) {
    return res.json({ success: true, conversion: cached.conversion, basket: cached.basket, cached: true });
  }

  const fromD = parseInt(from.slice(0, 10).replace(/-/g, ''), 10);
  const toD   = parseInt(to.slice(0, 10).replace(/-/g, ''), 10);
  // Recency anchored to today (IST) to match CT's live "last N days" definition.
  const todayUnix    = istToUnix(istDate(0));
  const b2cChurnCutoff = todayUnix - 60 * 24 * 60 * 60;
  const b2bChurnCutoff = todayUnix - 30 * 24 * 60 * 60;

  try {
    // CT silently returns 0 records when too many export sessions run concurrently.
    // Fetch in batches of 2 to stay within CT's session limit.
    const [appEvents, screenEvents] = await Promise.all([
      exportCTEvents('App Launched',  fromD, toD),
      exportCTEvents('Screen Loaded', fromD, toD),
    ]);
    const fromDateStr = from.slice(0, 10);
    const toDateStr   = to.slice(0, 10);
    const [atcEvents, orderEvents, shopifyOrders] = await Promise.all([
      exportCTEvents('Product Added', fromD, toD),
      exportCTEvents('Order Placed',  fromD, toD),
      fetchOrdersForBasket(fromDateStr, toDateStr),
    ]);

    console.log(`[lifecycle ${fromD}-${toD}] raw events — App:${appEvents.length} Screen:${screenEvents.length} ATC:${atcEvents.length} Order:${orderEvents.length} ShopifyOrders:${shopifyOrders.length}`);
    console.log(`[lifecycle ${fromD}-${toD}] App events w/ profile: ${appEvents.filter(e => e.profile).length}`);

    // Deduplicate events to unique user profiles (one profile per user per metric)
    function dedupeProfiles(events, filterFn) {
      const seen = new Set();
      const out  = [];
      for (const ev of events) {
        if (filterFn && !filterFn(ev)) continue;
        const uid = ev.profile?.objectId || ev.profile?.identity;
        if (!ev.profile) continue;
        if (uid && seen.has(uid)) continue;
        if (uid) seen.add(uid);
        out.push(ev.profile);
      }
      return out;
    }

    const appProfiles    = dedupeProfiles(appEvents);
    const searchProfiles = dedupeProfiles(screenEvents, ev => (ev.event_props?.name || ev.event_props?.Name) === 'Search');
    const atcProfiles    = dedupeProfiles(atcEvents);
    const orderProfiles  = dedupeProfiles(orderEvents);

    // ── Conversion funnel: unique users per segment ────────────────────────
    const mkConv = () => ({ appOpen: 0, search: 0, atc: 0, orderPlaced: 0 });
    const conv   = Object.fromEntries(LC_SEG_KEYS.map(s => [s, mkConv()]));

    const countConv = (profiles, metric) => {
      for (const p of profiles) {
        const s = classifyLifecycleSegment(p, b2cChurnCutoff, b2bChurnCutoff);
        conv.overall[metric]++;
        conv[s][metric]++;
      }
    };
    countConv(appProfiles,    'appOpen');
    countConv(searchProfiles, 'search');
    countConv(atcProfiles,    'atc');
    countConv(orderProfiles,  'orderPlaced');

    // ── Basket: App Open from CT; SKUs / Qty / AOV from Shopify orders ────────
    const mkBkt = () => ({ appOpen: 0, skuSet: new Set(), qtySum: 0, qtyCount: 0, aovSum: 0, aovCount: 0 });
    const bkt   = Object.fromEntries(LC_SEG_KEYS.map(s => [s, mkBkt()]));

    for (const p of appProfiles) {
      const s = classifyLifecycleSegment(p, b2cChurnCutoff, b2bChurnCutoff);
      bkt.overall.appOpen++;
      bkt[s].appOpen++;
    }

    // orders_count not in embedded customer — fetch from Customers API by ID
    const custIds   = new Set(shopifyOrders.map(o => o.customer?.id).filter(Boolean));
    const custOCMap = await fetchCustomerOrderCounts(custIds);
    console.log(`[lifecycle ${fromD}-${toD}] Shopify customer OC map: ${custOCMap.size} customers fetched`);

    for (const order of shopifyOrders) {
      const oc  = custOCMap.get(String(order.customer?.id)) ?? 1;
      const s   = classifyShopifySegment(order, oc);
      const amt = parseFloat(order.total_price) || 0;
      if (amt > 0) {
        bkt.overall.aovSum += amt; bkt.overall.aovCount++;
        if (bkt[s]) { bkt[s].aovSum += amt; bkt[s].aovCount++; }
      }
      for (const item of (order.line_items || [])) {
        const sku = item.sku || item.title;
        const qty = item.quantity || 1;
        if (sku) { bkt.overall.skuSet.add(String(sku)); if (bkt[s]) bkt[s].skuSet.add(String(sku)); }
        bkt.overall.qtySum += qty; bkt.overall.qtyCount++;
        if (bkt[s]) { bkt[s].qtySum += qty; bkt[s].qtyCount++; }
      }
    }

    const basket = Object.fromEntries(LC_SEG_KEYS.map(s => {
      const d = bkt[s];
      return [s, {
        appOpen:    d.appOpen,
        uniqueSkus: d.skuSet.size,
        avgQty:     d.skuSet.size > 0 ? +(d.qtySum / d.skuSet.size).toFixed(1) : null,
        aov:        d.aovCount > 0 ? +(d.aovSum / d.aovCount).toFixed(2) : null,
      }];
    }));

    const result = { conversion: conv, basket };
    lifecycleCache[cacheKey] = { ...result, ts: Date.now() };
    res.json({ success: true, ...result });

  } catch (err) {
    console.error('[/api/lifecycle-segments]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Web ATC "Other" inspector ─────────────────────────────────────────────

app.get('/api/web-atc-other', async (req, res) => {
  const from = (req.query.from || istDate(7)).slice(0, 10);
  const to   = (req.query.to   || istDate(1)).slice(0, 10);
  const fromD = parseInt(from.replace(/-/g, ''), 10);
  const toD   = parseInt(to.replace(/-/g, ''), 10);

  // Export all "Added to Cart" events in range
  const exportInit = await ctRequest('POST', '/1/events.json', {
    event_name: 'Added to Cart', from: fromD, to: toD,
  });
  if (!exportInit.cursor) return res.json({ error: exportInit });

  let totalEvents = 0;
  let noTitle = 0;
  const allTitles = [];
  let cursor = exportInit.cursor;
  while (cursor) {
    const page = await ctRequest('GET', `/1/events.json?cursor=${cursor}`);
    for (const rec of (page.records || [])) {
      totalEvents++;
      const title = rec.event_props?.title || rec.event_props?.Title || '';
      if (!title) { noTitle++; continue; }
      allTitles.push(title);
    }
    cursor = page.cursor || null;
  }

  const unmatchedCounts = {};
  for (const rawTitle of allTitles) {
    const matched = PRODUCT_ENTRIES.some(({ key }) =>
      rawTitle.toLowerCase().includes(key.replace(/&/g, '&amp;').toLowerCase())
    );
    if (!matched) unmatchedCounts[rawTitle] = (unmatchedCounts[rawTitle] || 0) + 1;
  }

  const sorted = Object.entries(unmatchedCounts).sort((a, b) => b[1] - a[1]).map(([title, count]) => ({ title, count }));
  const noTitleList = noTitle ? [`(${noTitle} events had no title property)`] : [];

  res.json({ from, to, totalExported: totalEvents, noTitleCount: noTitle,
    unmappedTitleCount: sorted.reduce((s, x) => s + x.count, 0),
    note: 'Other = noTitle + unmappedTitles. CT query-based Other may differ slightly due to &amp; encoding in CT.',
    unmapped: [...noTitleList, ...sorted.map(x => `${x.title} (${x.count})`)] });
});

// ── Profile-filter debug ─────────────────────────────────────────────────

app.get('/api/debug-profile-export', async (req, res) => {
  const date = req.query.date || istDate(1);
  const d    = parseInt(date.replace(/-/g, ''), 10);

  // Test: does /1/profiles.json honour profile_filters + event_filters?
  // Try different request formats to see what CT's profiles API actually accepts
  async function ctProfileRaw(body) {
    try {
      const init = await ctRequest('POST', '/1/profiles.json', body);
      if (init.cursor) {
        const page = await ctRequest('GET', `/1/profiles.json?cursor=${init.cursor}`);
        return { init_status: init.status, page_count: (page.records||[]).length, page_total: page.count, first_record_keys: Object.keys((page.records||[{}])[0]||{}) };
      }
      return { init };
    } catch (e) { return { error: e.message }; }
  }

  // Get a full sample record to see the structure
  async function ctProfileSample(body) {
    try {
      const init = await ctRequest('POST', '/1/profiles.json', body);
      if (init.cursor) {
        const page = await ctRequest('GET', `/1/profiles.json?cursor=${init.cursor}`);
        return { total_records: (page.records||[]).length, sample: (page.records||[])[0] };
      }
      return { init };
    } catch (e) { return { error: e.message }; }
  }

  const sample = await ctProfileSample({ event_name: 'App Launched', from: d, to: d });
  res.json({ date, sample });
});

app.get('/api/debug-profile-filter', async (req, res) => {
  const date = req.query.date || istDate(1);
  const d    = parseInt(date.replace(/-/g, ''), 10);

  // Test CT profiles count API — does it support profile_filters?
  async function ctProfileCount(profileFilters) {
    const body = {};
    if (profileFilters && profileFilters.length) body.profile_filters = profileFilters;
    try {
      const init = await ctRequest('POST', '/1/counts/profiles.json', body);
      if (init.status === 'success') return init.count ?? init;
      if (!init.req_id) return { raw: init };
      const result = await ctPoll(init.req_id);
      return result.count ?? result;
    } catch (e) { return { error: e.message }; }
  }

  const [
    eventUnfiltered, eventImpossible,
    profileAll, profileOC0, profileOC1, profileOC5plus,
  ] = await Promise.all([
    fetchCTCountRange('App Launched', null, null, d, d),
    fetchCTCountRange('App Launched', null,
      [{ name: 'Orders Count', operator: 'equals', value: 999999 }], d, d),
    ctProfileCount(null),
    ctProfileCount([{ name: 'Orders Count', operator: 'equals',      value: 0 }]),
    ctProfileCount([{ name: 'Orders Count', operator: 'equals',      value: 1 }]),
    ctProfileCount([{ name: 'Orders Count', operator: 'greaterThan', value: 4 }]),
  ]);

  res.json({
    date,
    events_api: {
      unfiltered:    eventUnfiltered,
      OC_eq_999999:  eventImpossible,
      filterWorking: eventImpossible !== eventUnfiltered,
    },
    profiles_api: {
      all_users: profileAll,
      OC_eq_0:   profileOC0,
      OC_eq_1:   profileOC1,
      'OC_gt_4 (5+)': profileOC5plus,
      filterWorking: typeof profileOC0 === 'number' && profileOC0 !== profileAll,
    },
  });
});

// ── Debug: raw events export structure ───────────────────────────────────────
app.get('/api/debug-events-export', async (req, res) => {
  const date      = req.query.date || istDate(1);
  const eventName = req.query.event || 'App Launched';
  const d         = parseInt(date.replace(/-/g, ''), 10);
  try {
    const init = await ctRequest('POST', '/1/events.json', { event_name: eventName, from: d, to: d });
    if (!init.cursor) return res.json({ error: 'no cursor', init });
    const page = await ctRequest('GET', `/1/events.json?cursor=${init.cursor}`);
    const records = page.records || [];
    const withProfile    = records.filter(r => !!r.profile).length;
    const withoutProfile = records.filter(r => !r.profile).length;
    const sample         = records.slice(0, 3);
    res.json({ date, eventName, totalOnPage: records.length, withProfile, withoutProfile, sampleKeys: records[0] ? Object.keys(records[0]) : [], sample });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Env check ────────────────────────────────────────────────────────────────

app.get('/api/env-check', (req, res) => {
  res.json({
    SHOPIFY_STORE_URL:    process.env.SHOPIFY_STORE_URL    ? '✓ set' : '✗ missing',
    SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN ? '✓ set' : '✗ missing',
    CT_ACCOUNT_ID:        process.env.CT_ACCOUNT_ID        ? '✓ set' : '✗ missing',
    CT_PASSCODE:          process.env.CT_PASSCODE          ? '✓ set' : '✗ missing',
  });
});

// ── ATC diagnostic: test which filter gives web data ─────────────────────────

app.get('/api/debug-atc', async (req, res) => {
  const date    = req.query.date || istDate(1);
  const keyword = req.query.keyword || 'Cement';

  const [
    atcTotal, atcTitleContains, atcProductNameContains, atcNameContains,
    paTotal,  paTitleContains,  paProductNameContains,  paNameContains,
  ] = await Promise.all([
    fetchCTCount('Added to Cart',  null, date),
    fetchCTCount('Added to Cart',  [{ name: 'title',        operator: 'contains', value: keyword }], date),
    fetchCTCount('Added to Cart',  [{ name: 'product_name', operator: 'contains', value: keyword }], date),
    fetchCTCount('Added to Cart',  [{ name: 'name',         operator: 'contains', value: keyword }], date),
    fetchCTCount('Product Added',  null, date),
    fetchCTCount('Product Added',  [{ name: 'title',        operator: 'contains', value: keyword }], date),
    fetchCTCount('Product Added',  [{ name: 'product_name', operator: 'contains', value: keyword }], date),
    fetchCTCount('Product Added',  [{ name: 'name',         operator: 'contains', value: keyword }], date),
  ]);

  res.json({
    date, keyword,
    'Added to Cart': {
      total: atcTotal,
      [`title contains "${keyword}"`]:        atcTitleContains,
      [`product_name contains "${keyword}"`]: atcProductNameContains,
      [`name contains "${keyword}"`]:         atcNameContains,
    },
    'Product Added': {
      total: paTotal,
      [`title contains "${keyword}"`]:        paTitleContains,
      [`product_name contains "${keyword}"`]: paProductNameContains,
      [`name contains "${keyword}"`]:         paNameContains,
    },
  });
});

// ── Lifecycle profile debug ───────────────────────────────────────────────────
// GET /api/debug-lc-profiles?date=2026-05-31
// Returns first 15 search profiles with raw profileData + classification

app.get('/api/debug-lc-profiles', async (req, res) => {
  const date = (req.query.date || istDate(1)).slice(0, 10);
  const d    = parseInt(date.replace(/-/g, ''), 10);
  const todayUnix    = istToUnix(istDate(0));
  const b2cChurnCutoff = todayUnix - 60 * 24 * 60 * 60;
  const b2bChurnCutoff = todayUnix - 30 * 24 * 60 * 60;
  const churnCutoff = b2cChurnCutoff;
  try {
    const profiles = await exportCTProfiles('Screen Loaded', d, d, [{ name: 'name', operator: 'equals', value: 'Search' }]);
    const sample = profiles.slice(0, 15).map(p => {
      const pd = p.profileData || {};
      const ev = p.events || {};
      const oc = Number(pd.orderscount ?? pd['Orders Count'] ?? pd['orders_count'] ?? 0);
      const lastSeenRaw = ev['Charged']?.last_seen || 0;
      const lastSeen    = ctTsToUnix(lastSeenRaw);
      return {
        identity:           p.identity,
        objectId:           p.objectId,
        pd_orderscount:     pd.orderscount,
        pd_OrdersCount:     pd['Orders Count'],
        pd_orders_count:    pd['orders_count'],
        ev_Charged_count:   ev['Charged']?.count,
        ev_Charged_last_seen_raw: lastSeenRaw,
        ev_Charged_last_seen_unix: lastSeen,
        churnCutoff,
        isRecent:           lastSeen >= churnCutoff,
        oc_used:            oc,
        segment:            classifyLifecycleSegment(p, b2cChurnCutoff, b2bChurnCutoff),
        profileData_keys:   Object.keys(pd).slice(0, 30),
      };
    });
    res.json({ date, total: profiles.length, churnCutoff, sample });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Static + start ────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  ◆ HomeRun Daily Dashboard\n  → http://localhost:${PORT}\n`);
  });
}

module.exports = app;
