// Keeta Holdings — vanilla JS, no build step.
// All data flows directly from the user's browser to public Keeta endpoints.

const NODE_API = 'https://rep1.main.network.api.keeta.com';
const PRICE_ANCHOR = 'https://asset-estimate-anchor.keeta.com';
const SAMPLE_ADDRESS = 'keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg';

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
  const res = await fetch(`${NODE_API}/api/node/ledger/account/${address}/balance`);
  if (!res.ok) throw new Error(`Account lookup failed: ${res.status}`);
  const data = await res.json();
  return data.balances || [];
}

// The node API returns truncated token ids in the balance list (e.g. "keeta_...4ssg").
// Resolve those to full token ids by matching the suffix against our known asset registry.
function resolveTokenId(maybeTrunc) {
  if (!maybeTrunc.includes('...')) return maybeTrunc;
  const suffix = maybeTrunc.split('...').pop();
  for (const tokenId of Object.keys(TOKEN_TO_SYM)) {
    if (tokenId.endsWith(suffix)) return tokenId;
  }
  return maybeTrunc;
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

  setStatus('Pricing assets through asset-estimate-anchor.keeta.com…');

  const rows = [];
  for (const b of balances) {
    const tokenId = resolveTokenId(b.token);
    const symbol = TOKEN_TO_SYM[tokenId] || null;
    if (!symbol) continue; // skip unknown tokens for v1
    const info = ASSETS[symbol];
    const amountBase = hexToBigInt(b.balance);
    let priceUSD = null;
    let valueUSD = null;
    try {
      priceUSD = await fetchPriceUSD(info.token, info.decimals);
      if (priceUSD !== null) {
        const amountUnits = Number(amountBase) / 10 ** info.decimals;
        valueUSD = amountUnits * priceUSD;
      }
    } catch (e) {
      console.warn(`Price fetch failed for ${symbol}`, e);
    }
    rows.push({
      symbol,
      description: info.description,
      category: info.category,
      amountBase,
      decimals: info.decimals,
      priceUSD,
      valueUSD,
    });
  }

  lastRows = rows;
  hideStatus();
  $('#account-label').textContent = `${address.slice(0, 14)}…${address.slice(-8)}`;
  $('#results').classList.remove('hidden');
  $('#empty').classList.add('hidden');
  render();
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
      <td class="px-4 py-3 text-right mono">${r.priceUSD === null ? '<span class="text-neutral-400">—</span>' : formatUSDValue(r.priceUSD)}</td>
      <td class="px-4 py-3 text-right mono font-semibold">${r.valueUSD === null ? '<span class="text-neutral-400">—</span>' : formatUSDValue(r.valueUSD)}</td>
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
  $('#sample-btn').addEventListener('click', () => {
    $('#address').value = SAMPLE_ADDRESS;
    $('#lookup-form').requestSubmit();
  });
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
