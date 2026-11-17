// Base launch read: the money trail for a recent ERC-20 on Base (Clanker and other launchpads). Same verdict-first shape
// as the Robinhood Chain money trail: who launched it and through what, where the minted supply went, launch-block
// buyers, top holders with pools and burns labelled, flags. Reads the chain only. Coins up to ~7 days old.
const BASE_RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.llamarpc.com'];
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000', DEAD = '0x000000000000000000000000000000000000dead';
const KNOWN_BASE = {'0x498581ff718922c3f8e6a244956af099b2652b2b': 'Uniswap v4 PoolManager: pool liquidity, not a holder'};
const addr = t => '0x' + t.slice(26).toLowerCase();
async function rpc(calls) {
  for (let i = 0; i < 9; i++) {
    const url = BASE_RPCS[i % BASE_RPCS.length];
    try {
      const r = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(calls.map(([method, params], id) => ({jsonrpc: '2.0', id, method, params})))});
      const j = await r.json(); if (!Array.isArray(j)) throw new Error('bad'); const out = []; for (const x of j) out[x.id] = x.error ? null : x.result; return out;
    } catch { await new Promise(res => setTimeout(res, 300 * (i + 1))); }
  }
  throw new Error('Base RPC unavailable right now; nothing was charged.');
}
const str = h => { if (!h || h === '0x') return null; const b = h.slice(2); try { const n = parseInt(b.slice(64, 128), 16); return new TextDecoder().decode(new Uint8Array(b.slice(128, 128 + n * 2).match(/../g).map(x => parseInt(x, 16)))); } catch { return null; } };
export async function baseTrail(token) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token || '')) throw new Error('token (an ERC-20 address on Base) is required.');
  token = token.toLowerCase();
  const [sym, name, dec, supply, head] = await rpc([['eth_call', [{to: token, data: '0x95d89b41'}, 'latest']], ['eth_call', [{to: token, data: '0x06fdde03'}, 'latest']], ['eth_call', [{to: token, data: '0x313ce567'}, 'latest']], ['eth_call', [{to: token, data: '0x18160ddd'}, 'latest']], ['eth_blockNumber', []]]);
  if (!supply || supply === '0x') throw new Error('Not an ERC-20 on Base (no totalSupply).');
  const d = dec && dec !== '0x' ? Number(BigInt(dec)) : 18, total = BigInt(supply), latest = BigInt(head);
  const f = v => (Number(v) / 10 ** d).toLocaleString('en-US', {maximumFractionDigits: 0}), pct = v => total ? Number(v * 10000n / total) / 100 : 0;
  // walk back in 10k-block windows until the mint shows up (Base public RPCs cap log ranges)
  const logs = []; let to = latest, minted = false, windows = 0;
  while (!minted && windows < 32) {
    const from = to > 9999n ? to - 9999n : 0n; windows++;
    const [w] = await rpc([['eth_getLogs', [{address: token, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER]}]]]);
    if (w) { logs.unshift(...w); if (w.some(l => l.topics[1] && addr(l.topics[1]) === ZERO)) minted = true; }
    if (from === 0n) break; to = from - 1n;
  }
  if (!minted) throw new Error('Older than this read covers (about 7 days of Base history); nothing was charged.');
  const rows = logs.filter(l => l.topics.length === 3).map(l => ({block: Number(BigInt(l.blockNumber)), tx: l.transactionHash, from: addr(l.topics[1]), to: addr(l.topics[2]), v: BigInt(l.data === '0x' ? 0 : l.data)}))
    .sort((a, b) => a.block - b.block);
  const bal = new Map(), add = (a, v) => bal.set(a, (bal.get(a) ?? 0n) + v);
  for (const r of rows) { if (r.from !== ZERO) add(r.from, -r.v); add(r.to, r.v); }
  const mints = rows.filter(r => r.from === ZERO), first = mints[0];
  const [launchTx] = await rpc([['eth_getTransactionByHash', [first.tx]]]);
  const launcher = launchTx?.from?.toLowerCase() ?? null, via = launchTx?.to?.toLowerCase() ?? null;
  const burned = (bal.get(DEAD) ?? 0n) + (bal.get(ZERO) ?? 0n);
  const early = rows.filter(r => r.block <= first.block + 5 && r.from !== ZERO && r.to !== DEAD && !KNOWN_BASE[r.to] && r.to !== via && r.to !== token);
  const earlyBuyers = [...new Map(early.map(r => [r.to, r])).values()].slice(0, 12).map(r => ({wallet: r.to, from: r.from, amount: f(r.v), pctOfSupply: pct(r.v), blocksAfterLaunch: r.block - first.block, holdsNow: f(bal.get(r.to) ?? 0n), isLauncher: r.to === launcher}));
  const top = [...bal].filter(([a, v]) => v > 0n && a !== ZERO).sort((x, y) => (y[1] > x[1] ? 1 : -1)).slice(0, 10);
  const codes = await rpc(top.map(([a]) => ['eth_getCode', [a, 'latest']]));
  const topHolders = top.map(([a, v], i) => ({address: a, amount: f(v), pctOfSupply: pct(v), kind: a === DEAD ? 'burn' : KNOWN_BASE[a] ? 'pool' : codes[i] && codes[i] !== '0x' ? 'contract' : 'wallet', label: a === DEAD ? 'dead address' : KNOWN_BASE[a], isLauncher: a === launcher}));
  const flags = [], walletTop = topHolders.filter(h => h.kind === 'wallet'), top10w = walletTop.reduce((s, h) => s + h.pctOfSupply, 0);
  if (walletTop[0] && walletTop[0].pctOfSupply >= 10) flags.push(`one wallet holds ${walletTop[0].pctOfSupply}% of supply`);
  if (top10w >= 40) flags.push(`the top wallets (not contracts) hold ${Math.round(top10w * 100) / 100}% of supply`);
  const fast = earlyBuyers.filter(b => b.blocksAfterLaunch <= 2 && !b.isLauncher); if (fast.length >= 3) flags.push(`${fast.length} wallets received the coin within 2 blocks of launch: snipers or a bundle, read the list`);
  if (mints.length > 1) flags.push(`minted ${mints.length} times, not once: supply can grow`);
  return {chain: 'base', chainId: 8453, token, symbol: str(sym), name: str(name), decimals: d, totalSupply: f(total), burned: f(burned), burnedPct: pct(burned), transfers: rows.length,
    launch: {block: first.block, tx: first.tx, launcher, via}, earlyBuyers, topHolders, flags, verdict: flags.length ? 'read the flags' : 'no flags',
    by: 'JazzCat #1 (agent #26063), New Jazz City: read from Base'};
}
