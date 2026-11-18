// Income read: who actually paid an agent. Every USDG into the agent's wallet over N days (max 60), sorted by payer and
// labelled: its own wallets (ERC-8004 owner / agent wallet), its own withdrawals (transfers its wallet started), loans
// (Priors pool), swap proceeds (DEX routers and pool managers), and outside payers. Outside payers are the income; the rest is not. Reads Robinhood Chain only.
const RPC = 'https://rpc.mainnet.chain.robinhood.com', REGISTRY = '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const KNOWN = {'0x281210097f0de7a8fb6f87310af0f089c9c8de21': 'loan', '0x8366a39cc670b4001a1121b8f6a443a643e40951': 'swap',
  '0xbdbae060cbab0e9cfe802a7513dd5ecb36cda6c3': 'swap', '0xe8852602f84e04e284286d8db01a41edd0ccefb0': 'swap', '0x8876789976decbfcbbbe364623c63652db8c0904': 'swap'};
const BLOCKS_PER_DAY = 820000n;
const pad = a => '0x' + a.toLowerCase().slice(2).padStart(64, '0'), addr = w => '0x' + w.slice(-40).toLowerCase();
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
export async function incomeRead(target, days = 30) {
  days = Math.min(60, Math.max(1, Number(days) || 30));
  let agentId = null, wallet = null, own = new Set();
  if (/^\d+$/.test(String(target || ''))) {
    agentId = String(target); const id = BigInt(agentId).toString(16).padStart(64, '0');
    const [o, w] = await rpc([['eth_call', [{to: REGISTRY, data: '0x6352211e' + id}, 'latest']], ['eth_call', [{to: REGISTRY, data: '0x00339509' + id}, 'latest']]]);
    if (!o || o === '0x') throw new Error('No ERC-8004 agent #' + agentId + ' on Robinhood Chain; nothing was charged.');
    const owner = addr(o); own.add(owner); const aw = w && w.length >= 66 ? addr(w) : null;
    if (aw && aw !== '0x0000000000000000000000000000000000000000') own.add(aw);
    wallet = aw && aw !== '0x0000000000000000000000000000000000000000' ? aw : owner;
  } else if (/^0x[0-9a-fA-F]{40}$/.test(target || '')) { wallet = target.toLowerCase(); own.add(wallet); }
  else throw new Error('agent (an ERC-8004 id) or wallet (0x…) is required.');
  const [head] = await rpc([['eth_blockNumber', []]]); const latest = BigInt(head), from = latest > BLOCKS_PER_DAY * BigInt(days) ? latest - BLOCKS_PER_DAY * BigInt(days) : 0n;
  const logs = [];
  for (let s = from; s <= latest; s += 9000000n) {
    const e = s + 8999999n < latest ? s + 8999999n : latest;
    const [l] = await rpc([['eth_getLogs', [{address: USDG, fromBlock: '0x' + s.toString(16), toBlock: '0x' + e.toString(16), topics: [TRANSFER, null, pad(wallet)]}]]]);
    if (l) logs.push(...l);
  }
  // A transfer the agent's own wallet started (a withdrawal, refund or claim from a vault, jar or escrow) is its own money
  // coming back, or a claim it made, whatever contract the USDG moved from: label it by who sent the transaction, not by the
// token's sender, and never count it as outside pay.
  const hashes = [...new Set(logs.map(l => l.transactionHash))], starter = new Map();
  for (let i = 0; i < hashes.length; i += 50) { const txs = await rpc(hashes.slice(i, i + 50).map(h => ['eth_getTransactionByHash', [h]])); txs.forEach((t, j) => t && starter.set(hashes[i + j], t.from.toLowerCase())); }
  const by = new Map();
  for (const l of logs) {
    const from = addr(l.topics[1]), selfStarted = own.has(starter.get(l.transactionHash)) && !own.has(from) && !KNOWN[from];
    const key = selfStarted ? 'withdrawal:' + from : from, v = Number(BigInt(l.data)) / 1e6, r = by.get(key) || {payer: from, usdg: 0, transfers: 0, lastTx: null, selfStarted};
    r.usdg += v; r.transfers++; r.lastTx = l.transactionHash; by.set(key, r);
  }
  const kind = r => own.has(r.payer) ? 'own' : r.selfStarted ? 'withdrawal' : KNOWN[r.payer] || 'outside';
  const rows = [...by.values()].map(({selfStarted, ...r}) => ({...r, usdg: Math.round(r.usdg * 1e4) / 1e4, kind: kind({...r, selfStarted})})).sort((a, b) => b.usdg - a.usdg);
  const sum = k => Math.round(rows.filter(r => r.kind === k).reduce((s, r) => s + r.usdg, 0) * 1e4) / 1e4, n = k => rows.filter(r => r.kind === k).length;
  const outside = rows.filter(r => r.kind === 'outside'), top = outside[0], topShare = top && sum('outside') ? Math.round(top.usdg / sum('outside') * 1000) / 10 : 0;
  const flags = [];
  if (sum('own')) flags.push(`${sum('own')} USDG came from the agent's own wallets: not income`);
  if (sum('loan')) flags.push(`${sum('loan')} USDG were loans: not income`);
  if (sum('withdrawal')) flags.push(`${sum('withdrawal')} USDG arrived in transactions the agent's own wallet sent (withdrawals, refunds, claims or sales through contracts): not outside pay. Earned fees or escrow it claimed are income; its own deposits coming back are not. A funder trace tells which`);
  if (topShare >= 50) flags.push(`one outside payer is ${topShare}% of outside income`);
  return {chainId: 4663, agentId, wallet, days, window: {fromBlock: Number(from), toBlock: Number(latest)},
    income: {outsideUsdg: sum('outside'), outsidePayers: n('outside')}, notIncome: {ownUsdg: sum('own'), withdrawalUsdg: sum('withdrawal'), loanUsdg: sum('loan'), swapUsdg: sum('swap')},
    payers: rows.slice(0, 40), flags, verdict: `${sum('outside')} USDG from ${n('outside')} outside payers in ${days} days`,
    note: 'Outside payers can still be related to the agent off chain; a funder trace reads where their USDG came from.',
    by: 'JazzCat #1 (agent #26063), New Jazz City: read from Robinhood Chain'};
}
