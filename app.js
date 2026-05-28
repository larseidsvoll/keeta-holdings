// Keeta Holdings — vanilla JS, no build step.
// All data flows directly from the user's browser to public Keeta endpoints.

const NODE_API = 'https://rep1.main.network.api.keeta.com';
const PRICE_ANCHOR = 'https://asset-estimate-anchor.keeta.com';

// Known community FX anchors, discovered on-chain. Each publishes an FX service
// with a getEstimate endpoint, a currencyMap of $TICKER->tokenId, and from/to
// routes against KTA. We harvest all of them so we can cascade through anchors
// until one of them quotes a given community token.
//
// To add an anchor: drop its account address here. Everything else is read
// from on-chain metadata at load time.
const COMMUNITY_FX_ANCHORS = [
  'keeta_aabyuc4ce7n7n7gyjbcszpxlawujaacpu2wj72fljjjhhhyf25xmj66gand2ori', // Alpaca FX Anchor
  'keeta_athqkb6yw6h2e436xxaakuy4bctrqkqfctvy5xsp3ugvb3avv56zruxjcxauq', // Murphy (MURF) FX
  'keeta_aab2lqgwz56u6dvfbqtsadcnfc2y4wdvl7rd2pkboxoray5mj3hmdzot2neu4wq', // Velocity FX Anchor
];

let ASSETS = {}; // sym -> {token, decimals, category, description}
let TOKEN_TO_SYM = {}; // tokenId -> symbol
let USD_TOKEN = '';
let KTA_TOKEN = '';

// Community FX state, hydrated once at app start.
// Each entry: { account, estimateURL, tokens: Set<tokenId>, symbols: {tokenId: ticker} }
let communityAnchors = [];
let communitySymbols = {}; // unioned: tokenId -> ticker (first anchor that names it wins)

let currentFilter = 'all';
let currentSort = 'value-desc';
let lastRows = [];

const $ = (sel) => document.querySelector(sel);

async function loadAssets() {
  const res = await fetch('./assets/assets.json', { cache: 'no-cache' });
  ASSETS = await res.json();
  for (const [sym, info] of Object.entries(ASSETS)) {
    TOKEN_TO_SYM[info.token] = sym;
  }
  USD_TOKEN = ASSETS.USD.token;
  KTA_TOKEN = ASSETS.KTA.token;
}

// Parse "0x..." OR plain decimal string OR bigint string into a BigInt.
function toBigInt(s) {
  if (typeof s !== 'string') return 0n;
  try { return BigInt(s); } catch { return 0n; }
}

function hexToBigInt(s) {
  if (typeof s !== 'string') return 0n;
  if (s.startsWith('0x') || s.startsWith('0X')) return BigInt(s);
  // some endpoints return plain decimal strings
  try { return BigInt(s); } catch { return 0n; }
}

function formatAmount(amountBase, decimals) {
  if (decimals === 0) return Number(amountBase).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const divisor = 10n ** BigInt(decimals);
  const whole = amountBase / divisor;
  const frac = amountBase % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, Math.min(decimals, 6));
  const trimmed = fracStr.replace(/0+$/, '');
  const wholeStr = Number(whole).toLocaleString();
  return trimmed.length ? `${wholeStr}.${trimmed}` : wholeStr;
}

function formatUSD(amountBaseUSD) {
  // USD has 2 decimals on-chain (base unit = cent)
  const dollars = Number(amountBaseUSD) / 100;
  return dollars.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function formatUSDValue(n) {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

// Same as formatUSDValue but shows extra digits for sub-cent prices so
// community tokens worth fractions of a cent don't all look like $0.00.
function formatUSDPrice(n) {
  if (n === 0) return '$0.00';
  if (Math.abs(n) >= 0.01) return formatUSDValue(n);
  // Show up to 8 significant digits for tiny values.
  return '$' + n.toLocaleString(undefined, { minimumSignificantDigits: 2, maximumSignificantDigits: 4 });
}

async function fetchBalances(address) {
  // truncate=false returns full token ids; default truncates to keeta_...suffix.
  const res = await fetch(`${NODE_API}/api/node/ledger/account/${address}/balance?truncate=false`);
  if (!res.ok) throw new Error(`Account lookup failed: ${res.status}`);
  const data = await res.json();
  return data.balances || [];
}

// Best-effort lookup of an unknown token's symbol and decimals from its ledger account metadata.
async function fetchTokenInfo(tokenId) {
  try {
    const res = await fetch(`${NODE_API}/api/node/ledger/account/${tokenId}`);
    if (!res.ok) return null;
    const data = await res.json();
    const info = data.info || {};
    let decimals = 0;
    let description = info.description || '';
    const meta = await parseAccountMetadata(info.metadata);
    if (meta && typeof meta.decimalPlaces === 'number') decimals = meta.decimalPlaces;
    // Prefer the on-chain symbol from any community FX anchor's currencyMap (those carry
    // $TICKER style symbols), else fall back to the token account's name field.
    const sym = communitySymbols[tokenId] || info.name || tokenId.slice(0, 10);
    return {
      symbol: sym,
      decimals,
      description,
      category: 'token',
      token: tokenId,
    };
  } catch {
    return null;
  }
}

// Decode an on-chain metadata blob (base64 of either plain JSON or zlib-compressed JSON).
async function parseAccountMetadata(b64) {
  if (!b64) return null;
  let bytes;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch { return null; }

  // Try plain JSON first.
  try {
    const txt = new TextDecoder().decode(bytes);
    return JSON.parse(txt);
  } catch { /* not plain JSON, try inflate */ }

  // Try DEFLATE (zlib).
  try {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const txt = await new Response(stream).text();
    return JSON.parse(txt);
  } catch { return null; }
}

// Pull each community FX anchor's service metadata in parallel: token list, symbol map,
// and getEstimate endpoint. Called once at app start. Anchors that fail to load are
// skipped silently so one bad anchor never blocks the rest.
async function loadCommunityAnchors() {
  if (communityAnchors.length) return; // already loaded
  await Promise.all(COMMUNITY_FX_ANCHORS.map(async (account) => {
    try {
      const res = await fetch(`${NODE_API}/api/node/ledger/account/${account}`);
      if (!res.ok) return;
      const data = await res.json();
      const meta = await parseAccountMetadata(data.info?.metadata);
      if (!meta) return;

      const tokens = new Set();
      const symbols = {};

      // currencyMap: { "$LUCKY": "keeta_...", ... }
      for (const [sym, tok] of Object.entries(meta.currencyMap || {})) {
        const cleanSym = sym.replace(/^\$/, '');
        symbols[tok] = cleanSym;
        tokens.add(tok);
        // Union into the global symbol map. First anchor to name a token wins.
        if (!communitySymbols[tok]) communitySymbols[tok] = cleanSym;
      }

      // Pick the first FX provider with a getEstimate operation.
      let estimateURL = null;
      const providers = meta.services?.fx || {};
      for (const provider of Object.values(providers)) {
        if (provider.operations?.getEstimate) {
          estimateURL = provider.operations.getEstimate;
          // Union from-route token list into our quotable set.
          for (const route of provider.from || []) {
            for (const tok of route.currencyCodes || []) tokens.add(tok);
          }
          break;
        }
      }

      if (estimateURL) {
        communityAnchors.push({
          account,
          estimateURL,
          name: data.info?.name || account.slice(0, 14),
          tokens,
          symbols,
        });
      }
    } catch (e) {
      console.warn(`Community FX anchor metadata fetch failed for ${account}`, e);
    }
  }));
}

// Low-level: ask a specific FX anchor for an estimate. Returns the converted bigint
// (in destination base units) or null if the anchor cannot quote.
async function getEstimate(endpoint, fromToken, toToken, amountBase) {
  const body = {
    request: {
      from: fromToken,
      to: toToken,
      amount: amountBase.toString(),
      affinity: 'from',
    },
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.ok || !data.estimate) return null;
  // canPerformExchange=false is fine for our purposes; we just want the quote.
  return toBigInt(data.estimate.convertedAmount);
}

// Cache KTA→USD rate (USD micro-dollars per 1 KTA-unit) for the cascade lookup.
let ktaUsdRateCache = null;
async function getKtaUsdRate() {
  if (ktaUsdRateCache !== null) return ktaUsdRateCache;
  const oneKta = 10n ** BigInt(ASSETS.KTA.decimals);
  const usdBase = await getEstimate(`${PRICE_ANCHOR}/api/getEstimate`, KTA_TOKEN, USD_TOKEN, oneKta);
  if (usdBase === null || usdBase === 0n) { ktaUsdRateCache = 0; return 0; }
  // USD is 2 decimals on-chain
  ktaUsdRateCache = Number(usdBase) / 100;
  return ktaUsdRateCache;
}

async function fetchPriceUSD(fromToken, fromDecimals) {
  if (fromToken === USD_TOKEN) return 1;
  const oneUnit = 10n ** BigInt(fromDecimals);

  // Path 1: canonical price anchor quotes direct USD.
  try {
    const usdBase = await getEstimate(`${PRICE_ANCHOR}/api/getEstimate`, fromToken, USD_TOKEN, oneUnit);
    if (usdBase !== null && usdBase > 0n) return Number(usdBase) / 100;
  } catch { /* fall through */ }

  // Path 2: ask each community FX anchor that lists this token for a KTA quote.
  // First non-zero result wins. We then convert KTA->USD via the canonical anchor.
  for (const anchor of communityAnchors) {
    if (!anchor.tokens.has(fromToken)) continue;
    try {
      const ktaBase = await getEstimate(anchor.estimateURL, fromToken, KTA_TOKEN, oneUnit);
      if (ktaBase !== null && ktaBase > 0n) {
        const ktaUsd = await getKtaUsdRate();
        if (ktaUsd > 0) {
          const ktaUnits = Number(ktaBase) / 10 ** ASSETS.KTA.decimals;
          return ktaUnits * ktaUsd;
        }
      }
    } catch { /* try the next anchor */ }
  }

  return null;
}

async function loadHoldings(address) {
  setStatus('Loading account…');
  const [balances] = await Promise.all([
    fetchBalances(address),
    loadCommunityAnchors(), // hydrate FX anchor metadata in parallel
  ]);

  if (!balances.length) {
    setStatus('This account holds no recognized assets.');
    return;
  }

  // Phase 1: resolve symbol/decimals/category for every balance in parallel.
  // Known assets resolve synchronously from the registry; unknowns hit the node API.
  const resolved = await Promise.all(balances.map(async (b) => {
    const tokenId = b.token;
    const knownSymbol = TOKEN_TO_SYM[tokenId] || null;
    let info;
    if (knownSymbol) {
      info = { ...ASSETS[knownSymbol], symbol: knownSymbol };
    } else {
      info = await fetchTokenInfo(tokenId);
    }
    if (!info) return null;
    // Canonical assets (anything in our precomputed registry) are pinned to the
    // top of the table. Community tokens sort below them.
    const isCanonical = knownSymbol !== null;
    return {
      symbol: info.symbol,
      description: info.description,
      category: info.category,
      amountBase: hexToBigInt(b.balance),
      decimals: info.decimals,
      priceUSD: undefined, // undefined = still loading; null = no quote
      valueUSD: undefined,
      tokenId,
      isCanonical,
    };
  }));

  // Render immediately with rows visible, prices showing a loading state.
  lastRows = resolved.filter(Boolean);
  hideStatus();
  $('#account-label').textContent = `${address.slice(0, 14)}…${address.slice(-8)}`;
  $('#results').classList.remove('hidden');
  $('#empty').classList.add('hidden');
  render();

  // Phase 2: fire all price fetches in parallel; rerender as each resolves.
  await Promise.all(lastRows.map(async (row, idx) => {
    try {
      const priceUSD = await fetchPriceUSD(row.tokenId, row.decimals);
      if (priceUSD === null) {
        lastRows[idx].priceUSD = null;
        lastRows[idx].valueUSD = null;
      } else {
        const amountUnits = Number(row.amountBase) / 10 ** row.decimals;
        lastRows[idx].priceUSD = priceUSD;
        lastRows[idx].valueUSD = amountUnits * priceUSD;
      }
    } catch (e) {
      console.warn(`Price fetch failed for ${row.symbol}`, e);
      lastRows[idx].priceUSD = null;
      lastRows[idx].valueUSD = null;
    }
    render();
  }));
}

function render() {
  const tbody = $('#rows');
  tbody.innerHTML = '';
  const filtered = lastRows.filter((r) => currentFilter === 'all' || r.category === currentFilter);

  const sorted = [...filtered].sort((a, b) => {
    // Canonical assets always pin to the top of the table regardless of sort.
    if (a.isCanonical && !b.isCanonical) return -1;
    if (!a.isCanonical && b.isCanonical) return 1;
    switch (currentSort) {
      case 'value-desc': return (b.valueUSD ?? -1) - (a.valueUSD ?? -1);
      case 'value-asc':  return (a.valueUSD ?? -1) - (b.valueUSD ?? -1);
      case 'amount-desc': {
        // compare bigints
        if (a.amountBase > b.amountBase) return -1;
        if (a.amountBase < b.amountBase) return 1;
        return 0;
      }
      case 'symbol-asc': return a.symbol.localeCompare(b.symbol);
      default: return 0;
    }
  });

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-sm text-neutral-500">No assets in this category.</td></tr>`;
  }

  for (const r of sorted) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="px-4 py-3">
        <div class="flex items-center gap-3">
          <div class="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-xs font-semibold text-neutral-700">${r.symbol.slice(0, Math.min(4, r.symbol.length))}</div>
          <div>
            <div class="font-medium">${r.symbol}</div>
            <div class="text-xs text-neutral-500">${r.description}</div>
          </div>
        </div>
      </td>
      <td class="px-4 py-3 text-right mono">${formatAmount(r.amountBase, r.decimals)}</td>
      <td class="px-4 py-3 text-right mono">${r.priceUSD === undefined ? '<span class="text-neutral-300">…</span>' : r.priceUSD === null ? '<span class="text-neutral-400">—</span>' : formatUSDPrice(r.priceUSD)}</td>
      <td class="px-4 py-3 text-right mono font-semibold">${r.valueUSD === undefined ? '<span class="text-neutral-300">…</span>' : r.valueUSD === null ? '<span class="text-neutral-400">—</span>' : formatUSDValue(r.valueUSD)}</td>
    `;
    tbody.appendChild(tr);
  }

  const total = sorted.reduce((acc, r) => acc + (r.valueUSD ?? 0), 0);
  $('#total').textContent = formatUSDValue(total);
}

function setFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll('#filter-tabs button').forEach((btn) => {
    const active = btn.dataset.filter === filter;
    btn.classList.toggle('tab-active', active);
    btn.classList.toggle('tab', !active);
  });
  render();
}

function setStatus(msg) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideStatus() {
  $('#status').classList.add('hidden');
}

async function onSubmit(e) {
  e.preventDefault();
  const address = $('#address').value.trim();
  if (!address || !address.startsWith('keeta_')) {
    setStatus('Enter a valid Keeta account address (starts with keeta_).');
    return;
  }
  $('#results').classList.add('hidden');
  try {
    await loadHoldings(address);
    // update URL so the result is shareable
    const url = new URL(window.location);
    url.searchParams.set('account', address);
    window.history.replaceState({}, '', url);
  } catch (e) {
    console.error(e);
    setStatus(`Could not load holdings: ${e.message}`);
  }
}

function bind() {
  $('#lookup-form').addEventListener('submit', onSubmit);
  $('#sort-by').addEventListener('change', (e) => { currentSort = e.target.value; render(); });
  document.querySelectorAll('#filter-tabs button').forEach((btn) =>
    btn.addEventListener('click', () => setFilter(btn.dataset.filter))
  );
}

async function init() {
  await loadAssets();
  bind();
  const params = new URLSearchParams(window.location.search);
  const prefill = params.get('account');
  if (prefill) {
    $('#address').value = prefill;
    $('#lookup-form').requestSubmit();
  }
}

init();
