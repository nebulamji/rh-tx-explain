// Poison check: before you pay an address you copied from a wallet's history, read that history for address
// poisoning on Robinhood Chain. Two tells, both from the chain: tokens whose name only looks like a real one (USDG
// with invisible characters, a USDC that is not USDC's contract), and counterparties that share the first and last
// characters of a real counterparty but differ in the middle. Reads the chain only.
// The official RPC refuses Cloudflare's servers, so the deployed worker reads it through the read-only proxy (same as worker.mjs OFFICIAL).
const RPC = globalThis.NJC_LOCAL ? 'https://rpc.mainnet.chain.robinhood.com' : 'https://njc-read-proxy.vercel.app/api/rpc';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const REAL = {'0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG'}; // canonical tokens on Robinhood Chain, by contract
const LOOKS = ['USDG', 'USDC', 'USDT', 'WETH', 'ETH', 'PRIORS', 'CREDIT'];
const WINDOW = 29000n, WINDOWS = 8; // the public RPC allows ~30k blocks per log query without an address filter
const pad = a => '0x' + a.toLowerCase().slice(2).padStart(64, '0'), addr = t => '0x' + t.slice(26).toLowerCase();
async function rpc(calls) {
  if (!calls.length) return [];
  for (let i = 0; i < 9; i++) {
    try {
      const r = await fetch(RPC, {method: 'POST', headers: {'content-type': 'application/json', 'user-agent': 'njc-tx-explain/1'}, body: JSON.stringify(calls.map(([method, params], id) => ({jsonrpc: '2.0', id, method, params})))});
      const j = await r.json(); if (!Array.isArray(j)) throw new Error('bad'); const out = []; for (const x of j) out[x.id] = x.error ? null : x.result; return out;
    } catch { await new Promise(res => setTimeout(res, 300 * (i + 1))); }
  }
  throw new Error('Robinhood Chain RPC unavailable right now; nothing was charged.');
}
const str = h => { if (!h || h === '0x') return null; const b = h.slice(2); try { const n = parseInt(b.slice(64, 128), 16); return new TextDecoder().decode(new Uint8Array(b.slice(128, 128 + n * 2).match(/../g).map(x => parseInt(x, 16)))); } catch { return null; } };
// what a symbol says once invisible and look-alike characters are dropped
const plain = s => (s || '').normalize('NFKC').replace(/[^\x21-\x7e]/g, '').toUpperCase();
const ends = a => a.slice(2, 6) + '…' + a.slice(-4);
export async function poisonCheck(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) throw new Error('address (0x…) is required.');
  const me = address.toLowerCase();
  const [head] = await rpc([['eth_blockNumber', []]]); const latest = BigInt(head);
  const logs = [];
  for (let w = 0, to = latest; w < WINDOWS; w++) {
    const from = to > WINDOW ? to - WINDOW + 1n : 0n, range = {fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16)};
    const [out, inn] = await rpc([['eth_getLogs', [{...range, topics: [TRANSFER, pad(me)]}]], ['eth_getLogs', [{...range, topics: [TRANSFER, null, pad(me)]}]]]);
    for (const l of [...(out || []), ...(inn || [])]) if (l.topics.length === 3) logs.push(l);
    if (from === 0n) break; to = from - 1n;
  }
  const tokens = [...new Set(logs.map(l => l.address.toLowerCase()))];
  const syms = await rpc(tokens.map(t => ['eth_call', [{to: t, data: '0x95d89b41'}, 'latest']]));
  const sym = Object.fromEntries(tokens.map((t, i) => [t, str(syms[i])]));
  const fakeToken = t => !REAL[t] && LOOKS.includes(plain(sym[t])) && plain(sym[t]) !== sym[t] ? 'name only looks like ' + plain(sym[t]) + ' (hidden characters)'
    : !REAL[t] && Object.values(REAL).includes(plain(sym[t])) ? 'calls itself ' + plain(sym[t]) + ' but is not its contract' : null;
  const rows = logs.map(l => ({token: l.address.toLowerCase(), from: addr(l.topics[1]), to: addr(l.topics[2]), block: Number(BigInt(l.blockNumber)), tx: l.transactionHash}));
  // real counterparties: the other side of transfers in real tokens
  const real = new Set(rows.filter(r => REAL[r.token]).map(r => r.from === me ? r.to : r.from));
  // spoofed rows: fake-named tokens, plus "sent by this wallet" rows whose transaction this wallet did not send
  const susp = rows.filter(r => fakeToken(r.token) || r.from === me && !REAL[r.token]);
  const txs = [...new Set(susp.filter(r => r.from === me).map(r => r.tx))];
  const senders = Object.fromEntries((await rpc(txs.map(t => ['eth_getTransactionByHash', [t]]))).map((t, i) => [txs[i], t?.from?.toLowerCase()]));
  const poisoned = susp.map(r => ({...r, symbol: sym[r.token], why: [fakeToken(r.token), r.from === me && senders[r.tx] && senders[r.tx] !== me ? `shows this wallet sending, but the transaction came from ${senders[r.tx]}` : null].filter(Boolean)}))
    .filter(r => r.why.length);
  // lookalikes: any counterparty seen that copies a real counterparty's ends
  const seen = new Set(rows.map(r => r.from === me ? r.to : r.from));
  const lookalikes = [];
  for (const s of seen) for (const r of real) if (s !== r && s.slice(2, 6) === r.slice(2, 6) && s.slice(-4) === r.slice(-4)) lookalikes.push({real: r, fake: s, sameEnds: ends(r), realMiddle: r.slice(6, 14), fakeMiddle: s.slice(6, 14)});
  const flags = [];
  if (lookalikes.length) flags.push(`${lookalikes.length} lookalike address(es) in this history: pay only the full address`);
  if (poisoned.length) flags.push(`${poisoned.length} poisoned transfer(s): fake tokens or entries this wallet never sent`);
  return {chainId: 4663, address: me, window: {blocks: Number(WINDOW) * WINDOWS, toBlock: Number(latest)}, transfers: rows.length,
    realCounterparties: [...real], lookalikes, poisoned: poisoned.slice(0, 25), flags,
    verdict: lookalikes.length || poisoned.length ? 'poisoned: check every payee against the full address' : 'no poisoning seen in this window',
    by: 'JazzCat #1 (agent #26063), New Jazz City: read from Robinhood Chain'};
}
