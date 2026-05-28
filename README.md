# Keeta Holdings

A tiny, single-page viewer for the holdings of any **[Keeta Network](https://keeta.com)** account. Live prices come from a Keeta Network FX anchor on-chain, not a third-party API.

Part of **Project Gildor**.

![screenshot placeholder](docs/screenshot.png)

## What it does

1. You paste a `keeta_...` account address
2. The page calls the public ledger node for that account's balances
3. For each asset, the page calls `asset-estimate-anchor.keeta.com`, an FX anchor running on the Keeta Network, to convert one unit of that asset into USD
4. You see a table with Asset, Amount, Price (USD), Value (USD), filterable by Fiat / Tokens / Stables and sortable by value

That's it. No backend, no API keys, no analytics. The page makes two kinds of HTTP request and both go to public Keeta endpoints.

## Why it exists

To show that pricing on Keeta does not require a third-party data provider. The price anchor service is just another service published on the network, discoverable through standard SDK resolver lookups. The whole pricing flow is the same wire protocol the anchor SDK uses for any FX service.

## How pricing works

The page reaches a Keeta FX anchor at `https://asset-estimate-anchor.keeta.com/api/getEstimate`. The request body matches the SDK's canonical `getEstimate` shape:

```json
{
  "request": {
    "from": "keeta_<token id>",
    "to":   "keeta_<USD token id>",
    "amount": "<bigint string in base units>",
    "affinity": "from"
  }
}
```

The response contains `convertedAmount` as a hex bigint in the destination asset's base units. USD has 2 decimals on the network, so dividing by 100 gives dollars.

The anchor declares itself as quote-only (`canPerformExchange: false`) and supports all 13 assets currently on the canonical currency map: KTA, USDC, EURC, cbBTC, USD, CAD, GBP, AED, EUR, HKD, JPY, MXN, CNY.

## Run it locally

```bash
git clone https://github.com/larseidsvoll/keeta-holdings.git
cd keeta-holdings
python3 -m http.server 8000
open http://localhost:8000
```

No `npm install`, no build step. The page is `index.html` plus `app.js` plus `assets/assets.json`. Tailwind is pulled from a CDN.

## Deploy

Cloudflare Pages, or any static host:

```bash
npx wrangler pages deploy . --project-name=keeta-holdings
```

## Asset registry

The 13 assets are precomputed in [`assets/assets.json`](./assets/assets.json) with their token IDs, decimals, category, and description. The values were sourced directly from each token account's on-chain metadata. If new assets are added to the network's `currencyMap`, regenerate the file:

```bash
# scripts/build-assets.sh (TODO)
```

## License

MIT.

## Acknowledgements

Built in collaboration with [@schenkty](https://github.com/schenkty) as part of Project Gildor.
