// Keeta Holdings — vanilla JS, no build step.
// All data flows directly from the user's browser to public Keeta endpoints.

const NODE_API = 'https://rep1.main.network.api.keeta.com';
const PRICE_ANCHOR = 'https://asset-estimate-anchor.keeta.com';

let ASSETS = {}; // sym -> {token, decimals, category, description}
let TOKEN_TO_SYM = {}; // tokenId -> symbol
let USD_TOKEN = '';

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
    if (info.metadata) {
      try {
        const raw = atob(info.metadata);
        // Some metadata blobs are plain JSON; others are gzipped. Try plain JSON first.
        try {
          const meta = JSON.parse(raw);
          if (typeof meta.decimalPlaces === 'number') decimals = meta.decimalPlaces;
        } catch { /* not plain JSON, leave decimals=0 */ }
      } catch { /* atob failed */ }
    }
    return {
      symbol: info.name || tokenId.slice(0, 10),
      decimals,
      description,
      category: 'token',
      token: tokenId,
    };
  } catch {
    return null;
  }
}

async function fetchPriceUSD(fromToken, fromDecimals) {
  // Quote 1 whole unit of the asset in USD.
  // The estimate anchor returns convertedAmount as hex in USD base units (2 decimals).
  if (fromToken === USD_TOKEN) return 1; // trivial
  const oneUnit = (10n ** BigInt(fromDecimals)).toString();
  const body = {
    request: {
      from: fromToken,
      to: USD_TOKEN,
      amount: oneUnit,
      affinity: 'from',
    },
  };
  const res = await fetch(`${PRICE_ANCHOR}/api/getEstimate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Price lookup failed: ${res.status}`);
  const data = await res.json();
  if (!data.ok || !data.estimate) return null;
  const converted = hexToBigInt(data.estimate.convertedAmount);
  // USD is 2 decimals on-chain
  return Number(converted) / 100;
}

async function loadHoldings(address) {
  setStatus('Loading account…');
  const balances = await fetchBalances(address);

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
    return {
      symbol: info.symbol,
      description: info.description,
      category: info.category,
      amountBase: hexToBigInt(b.balance),
      decimals: info.decimals,
      priceUSD: undefined, // undefined = still loading; null = no quote
      valueUSD: undefined,
      tokenId,
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
      <td class="px-4 py-3 text-right mono">${r.priceUSD === undefined ? '<span class="text-neutral-300">…</span>' : r.priceUSD === null ? '<span class="text-neutral-400">—</span>' : formatUSDValue(r.priceUSD)}</td>
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
