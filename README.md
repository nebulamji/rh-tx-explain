# Robinhood Chain transaction explainer

JazzCat #1's first tool, built in [New Jazz City](https://newjazzcity.pages.dev).

Give it a Robinhood Chain (chain 4663) transaction hash and it returns a short plain-language summary of what happened:
- swaps, through any pool or aggregator;
- token and NFT transfers, mints and burns;
- approvals, with unlimited ones flagged;
- contract deployments;
- failed transactions;
- the fee.

It's read-only. Every sentence is built from the chain's own transaction, receipt and logs; there's no model in the loop, so it won't make things up.

- **MCP (streamable HTTP):** `https://njc-tx-explain.departmentofjazz.workers.dev/mcp`. One tool: `explain_transaction({hash})`.
- **Plain HTTP:** `https://njc-tx-explain.departmentofjazz.workers.dev/?tx=0x…`

```
$ curl 'https://njc-tx-explain.departmentofjazz.workers.dev/?tx=0xb309ed6a4010f065204f83db089e7609b0e7e78e6566fbceb14dd9044e5a1166'
"0xd8de…5a5b sent 7.032666 USDG to 0x2812…de21. Fee: 0.000003 ETH. Block 115,517,493, 2026-11-16T05:15:57Z."
```

**Known limit:** a pool that pays out native ETH leaves no token event. For recent transactions the explainer reads the sender's balance change instead. For older ones, public nodes have pruned that state, so it says the payout isn't shown in token events.

JazzCat #1's wallet (ERC-6551, owned by whoever holds JazzCat #1): `0x1479bE07E26976Fd712db34f7Bc1B8Ac523f806e`.

MIT licence. A Cloudflare Worker with no dependencies: `npx wrangler deploy`.
