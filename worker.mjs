import PRIORS_TRAIL from './trails/0xedbf91223639800bcd5756815caf908df3b890be.json' with {type: 'json'};
const TRAILS = {'0xedbf91223639800bcd5756815caf908df3b890be': PRIORS_TRAIL}; // heavy coins, read once
// Robinhood Chain transaction explainer: give it a transaction hash, get a short plain-language summary of what happened.
// Read-only. No keys, no model calls: every sentence is built from the chain's own transaction, receipt and logs.
// MCP (streamable HTTP, JSON-RPC) at POST /mcp: explain_transaction and who_controls_agent (free), money_trail, line_read, usdg_ledger (x402 links). /mcp?cat=N sells as JazzCat #N. Humans: GET /?tx=0x...
const LOG_RPCS = ['https://4663.rpc.thirdweb.com', 'https://njc-read-proxy.vercel.app/api/rpc']; // the two that serve wide filtered log ranges
const OFFICIAL = [globalThis.NJC_LOCAL ? 'https://rpc.mainnet.chain.robinhood.com' : 'https://njc-read-proxy.vercel.app/api/rpc']; // the official RPC (10M-block log windows) through a read-only proxy: it rate-limits Cloudflare's egress
const RPCS = ['https://robinhood-rpc.publicnode.com', 'https://robinhood.drpc.org', 'https://4663.rpc.thirdweb.com', 'https://rpc.mainnet.chain.robinhood.com'], EXPLORER = 'https://robinhoodchain.blockscout.com', CHAIN_ID = 4663;
const T = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  approval: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  approvalForAll: '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31',
  deposit: '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c',
  withdrawal: '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65',
  transferSingle: '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
  swapV2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  swapV3: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  swapV4: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
};
const ZERO = '0x0000000000000000000000000000000000000000', MAX = (1n << 256n) - 1n;
const addr = t => '0x' + t.slice(26).toLowerCase();
const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '?';

// One HTTP request for many calls: the public RPC rate-limits by request count.
async function rpcBatch(calls, list = RPCS) {
  for (let i = 0; ; i++) {
    const RPC = list[i % list.length];
    const r = await fetch(RPC, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(calls.map(([method, params], id) => ({jsonrpc: '2.0', id, method, params})))});
    if (r.status === 429 && i < 7) { await new Promise(res => setTimeout(res, 400 * (i + 1))); continue; }
    const j = await r.json().catch(() => null); if (!Array.isArray(j)) { if (i < 7) { await new Promise(res => setTimeout(res, 150 * (i + 1))); continue; } throw new Error('RPC unavailable (HTTP ' + r.status + ')'); }
    const out = []; for (const x of j) out[x.id] = x.error ? null : x.result; return out;
  }
}
const utf8 = h => new TextDecoder().decode(new Uint8Array(h.match(/../g).map(b => parseInt(b, 16)))).replace(/\0+$/, '');
function decodeString(hex) {
  if (!hex || hex === '0x') return null; const h = hex.slice(2);
  if (h.length === 64) return utf8(h) || null;
  try { const len = parseInt(h.slice(64, 128), 16); return utf8(h.slice(128, 128 + len * 2)) || null; } catch { return null; }
}
const meta = new Map(); let lastErr = null;
async function prefetch(addrs) {
  const need = [...new Set(addrs)].filter(a => !meta.has(a));
  const cache = globalThis.caches?.default;
  for (const a of [...need]) { const hit = cache && await cache.match('https://meta.cache/' + a); if (hit) { meta.set(a, await hit.json()); need.splice(need.indexOf(a), 1); } }
  if (!need.length) return;
  const res = await rpcBatch(need.flatMap(a => [['eth_call', [{to: a, data: '0x95d89b41'}, 'latest']], ['eth_call', [{to: a, data: '0x06fdde03'}, 'latest']], ['eth_call', [{to: a, data: '0x313ce567'}, 'latest']]])).catch(e => (lastErr = e.message, []));
  for (const [i, a] of need.entries()) { const [sym, name, dec] = [res[i * 3], res[i * 3 + 1], res[i * 3 + 2]];
    const m = {symbol: decodeString(sym) || short(a), name: decodeString(name), decimals: dec && dec !== '0x' ? Number(BigInt(dec)) : null};
    meta.set(a, m); if (cache && (sym || name)) await cache.put('https://meta.cache/' + a, new Response(JSON.stringify(m), {headers: {'cache-control': 'max-age=86400'}})); }
}
async function token(a) { if (!meta.has(a)) await prefetch([a]); return meta.get(a); }
function fmt(v, d) {
  if (d == null) return v.toString(); const neg = v < 0n; if (neg) v = -v;
  const s = v.toString().padStart(d + 1, '0'), whole = s.slice(0, s.length - d), frac = s.slice(s.length - d).replace(/0+$/, '').slice(0, 6);
  return (neg ? '-' : '') + Number(whole).toLocaleString('en-US') + (frac ? '.' + frac : '');
}
const eth = v => fmt(v, 18) + ' ETH';

export async function explain(hash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) throw new Error('A 0x-prefixed 32-byte transaction hash is required.');
  const [tx, rc] = await rpcBatch([['eth_getTransactionByHash', [hash]], ['eth_getTransactionReceipt', [hash]]]);
  if (!tx) throw new Error('No such transaction on Robinhood Chain mainnet (chain 4663).');
  if (!rc) return {hash, status: 'pending', summary: 'This transaction is still pending: it has not been included in a block yet.', facts: [], link: `${EXPLORER}/tx/${hash}`};
  const nb = BigInt(rc.blockNumber), hx = x => '0x' + x.toString(16);
  const [block, balNow, balBefore] = await rpcBatch([['eth_getBlockByNumber', [rc.blockNumber, false]], ['eth_getBalance', [tx.from, hx(nb)]], ['eth_getBalance', [tx.from, hx(nb - 1n)]]]);
  await prefetch(rc.logs.filter(l => [T.transfer, T.approval, T.approvalForAll, T.transferSingle].includes(l.topics[0])).map(l => l.address.toLowerCase()));
  const from = tx.from.toLowerCase(), to = tx.to?.toLowerCase() ?? null, value = BigInt(tx.value);
  const fee = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? tx.gasPrice ?? 0);
  const when = new Date(Number(BigInt(block.timestamp)) * 1000).toISOString().replace('.000Z', 'Z');
  const facts = [], lines = [];
  if (rc.status !== '0x1') {
    lines.push(`This transaction failed: ${short(from)} called ${to ? short(to) : 'a contract creation'}, it reverted, and nothing changed except the fee (${eth(fee)}).`);
    return {hash, status: 'failed', summary: lines.join(' '), facts, from, to, fee: eth(fee), time: when, link: `${EXPLORER}/tx/${hash}`};
  }
  const flows = new Map(), nftMoves = [], ftMoves = [], approvals = [];
  const bump = (who, tok, amt) => { const k = who + '|' + tok; flows.set(k, (flows.get(k) ?? 0n) + amt); };
  let swaps = 0, unwrapped = 0n;
  for (const l of rc.logs) {
    const t0 = l.topics[0], a = l.address.toLowerCase();
    if (t0 === T.transfer && l.topics.length === 4) nftMoves.push({token: a, from: addr(l.topics[1]), to: addr(l.topics[2]), id: BigInt(l.topics[3])});
    else if (t0 === T.transfer && l.topics.length === 3) { const amt = BigInt(l.data); const f = addr(l.topics[1]), r = addr(l.topics[2]); ftMoves.push({token: a, from: f, to: r, amount: amt}); bump(f, a, -amt); bump(r, a, amt); }
    else if (t0 === T.approval && l.topics.length === 3) approvals.push({token: a, owner: addr(l.topics[1]), spender: addr(l.topics[2]), amount: BigInt(l.data)});
    else if (t0 === T.approvalForAll) approvals.push({token: a, owner: addr(l.topics[1]), spender: addr(l.topics[2]), all: BigInt(l.data) === 1n});
    else if (t0 === T.transferSingle) nftMoves.push({token: a, from: addr(l.topics[2]), to: addr(l.topics[3]), id: BigInt('0x' + l.data.slice(2, 66)), qty: BigInt('0x' + l.data.slice(66, 130))});
    else if ([T.swapV2, T.swapV3, T.swapV4].includes(t0)) swaps++;
    else if (t0 === T.withdrawal) unwrapped += BigInt(l.data);
  }
  if (!to) lines.push(`${short(from)} deployed a new contract at ${short(rc.contractAddress)}.`);
  // What the sender gave and got, from token transfers (covers every DEX and aggregator).
  const gave = [], got = [];
  for (const [k, amt] of flows) { const [who, tok] = k.split('|'); if (who !== from || amt === 0n) continue; (amt < 0n ? gave : got).push({tok, amt: amt < 0n ? -amt : amt}); }
  if (value > 0n && (got.length || swaps)) gave.unshift({tok: 'ETH', amt: value});
  if (swaps && !got.length) {
    // Native ETH paid out by a pool leaves no token event: read the sender's balance change across the block instead.
    let eth = unwrapped;
    if (!eth && balNow && balBefore) { const d = BigInt(balNow) - BigInt(balBefore) + fee + value; if (d > 0n) eth = d; }
    if (eth > 0n) got.push({tok: 'ETH', amt: eth});
  }
  const show = async x => x.tok === 'ETH' ? eth(x.amt) : `${fmt(x.amt, (await token(x.tok)).decimals)} ${(await token(x.tok)).symbol}`;
  if (swaps || (gave.length && got.length)) {
    lines.push(`${short(from)} swapped ${(await Promise.all(gave.map(show))).join(' and ') || 'tokens'} for ${(await Promise.all(got.map(show))).join(' and ') || 'a payout not shown in token events (usually native ETH)'}${swaps ? ` through ${swaps} pool${swaps > 1 ? 's' : ''}` : ''}.`);
  }
  // NFTs.
  const byCol = new Map(); for (const m of nftMoves) { const k = m.token + '|' + (m.from === ZERO ? 'mint' : m.to === ZERO ? 'burn' : m.from + '>' + m.to); (byCol.get(k) ?? byCol.set(k, []).get(k)).push(m); }
  for (const [k, ms] of byCol) {
    const [tok, kind] = k.split('|'), m = await token(tok), ids = ms.map(x => '#' + x.id).slice(0, 8).join(', ') + (ms.length > 8 ? ` and ${ms.length - 8} more` : ''), label = m.name || m.symbol;
    if (kind === 'mint') lines.push(`${short(ms[0].to)} minted ${ms.length} ${label} (${ids})${value > 0n && ms[0].to === from ? ` for ${eth(value)}` : ''}.`);
    else if (kind === 'burn') lines.push(`${short(ms[0].from)} burned ${ms.length} ${label} (${ids}).`);
    else lines.push(`${short(ms[0].from)} moved ${ms.length} ${label} (${ids}) to ${short(ms[0].to)}.`);
  }
  // Plain token sends that aren't part of a swap by the sender.
  if (!(swaps || (gave.length && got.length))) for (const m of ftMoves.slice(0, 6)) { const t = await token(m.token), n = `${fmt(m.amount, t.decimals)} ${t.symbol}`;
    lines.push(m.to === ZERO ? `${short(m.from)} burned ${n}.` : m.from === ZERO ? `${short(m.to)} received ${n}, newly minted.` : `${short(m.from)} sent ${n} to ${short(m.to)}.`); }
  if (ftMoves.length > 6 && !(swaps || (gave.length && got.length))) lines.push(`…and ${ftMoves.length - 6} more token transfers.`);
  for (const a of approvals.slice(0, 4)) { const t = await token(a.token);
    lines.push(a.all !== undefined ? `${short(a.owner)} ${a.all ? 'let' : 'stopped letting'} ${short(a.spender)} move all of their ${t.name || t.symbol}.`
      : `${short(a.owner)} approved ${short(a.spender)} to spend ${a.amount === MAX ? 'an unlimited amount of' : fmt(a.amount, t.decimals)} ${t.symbol}${a.amount === MAX ? ' (worth checking: an unlimited approval stays live until revoked)' : ''}.`); }
  if (!lines.length && value > 0n) lines.push(`${short(from)} sent ${eth(value)} to ${short(to)}.`);
  if (!lines.length) lines.push(`${short(from)} called ${short(to)} with no token or ETH movement.`);
  lines.push(`Fee: ${eth(fee)}. Block ${Number(BigInt(rc.blockNumber)).toLocaleString('en-US')}, ${when}.`);
  facts.push(...ftMoves.map(m => ({type: 'token-transfer', token: m.token, from: m.from, to: m.to, amount: m.amount.toString()})), ...nftMoves.map(m => ({type: 'nft-transfer', token: m.token, from: m.from, to: m.to, id: m.id.toString()})), ...approvals.map(a => ({type: 'approval', token: a.token, owner: a.owner, spender: a.spender, amount: a.amount?.toString(), all: a.all})));
  return {hash, status: 'success', chainId: CHAIN_ID, ...(lastErr ? {note: 'some token names could not be read: ' + lastErr.slice(0, 120)} : {}), summary: lines.join(' '), from, to, value: eth(value), fee: eth(fee), time: when, swaps, facts, link: `${EXPLORER}/tx/${hash}`};
}


// ---- Paid: USDG ledger + reconciliation for any address (x402, settled by Toll's keyless facilitator, paid to JazzCat #1) ----
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', CAT1_WALLET = '0x1479bE07E26976Fd712db34f7Bc1B8Ac523f806e', FACILITATOR = 'https://x402.t0ll.xyz';
const LEDGER_PRICE = '50000'; // 0.05 USDG (6 decimals)
const ledgerReq = resource => ({scheme: 'exact', network: 'robinhood', maxAmountRequired: LEDGER_PRICE, resource,
  description: "USDG ledger for any Robinhood Chain address: every USDG in and out over the last N days (max 14), with counterparties, tx links and a reconciliation against the on-chain balance. JazzCat #1's audit method, automated.",
  mimeType: 'application/json', payTo: CAT1_WALLET, maxTimeoutSeconds: 300, asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/ledger?address={address}&days={days}', queryParams: {address: {type: 'string', description: 'Robinhood Chain address'}, days: {type: 'number', description: '1-14, default 7'}}}, output: {type: 'object'}},
  extra: {name: 'Global Dollar', version: '1', erc8004: {registry: 'eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', agentId: '26063', delegation: null}}});
const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export async function ledger(address, days = 7) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) throw new Error('A 0x address is required.');
  days = Math.max(1, Math.min(14, Number(days) || 7)); const a = address.toLowerCase();
  const [head] = await rpcBatch([['eth_blockNumber', []]]); const latest = BigInt(head), span = BigInt(Math.ceil(days * 86400 * 9.4)), start = latest > span ? latest - span : 0n;
  const step = 9000000n, ranges = []; for (let s = start; s <= latest; s += step) ranges.push([s, s + step - 1n < latest ? s + step - 1n : latest]);
  const hx = x => '0x' + x.toString(16), calls = [];
  for (const [f, t] of ranges) { calls.push(['eth_getLogs', [{address: USDG, fromBlock: hx(f), toBlock: hx(t), topics: [T.transfer, pad(a)]}]]); calls.push(['eth_getLogs', [{address: USDG, fromBlock: hx(f), toBlock: hx(t), topics: [T.transfer, null, pad(a)]}]]); }
  const res = await rpcBatch([...calls, ['eth_call', [{to: USDG, data: '0x70a08231' + pad(a).slice(2)}, 'latest']]], OFFICIAL);
  if (res.slice(0, -1).some(x => x == null)) throw new Error('Could not read the full window right now; nothing was charged. Try again.');
  const balance = BigInt(res.pop() || '0x0'), seen = new Set(), rows = [];
  for (const logs of res) for (const l of logs || []) { const k = l.transactionHash + l.logIndex; if (seen.has(k)) continue; seen.add(k);
    const from = addr(l.topics[1]), to = addr(l.topics[2]), v = BigInt(l.data); rows.push({block: Number(BigInt(l.blockNumber)), tx: l.transactionHash, dir: from === a ? 'out' : 'in', counterparty: from === a ? to : from, usdg: fmt(v, 6), raw: v}); }
  rows.sort((x, y) => x.block - y.block);
  const inSum = rows.filter(r => r.dir === 'in').reduce((s, r) => s + r.raw, 0n), outSum = rows.filter(r => r.dir === 'out').reduce((s, r) => s + r.raw, 0n);
  const by = new Map(); for (const r of rows) { const c = by.get(r.counterparty) ?? {in: 0n, out: 0n, n: 0}; c[r.dir] += r.raw; c.n++; by.set(r.counterparty, c); }
  const counterparties = [...by].map(([k, c]) => ({address: k, in: fmt(c.in, 6), out: fmt(c.out, 6), transfers: c.n})).sort((x, y) => y.transfers - x.transfers).slice(0, 25);
  const opening = balance - inSum + outSum;
  return {address: a, chainId: CHAIN_ID, windowDays: days, fromBlock: Number(start), toBlock: Number(latest), transfers: rows.length,
    usdgIn: fmt(inSum, 6), usdgOut: fmt(outSum, 6), balanceNow: fmt(balance, 6), impliedOpeningBalance: fmt(opening, 6),
    reconciles: opening >= 0n, note: opening >= 0n ? 'Balance now = opening + in - out over the window.' : 'Negative implied opening balance: transfers outside the window or a non-standard token path.',
    counterparties, rows: rows.slice(-200).map(({raw, ...r}) => ({...r, link: `${EXPLORER}/tx/${r.tx}`})), by: "JazzCat #1, New Jazz City"};
}

// ---- Paid: credit-line read for a lender, before a line opens (1 USDG via x402 to JazzCat #1) ----
const REGISTRY_8004 = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', LINE_PRICE = '1000000';
const lineReq = resource => ({...ledgerReq(resource), maxAmountRequired: LINE_PRICE,
  description: "Credit-line read before a lender opens a line to an agent: who holds the ERC-8004 agent ID and since when, its agent wallet, whether the wallet matches, the wallet's USDG history and any existing line on the lender's vault. JazzCat #1, independent: it holds no line in what it reads.",
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/line-read?agentId={agentId}&vault={vault}&wallet={wallet}', queryParams: {agentId: {type: 'string'}, vault: {type: 'string', description: 'lender vault (optional)'}, wallet: {type: 'string', description: 'wallet the line would go to (optional)'}}}, output: {type: 'object'}}});
export async function lineRead(agentId, vault, wallet) {
  if (!/^\d+$/.test(agentId || '')) throw new Error('agentId (ERC-8004 id on Robinhood Chain) is required.');
  const id = BigInt(agentId), idHex = '0x' + id.toString(16).padStart(64, '0');
  const [owner, agentWallet, head] = await rpcBatch([
    ['eth_call', [{to: REGISTRY_8004, data: '0x6352211e' + idHex.slice(2)}, 'latest']],
    ['eth_call', [{to: REGISTRY_8004, data: '0x00339509' + idHex.slice(2)}, 'latest']],
    ['eth_blockNumber', []]], LOG_RPCS);
  const ownerAddr = owner && owner.length >= 66 ? addr(owner.slice(0, 66)) : null, aw = agentWallet && agentWallet.length >= 66 && !/^0x0+$/.test(agentWallet) ? addr(agentWallet.slice(0, 66)) : null;
  // ID history: every Transfer of this token on the registry (mint and resales).
  const latest = BigInt(head), step = 10000000n, hx = x => '0x' + x.toString(16), calls = [];
  for (let s = 34600000n; s <= latest; s += step) calls.push(['eth_getLogs', [{address: REGISTRY_8004, fromBlock: hx(s), toBlock: hx(s + step - 1n < latest ? s + step - 1n : latest), topics: [T.transfer, null, null, idHex]}]]);
  const got = await rpcBatch(calls, OFFICIAL); if (got.some(x => x == null)) throw new Error('Could not read the agent ID history right now; nothing was charged. Try again.');
  const logs = got.flat().filter(Boolean).sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)));
  const transfers = logs.map(l => ({block: Number(BigInt(l.blockNumber)), from: addr(l.topics[1]), to: addr(l.topics[2]), tx: l.transactionHash}));
  const flags = [], target = (wallet || aw || '').toLowerCase();
  if (!ownerAddr || ownerAddr === '0x0000000000000000000000000000000000000000') flags.push('agent ID has no owner on this registry');
  if (!aw) flags.push('no agent wallet set on the Robinhood registry');
  if (wallet && aw && wallet.toLowerCase() !== aw) flags.push('the line wallet is not the agent wallet the registry names');
  const resales = transfers.filter(t => !/^0x0+$/.test(t.from)).length;
  if (resales) flags.push(`agent ID changed hands ${resales} time(s) since mint; last at block ${transfers[transfers.length - 1].block}`);
  let walletHistory = null; if (target) { try { const L = await ledger(target, 14); walletHistory = {usdgIn: L.usdgIn, usdgOut: L.usdgOut, balanceNow: L.balanceNow, transfers: L.transfers, counterparties: L.counterparties.slice(0, 8)}; if (!L.transfers) flags.push('no USDG history in the last 14 days'); } catch (e) { throw new Error('Could not read the wallet history right now; nothing was charged. Try again.'); } }
  let existingLine = null; if (vault && /^0x[0-9a-fA-F]{40}$/.test(vault)) { const [ln] = await rpcBatch([['eth_call', [{to: vault, data: '0x1c86bc85' + idHex.slice(2)}, 'latest']]], LOG_RPCS);
    if (ln && ln.length >= 2 + 64 * 5) { const w = ln.slice(2).match(/.{64}/g); existingLine = {wallet: '0x' + w[0].slice(24), limit: fmt(BigInt('0x' + w[1]), 6), drawn: fmt(BigInt('0x' + w[2]), 6), borrows: Number(BigInt('0x' + w[3])), repays: Number(BigInt('0x' + w[4]))}; } }
  return {agentId: agentId, chainId: CHAIN_ID, registry: REGISTRY_8004, owner: ownerAddr, agentWallet: aw, lineWallet: wallet || null, idHistory: {minted: transfers[0]?.block ?? null, transfers}, walletHistory, existingLine, flags,
    verdict: flags.length ? 'read the flags before opening' : 'no flags', by: 'JazzCat #1 (agent #26063), independent: holds no line in what it reads'};
}

// ---- Paid: money trail for a Robinhood Chain coin (1 USDG via x402 to JazzCat #1) ----
const KNOWN = {'0x8366a39cc670b4001a1121b8f6a443a643e40951': 'Uniswap v4 PoolManager: pool liquidity, not a holder'};
const TRAIL_PRICE = '1000000', REG_START = 34600000n, ZERO_A = '0x0000000000000000000000000000000000000000', DEAD = '0x000000000000000000000000000000000000dead';
const trailReq = resource => ({...ledgerReq(resource), maxAmountRequired: TRAIL_PRICE,
  description: "Money trail for a Robinhood Chain coin: who launched it and through what, where the minted supply went, who bought in the first blocks, the top holders (wallet or contract) and their share, and the launcher's USDG in and out. JazzCat #1, independent: read from the chain, nothing taken from the project.",
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/money-trail?token={token}', queryParams: {token: {type: 'string', description: 'ERC-20 address on Robinhood Chain'}}}, output: {type: 'object'}}});
async function tokenLogs(token, latest) {
  // One window per request (the official RPC rate-limits batches by size); a window that fails or is too big splits in ten.
  const hx = x => '0x' + x.toString(16), out = [], todo = [];
  for (let s = REG_START; s <= latest; s += 10000000n) todo.push([s, s + 9999999n < latest ? s + 9999999n : latest]);
  let calls = 0;
  while (todo.length) {
    const [f, t] = todo.shift();
    if (++calls > 400) throw new Error('This coin has too much history to read in one call; nothing was charged.');
    const [r] = await rpcBatch([['eth_getLogs', [{address: token, fromBlock: hx(f), toBlock: hx(t), topics: [T.transfer]}]]], OFFICIAL).catch(() => [null]);
    if (r) { out.push(...r); continue; }
    if (t - f < 20000n) throw new Error('Could not read the full transfer history right now; nothing was charged. Try again.');
    const step = (t - f + 1n) / 10n; for (let s = f; s <= t; s += step) todo.unshift([s, s + step - 1n < t ? s + step - 1n : t]);
    await new Promise(res => setTimeout(res, 300));
  }
  return out.filter(l => l.topics.length === 3).sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
}
export async function moneyTrail(token) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token || '')) throw new Error('token (an ERC-20 address on Robinhood Chain) is required.');
  token = token.toLowerCase();
  const [sym, name, dec, supply, head] = await rpcBatch([['eth_call', [{to: token, data: '0x95d89b41'}, 'latest']], ['eth_call', [{to: token, data: '0x06fdde03'}, 'latest']], ['eth_call', [{to: token, data: '0x313ce567'}, 'latest']], ['eth_call', [{to: token, data: '0x18160ddd'}, 'latest']], ['eth_blockNumber', []]], OFFICIAL);
  if (!supply || supply === '0x') throw new Error('Not an ERC-20 on Robinhood Chain (no totalSupply).');
  const d = dec && dec !== '0x' ? Number(BigInt(dec)) : 18, total = BigInt(supply), f = v => fmt(v, d), pct = v => total ? Number(v * 10000n / total) / 100 : 0;
  const logs = await tokenLogs(token, BigInt(head));
  if (!logs.length) throw new Error('No transfers found for this token.');
  const bal = new Map(), add = (a, v) => bal.set(a, (bal.get(a) ?? 0n) + v);
  const rows = logs.map(l => ({block: Number(BigInt(l.blockNumber)), tx: l.transactionHash, from: addr(l.topics[1]), to: addr(l.topics[2]), v: BigInt(l.data === '0x' ? 0 : l.data)}));
  for (const r of rows) { if (r.from !== ZERO_A) add(r.from, -r.v); add(r.to, r.v); }
  const mints = rows.filter(r => r.from === ZERO_A), burned = rows.filter(r => r.to === ZERO_A || r.to === DEAD).reduce((s, r) => s + r.v, 0n);
  const first = mints[0] ?? rows[0];
  const [launchTx] = await rpcBatch([['eth_getTransactionByHash', [first.tx]]], OFFICIAL);
  const launcher = launchTx?.from?.toLowerCase() ?? null, via = launchTx?.to?.toLowerCase() ?? null;
  // Where the minted supply went: the biggest transfers out of each mint recipient.
  const mintTo = [...new Set(mints.map(m => m.to))].slice(0, 3);
  const supplyOut = mintTo.map(a => ({from: a, minted: f(mints.filter(m => m.to === a).reduce((s, m) => s + m.v, 0n)),
    sentTo: rows.filter(r => r.from === a).sort((x, y) => (y.v > x.v ? 1 : -1)).slice(0, 6).map(r => ({to: r.to, amount: f(r.v), pctOfSupply: pct(r.v), block: r.block, tx: r.tx}))}));
  // First buyers: recipients in the first 20 blocks after launch, other than the mint itself.
  const early = rows.filter(r => r.block <= first.block + 20 && r.from !== ZERO_A && r.to !== ZERO_A);
  const earlyBuyers = [...new Map(early.filter(r => !KNOWN[r.to] && r.to !== token && r.to !== via && r.to !== DEAD && r.to !== ZERO_A).map(r => [r.to, r])).values()].slice(0, 12).map(r => ({wallet: r.to, from: r.from, amount: f(r.v), pctOfSupply: pct(r.v), blocksAfterLaunch: r.block - first.block, holdsNow: f(bal.get(r.to) ?? 0n), isLauncher: r.to === launcher}));
  const top = [...bal].filter(([a, v]) => v > 0n && a !== ZERO_A && a !== DEAD).sort((x, y) => (y[1] > x[1] ? 1 : -1)).slice(0, 10);
  const codes = await rpcBatch(top.map(([a]) => ['eth_getCode', [a, 'latest']]), OFFICIAL);
  const holders = top.map(([a, v], i) => ({address: a, amount: f(v), pctOfSupply: pct(v), kind: KNOWN[a] ? 'pool' : codes[i] && codes[i] !== '0x' ? 'contract' : 'wallet', label: KNOWN[a], isLauncher: a === launcher}));
  let launcherUsdg = null; if (launcher) { try { const L = await ledger(launcher, 14); launcherUsdg = {usdgIn: L.usdgIn, usdgOut: L.usdgOut, balanceNow: L.balanceNow, transfers: L.transfers, counterparties: L.counterparties.slice(0, 8)}; } catch { throw new Error('Could not read the launcher\'s USDG history right now; nothing was charged. Try again.'); } }
  const flags = [], walletTop = holders.filter(h => h.kind === 'wallet'), top10w = walletTop.reduce((s, h) => s + h.pctOfSupply, 0);
  const lh = holders.find(h => h.isLauncher); if (lh && lh.pctOfSupply >= 5) flags.push(`the launcher's wallet still holds ${lh.pctOfSupply}% of supply`);
  if (walletTop[0] && walletTop[0].pctOfSupply >= 10) flags.push(`one wallet holds ${walletTop[0].pctOfSupply}% of supply`);
  if (top10w >= 40) flags.push(`the top wallets (not contracts) hold ${Math.round(top10w * 100) / 100}% of supply`);
  const fast = earlyBuyers.filter(b => b.blocksAfterLaunch <= 5 && !b.isLauncher); if (fast.length >= 3) flags.push(`${fast.length} wallets received the coin within 5 blocks of launch: snipers or a bundle, read the list`);
  const devBuy = earlyBuyers.find(b => b.wallet === launcher); if (devBuy && (bal.get(launcher) ?? 0n) * 10n < BigInt(Math.round(devBuy.pctOfSupply * 100)) * total / 100000n) flags.push(`the launcher took ${devBuy.pctOfSupply}% in the launch block and now holds ${pct(bal.get(launcher) ?? 0n)}%`);
  if (mints.length > 1) flags.push(`minted ${mints.length} times, not once: supply can grow`);
  return {token, chainId: CHAIN_ID, symbol: decodeString(sym), name: decodeString(name), decimals: d, totalSupply: f(total), burned: f(burned), transfers: rows.length,
    launch: {block: first.block, tx: first.tx, launcher, via, mintedTo: mintTo}, supplyOut, earlyBuyers, topHolders: holders, launcherUsdg, flags,
    verdict: flags.length ? 'read the flags' : 'no flags', by: 'JazzCat #1 (agent #26063), independent: read from the chain'};
}

// ERC-8004 agent card for JazzCat #1 as a seller: its paid endpoints and the wallet it is paid in.
const CAT1_CARD = {type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'JazzCat #1',
  description: 'JazzCat #1, New Jazz City: an on-chain jazz cat on Robinhood Chain that sells chain reads to agents over x402. Credit-line read before a lender opens a line (1 USDG), money trail for any coin (1 USDG), USDG ledger for any address (0.05 USDG), free transaction explainer. Paid in USDG straight into its own token-bound wallet.',
  image: 'https://jazzcatsfun.pages.dev/agents/1.svg',
  services: [
    {name: 'x402', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/line-read', version: '1'},
    {name: 'x402', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/money-trail', version: '1'},
    {name: 'x402', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/ledger', version: '1'},
    {name: 'MCP', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/mcp', version: '2025-06-18'},
    {name: 'web', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/'}],
  x402Support: true, active: true, supportedTrust: ['reputation'],
  registrations: [{agentId: 26063, agentRegistry: 'eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'}, {agentId: 26026, agentRegistry: 'eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', note: 'first registration, held by Adapter; no agent wallet'}],
  agentWallet: 'eip155:4663:' + '0x1479bE07E26976Fd712db34f7Bc1B8Ac523f806e'};

// Every Cat sells: ?cat=N on a paid route (or /mcp?cat=N) is paid to JazzCat #N's own ERC-6551 wallet (registry account(), AccountV3, salt 0).
// No cat, or cat=1, is the original path: JazzCat #1, 0x1479…806e, agent #26063.
const GENESIS = '0xB3D33Af2cE8cE0792942B487E2213ac665DD83E2', REG6551 = '0x000000006551c19487814612e58FE06813775758', ACCOUNT_V3 = '0x41C8f39463A868d3A88af00cd0fe7102F30E44eC';
const catWallets = new Map([['1', CAT1_WALLET]]);
// Base USDC is paid to the Cat's holder, not its 6551 wallet (that wallet exists on Robinhood Chain only), and only when the
// holder is a plain wallet: the same key holds that address on Base. Settled by PayAI's keyless facilitator.
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', BASE_FACILITATOR = 'https://facilitator.payai.network', catHolders = new Map();
async function catHolderEOA(n) {
  if (catHolders.has(n)) return catHolders.get(n);
  const [owner] = await rpcBatch([['eth_call', [{to: GENESIS, data: '0x6352211e' + BigInt(n).toString(16).padStart(64, '0')}, 'latest']]]);
  const holder = owner && owner.length >= 66 ? '0x' + owner.slice(26) : null;
  const [code] = holder ? await rpcBatch([['eth_getCode', [holder, 'latest']]]) : [null];
  const eoa = holder && code === '0x' ? holder : null; catHolders.set(n, eoa); return eoa;
}
async function catWallet(n) {
  if (!/^[1-9]\d{0,5}$/.test(n || '')) throw new Error('cat must be a JazzCat token id');
  if (catWallets.has(n)) return catWallets.get(n);
  const id = BigInt(n).toString(16).padStart(64, '0'), w = a => a.toLowerCase().slice(2).padStart(64, '0');
  const [owner, acct] = await rpcBatch([['eth_call', [{to: GENESIS, data: '0x6352211e' + id}, 'latest']],
    ['eth_call', [{to: REG6551, data: '0x246a0021' + w(ACCOUNT_V3) + '0'.repeat(64) + CHAIN_ID.toString(16).padStart(64, '0') + w(GENESIS) + id}, 'latest']]]);
  if (!owner || owner === '0x' || !acct) throw new Error('No JazzCat #' + n + ' on Robinhood Chain.');
  const wallet = '0x' + acct.slice(26); catWallets.set(n, wallet); return wallet;
}
const catCard = (n, wallet, origin) => ({type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'JazzCat #' + n,
  description: `JazzCat #${n}, New Jazz City: an on-chain jazz cat on Robinhood Chain that sells chain reads to agents over x402, paid in USDG to its own wallet. Credit-line read (1 USDG), money trail for any coin (1 USDG), USDG ledger for any address (0.05 USDG), free transaction explainer and agent-control check.`,
  image: `https://jazzcatsfun.pages.dev/agents/${n}.svg`,
  services: [...['line-read', 'money-trail', 'ledger'].map(r => ({name: 'x402', endpoint: `${origin}/x402/${r}?cat=${n}`, version: '1'})),
    {name: 'MCP', endpoint: `${origin}/mcp?cat=${n}`, version: '2025-06-18'}, {name: 'web', endpoint: origin + '/'}],
  x402Support: true, active: true, supportedTrust: ['reputation'], agentWallet: 'eip155:4663:' + wallet,
  token: {chainId: 4663, contract: GENESIS, tokenId: n, account: 'ERC-6551 AccountV3, owned by whoever holds the Cat'}});

// ---- Free: who controls an ERC-8004 agent now, and since when (for registries and listing pages) ----
export async function control(agentId) {
  if (!/^\d+$/.test(agentId || '')) throw new Error('agentId (ERC-8004 id on Robinhood Chain) is required.');
  const id = BigInt(agentId), idHex = '0x' + id.toString(16).padStart(64, '0');
  const [owner, agentWallet, uri, head] = await rpcBatch([
    ['eth_call', [{to: REGISTRY_8004, data: '0x6352211e' + idHex.slice(2)}, 'latest']],
    ['eth_call', [{to: REGISTRY_8004, data: '0x00339509' + idHex.slice(2)}, 'latest']],
    ['eth_call', [{to: REGISTRY_8004, data: '0xc87b56dd' + idHex.slice(2)}, 'latest']],
    ['eth_blockNumber', []]], OFFICIAL);
  if (!owner || owner.length < 66) throw new Error('No agent #' + agentId + ' on the Robinhood Chain registry.');
  // Newest window first, one request each, stopping at the mint: most agents need one or two reads.
  const latest = BigInt(head), hx = x => '0x' + x.toString(16), found = [];
  for (let t = latest; t >= 34600000n; t -= 10000000n) {
    const f = t - 9999999n > 34600000n ? t - 9999999n : 34600000n;
    const [r] = await rpcBatch([['eth_getLogs', [{address: REGISTRY_8004, fromBlock: hx(f), toBlock: hx(t), topics: [T.transfer, null, null, idHex]}]]], OFFICIAL);
    if (r == null) throw new Error('Could not read the history right now. Try again.');
    found.push(...r); if (r.some(l => /^0x0+$/.test(l.topics[1]))) break;
  }
  const tr = found.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)));
  const last = tr[tr.length - 1], blocks = [...new Set([tr[0], last].filter(Boolean).map(l => l.blockNumber))];
  const ts = blocks.length ? await rpcBatch(blocks.map(b => ['eth_getBlockByNumber', [b, false]]), OFFICIAL) : [];
  const at = b => { const i = blocks.indexOf(b); return ts[i] ? new Date(Number(BigInt(ts[i].timestamp)) * 1000).toISOString() : null; };
  const aw = agentWallet && agentWallet.length >= 66 && !/^0x0+$/.test(agentWallet) ? addr(agentWallet.slice(0, 66)) : null, o = addr(owner.slice(0, 66));
  const [code] = await rpcBatch([['eth_getCode', [o, 'latest']]], OFFICIAL);
  return {agentId: String(agentId), chainId: CHAIN_ID, registry: REGISTRY_8004, card: decodeString(uri),
    controller: {address: o, kind: code && code !== '0x' ? 'contract' : 'wallet', since: last ? {block: Number(BigInt(last.blockNumber)), time: at(last.blockNumber), tx: last.transactionHash} : null},
    minted: tr[0] ? {block: Number(BigInt(tr[0].blockNumber)), time: at(tr[0].blockNumber)} : null, holders: tr.length, changedHands: Math.max(0, tr.length - 1),
    agentWallet: aw, paysWhere: aw ? 'its registered agent wallet' : 'not set: a payment to this agent cannot be checked against its identity',
    by: 'JazzCat #1 (agent #26063), New Jazz City. Free read from the chain.'};
}

// Usage counts per route per day (approximate: KV is not atomic). GET /stats reads them.
async function count(env, ctx, route) {
  if (!env?.USAGE) return;
  const k = new Date().toISOString().slice(0, 10) + ':' + route;
  ctx?.waitUntil((async () => { const n = Number(await env.USAGE.get(k)) || 0; await env.USAGE.put(k, String(n + 1), {expirationTtl: 400 * 86400}); })());
}
// Every free explanation points at the paid read that goes deeper.
const NEXT = (origin, r) => ({moneyTrail: (r.tokens?.[0] || r.facts?.find?.(f => f.token)?.token) ? origin + '/x402/money-trail?token=' + (r.tokens?.[0] || r.facts.find(f => f.token).token) + ' (1 USDG): who launched the coin, who sold at launch, where its supply sits' : undefined,
  ledger: r.from ? origin + '/x402/ledger?address=' + r.from + ' (0.05 USDG): every USDG this wallet moved, reconciled' : undefined});

// ---- Free coin page: the headline of a money trail, with the full read one x402 call away ----
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
function coinHeadline(r) {
  const launchBlock = r.earlyBuyers.filter(b => b.blocksAfterLaunch === 0 && !b.isLauncher && b.wallet !== r.launch?.launcher && !KNOWN[b.wallet]), still = launchBlock.filter(b => !/^0(\.0+)?$/.test(b.holdsNow));
  const launcher = r.topHolders.find(h => h.isLauncher), topWallet = r.topHolders.find(h => h.kind === 'wallet');
  return {symbol: r.symbol, token: r.token, minted: r.flags.some(f => f.startsWith('minted')) ? 'more than once' : 'once',
    launchBlockBuyers: launchBlock.length, launchBlockPct: Math.round(launchBlock.reduce((s, b) => s + b.pctOfSupply, 0) * 100) / 100, stillHolding: still.length,
    launcherPct: launcher ? launcher.pctOfSupply : 0, topWallet: topWallet ? {address: topWallet.address, pct: topWallet.pctOfSupply} : null,
    pool: r.topHolders.filter(h => h.kind === 'pool').reduce((s, h) => s + h.pctOfSupply, 0), flags: r.flags, transfers: r.transfers, launch: r.launch};
}
// The Book: New Jazz City's paid jobs, read from the ReceiptBook contract on Robinhood Chain (one row per payment, in order).
const BOOK = '0x1fa93616bf71263559faf09ced9ba77574555213', BOOK_FROM = 116385133, RECORDED = '0xbb9cdf5ef8abf299ead3bf12616f79df4289c01d584304606963869555ea20cf';
async function bookRows() {
  const [logs] = await rpcBatch([['eth_getLogs', [{address: BOOK, fromBlock: '0x' + BOOK_FROM.toString(16), toBlock: 'latest', topics: [RECORDED]}]]], OFFICIAL);
  return (logs || []).map(l => {
    const d = l.data.slice(2), w = i => d.slice(i * 64, i * 64 + 64), off = parseInt(w(4), 16) * 2, len = parseInt(d.slice(off, off + 64), 16) * 2;
    return {seq: parseInt(l.topics[1], 16), buyer: '0x' + l.topics[2].slice(26), token: '0x' + l.topics[3].slice(26), amount: Number(BigInt('0x' + w(0))) / 1e6,
      chainId: Number(BigInt('0x' + w(1))), payTx: '0x' + w(2), workHash: '0x' + w(3), label: utf8(d.slice(off + 64, off + 64 + len)), recordTx: l.transactionHash};
  }).sort((a, b) => a.seq - b.seq);
}
async function bookPage(url) {
  const rows = await bookRows(), total = rows.reduce((a, r) => a + r.amount, 0), buyers = new Set(rows.map(r => r.buyer)).size;
  if (url.pathname === '/book.json') return json({book: BOOK, chainId: CHAIN_ID, receipts: rows.length, total, buyers, rows});
  const tr = rows.map(r => `<tr><td>${r.seq}</td><td>${esc(r.label)}</td><td>${esc(r.amount)} USDG</td><td><a href="${EXPLORER}/address/${r.buyer}">${short(r.buyer)}</a></td><td><a href="${EXPLORER}/tx/${r.payTx}">payment</a></td><td><a href="${EXPLORER}/tx/${r.recordTx}">receipt</a></td></tr>`).join('');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Book · New Jazz City</title>
<style>:root{--bg:#0b0b10;--fg:#e9e6ff;--mute:#9a95b8;--line:#2a2840;--acc:#6ee7ff}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}main{max-width:900px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}p{color:var(--mute);margin:4px 0 16px}table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--mute);font-weight:500}a{color:var(--acc)}.wrap{overflow-x:auto}</style></head>
<body><main><h1>The Book</h1><p>Every paid job New Jazz City's Cats have done, in order, written on Robinhood Chain by the house. ${rows.length} receipts · ${esc(Math.round(total * 100) / 100)} USDG · ${buyers} buyers. Book contract <a href="${EXPLORER}/address/${BOOK}">${short(BOOK)}</a>; every row links its payment.</p>
<div class="wrap"><table><thead><tr><th>#</th><th>Job</th><th>Paid</th><th>Buyer</th><th></th><th></th></tr></thead><tbody>${tr}</tbody></table></div></main></body></html>`, {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300'}});
}
async function coinPage(url, env, ctx) {
  const token = (url.searchParams.get('token') || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) return new Response('token=0x… required', {status: 400});
  const key = new Request('https://coin.cache/' + token), cache = caches.default, hit = await cache.match(key);
  let h; if (hit) h = await hit.json(); else { const r = TRAILS[token] ?? await moneyTrail(token); h = coinHeadline(r); ctx?.waitUntil(cache.put(key, new Response(JSON.stringify(h), {headers: {'cache-control': 'public, max-age=3600'}}))); }
  if (url.searchParams.get('format') === 'json') return json(h);
  const pay = url.origin + '/x402/money-trail?token=' + token;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(h.symbol)} money trail · JazzCat #1</title>
<style>:root{--bg:#0d0d0f;--fg:#ece9e1;--mut:#9a958a;--ac:#e8c35b}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-monospace,Menlo,monospace}main{max-width:680px;margin:0 auto;padding:28px 16px}h1{font-size:22px;margin:0 0 4px}small,.m{color:var(--mut)}li{margin:6px 0}a{color:var(--ac)}code{word-break:break-all}.box{border:1px solid #2a2a2e;padding:14px 16px;border-radius:8px;margin:18px 0}</style></head><body><main>
<h1>$${esc(h.symbol)}: the money trail, from the chain</h1><small>Robinhood Chain · <code>${esc(token)}</code> · ${esc(h.transfers)} transfers read · by JazzCat #1 (agent #26063), New Jazz City</small>
<div class="box"><ul>
<li>Minted <b>${esc(h.minted)}</b>${h.launch?.launcher ? `, launched by <code>${esc(h.launch.launcher)}</code>` : ''}.</li>
<li>${h.launchBlockBuyers ? `<b>${esc(h.launchBlockBuyers)}</b> wallets besides the launcher took <b>${esc(h.launchBlockPct)}%</b> in the launch block; <b>${esc(h.stillHolding)}</b> still hold.` : 'No wallet besides the launcher bought in the launch block.'}</li>
<li>The launcher's wallet holds <b>${esc(h.launcherPct)}%</b> now.</li>
${h.topWallet ? `<li>Biggest plain wallet: <code>${esc(h.topWallet.address)}</code>, <b>${esc(h.topWallet.pct)}%</b>.</li>` : ''}
${h.pool ? `<li>In Uniswap v4 pools: <b>${esc(Math.round(h.pool * 100) / 100)}%</b>.</li>` : ''}
${h.flags.map(f => `<li class="m">flag: ${esc(f)}</li>`).join('')}
</ul></div>
<p>The full read: where the minted supply went, every launch-block buyer and what they hold now, the top 10 holders (wallet, contract or pool), and the launcher's USDG in and out. <b>1 USDG over x402</b>, paid to the Cat's own wallet, verified payee on Toll:</p>
<p><code>GET ${esc(pay)}</code></p>
<p class="m">Free tools: <a href="${esc(url.origin)}/?tx=">explain any transaction</a> · <a href="${esc(url.origin)}/control?agentId=26063">who controls an agent</a> · MCP at <code>${esc(url.origin)}/mcp</code></p>
</main></body></html>`;
  return new Response(html, {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600'}});
}
const b64 = o => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
// x402 v1 names the network "robinhood"; v2 clients want CAIP-2 "eip155:4663". Offer both, settle whichever the payer signed.
const v2Of = r => ({scheme: 'exact', network: 'eip155:' + CHAIN_ID, amount: r.maxAmountRequired, asset: r.asset, payTo: r.payTo, maxTimeoutSeconds: r.maxTimeoutSeconds, extra: r.extra});
const H402 = {'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-PAYMENT-RESPONSE, PAYMENT-RESPONSE, PAYMENT-REQUIRED'};
async function paid(req, url, work, reqOf = ledgerReq) {
  const cat = url.searchParams.get('cat'), seller = cat && cat !== '1' ? await catWallet(cat).catch(() => null) : null;
  if (cat && cat !== '1' && !seller) return json({error: 'No JazzCat #' + cat + ' on Robinhood Chain.'}, 404);
  const base = reqOf(url.origin + url.pathname + url.search), requirement = seller ? {...base, payTo: seller, extra: {name: base.extra.name, version: base.extra.version}} : base;
  const holder = await catHolderEOA(cat || '1').catch(() => null);
  const baseReq = holder ? {...requirement, network: 'base', payTo: holder, asset: BASE_USDC, extra: {name: 'USD Coin', version: '2'}} : null, base2 = baseReq && {...v2Of(baseReq), network: 'eip155:8453'};
  const req2 = v2Of(requirement), header = req.headers.get('x-payment') || req.headers.get('payment-signature');
  const offer = (error, status = 402) => new Response(JSON.stringify({x402Version: 1, error, accepts: [requirement, {...requirement, network: 'eip155:' + CHAIN_ID}, ...(baseReq ? [baseReq] : [])]}), {status, headers: {...H402, 'payment-required': b64({x402Version: 2, error, resource: {url: requirement.resource, description: requirement.description, mimeType: 'application/json'}, accepts: [req2, ...(base2 ? [base2] : [])]})}});
  if (!header) return offer('Payment required');
  let payload; try { payload = JSON.parse(decodeURIComponent(escape(atob(header)))); } catch { return offer('Bad payment header'); }
  const net = payload.accepted?.network ?? payload.network ?? '', onBase = net === 'base' || net === 'eip155:8453';
  if (onBase && !baseReq) return offer('This Cat takes Base USDC only when its holder is a plain wallet; pay on Robinhood Chain');
  const isV2 = payload.x402Version === 2 || /^eip155:/.test(net), chosen = onBase ? baseReq : requirement, facilitator = onBase ? BASE_FACILITATOR : FACILITATOR;
  const body = JSON.stringify(isV2 ? {x402Version: 2, paymentPayload: payload, paymentRequirements: onBase ? base2 : req2} : {x402Version: payload.x402Version ?? 1, paymentPayload: payload, paymentRequirements: chosen});
  const v = await fetch(facilitator + '/verify', {method: 'POST', headers: {'content-type': 'application/json'}, body}).then(r => r.json()).catch(e => ({isValid: false, invalidReason: e.message}));
  if (!v.isValid) return offer(v.invalidReason || 'Payment not valid');
  let result; try { result = await work(); } catch (e) { return json({error: e.message}, 400); } // a failed read is never charged
  const st = await fetch(facilitator + '/settle', {method: 'POST', headers: {'content-type': 'application/json'}, body}).then(r => r.json()).catch(e => ({success: false, errorReason: e.message}));
  if (!st.success) return offer(st.errorReason || 'Settlement failed');
  return new Response(JSON.stringify({...result, payment: {tx: st.transaction, payer: st.payer, paidTo: chosen.payTo, network: onBase ? 'base' : 'robinhood'}}), {headers: {...H402, 'x-payment-response': b64(st), 'payment-response': b64(st)}});
}
const TOOL = {name: 'explain_transaction', title: 'Explain a Robinhood Chain transaction',
  description: 'Takes a Robinhood Chain (chain 4663) transaction hash and returns a short plain-language summary of what happened: swaps, token and NFT transfers, mints, burns, approvals (flags unlimited ones), contract deployments, failures and the fee. Read-only; built from the chain\'s own data, no model in the loop.',
  inputSchema: {type: 'object', properties: {hash: {type: 'string', description: '0x-prefixed transaction hash'}}, required: ['hash']}};
const CONTROL_TOOL = {name: 'who_controls_agent', title: 'Who controls an ERC-8004 agent',
  description: 'Free. For an ERC-8004 agent id on Robinhood Chain: who holds it, its agent wallet, whether they match, and its registration URI. Read from the chain.',
  inputSchema: {type: 'object', properties: {agentId: {type: 'string', description: 'ERC-8004 agent id'}}, required: ['agentId']}};
const PAID_TOOLS = [
  {name: 'money_trail', route: 'money-trail', price: '1', title: 'Money trail for a Robinhood Chain coin', description: 'Paid, 1 USDG over x402: who launched a coin and through what, where the supply went, launch-block buyers, top holders. Returns the x402 payment link; call it with payment for the read.',
    inputSchema: {type: 'object', properties: {token: {type: 'string', description: 'coin contract 0x…'}}, required: ['token']}},
  {name: 'line_read', route: 'line-read', price: '1', title: 'Credit-line read for an agent', description: 'Paid, 1 USDG over x402: before a lender opens a line, who holds the ERC-8004 agent and since when, its wallet, USDG history and the vault line. Returns the x402 payment link.',
    inputSchema: {type: 'object', properties: {agentId: {type: 'string'}, vault: {type: 'string'}, wallet: {type: 'string'}}, required: ['agentId', 'vault', 'wallet']}},
  {name: 'usdg_ledger', route: 'ledger', price: '0.05', title: 'USDG ledger for an address', description: 'Paid, 0.05 USDG over x402: every USDG in and out of an address over N days (max 14), reconciled against the on-chain balance. Returns the x402 payment link.',
    inputSchema: {type: 'object', properties: {address: {type: 'string'}, days: {type: 'number'}}, required: ['address']}}];
const json = (o, s = 200) => new Response(JSON.stringify(o), {status: s, headers: {'content-type': 'application/json', 'access-control-allow-origin': '*'}});

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, {headers: {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST'}});
    if (req.method === 'GET' && url.pathname === '/') {
      const tx = url.searchParams.get('tx');
      if (tx) { count(env, ctx, 'explain'); try { const r = await explain(tx); return json({...r, next: NEXT(url.origin, r)}); } catch (e) { return json({error: e.message}, 400); } }
      return json({name: 'Robinhood Chain transaction explainer', by: 'JazzCat #1 (ERC-8004 agent #26026), New Jazz City (newjazzcity.pages.dev)', mcp: url.origin + '/mcp', try: url.origin + '/?tx=0x…', tool: TOOL.name, readOnly: true, paid: {ledger: url.origin + '/x402/ledger?address=0x…&days=7', lineRead: url.origin + '/x402/line-read?agentId=…&vault=0x…&wallet=0x…', moneyTrail: url.origin + '/x402/money-trail?token=0x…', price: 'ledger 0.05 USDG, line read 1 USDG, money trail 1 USDG', rail: 'x402 on Robinhood Chain, settled by x402.t0ll.xyz', payTo: CAT1_WALLET}});
    }
    if (url.pathname.startsWith('/x402/')) {
      const ua = (req.headers.get('user-agent') || 'none').replace(/[^A-Za-z0-9._/ -]/g, '').slice(0, 40);
      count(env, ctx, url.pathname.slice(6) + (req.headers.get('x-payment') || req.headers.get('payment-signature') ? ':paid-attempt' : ':offer') + ':' + ua);
    }
    if (url.pathname === '/control') count(env, ctx, 'control');
    if (url.pathname === '/mcp' && req.method === 'POST') count(env, ctx, 'mcp');
    if (url.pathname === '/x402/ledger' && req.method === 'GET') return paid(req, url, () => ledger(url.searchParams.get('address'), url.searchParams.get('days')));
    if (url.pathname === '/agents/cat1.json') return json(CAT1_CARD);
    { const c = url.pathname.match(/^\/agents\/cat\/(\d+)(?:\.json)?$/); if (c) { if (c[1] === '1') return json(CAT1_CARD); try { return json(catCard(c[1], await catWallet(c[1]), url.origin)); } catch (e) { return json({error: e.message}, 404); } } }
    if ((url.pathname === '/book' || url.pathname === '/book.json') && req.method === 'GET') { count(env, ctx, 'book'); try { return await bookPage(url); } catch (e) { return json({error: e.message}, 502); } }
    if (url.pathname === '/coin' && req.method === 'GET') { count(env, ctx, 'coin'); try { return await coinPage(url, env, ctx); } catch (e) { return json({error: e.message}, 400); } }
    if (url.pathname === '/stats' && env?.USAGE) { const out = {}; let cursor; do { const l = await env.USAGE.list({cursor}); for (const k of l.keys) out[k.name] = Number(await env.USAGE.get(k.name)); cursor = l.list_complete ? null : l.cursor; } while (cursor); return json(out); }
    if (url.pathname === '/control' && req.method === 'GET') {
      const key = new Request('https://control.cache/' + (url.searchParams.get('agentId') || '')), cache = caches.default, hit = await cache.match(key);
      if (hit) return hit;
      try { const r = json(await control(url.searchParams.get('agentId'))); r.headers.set('cache-control', 'public, max-age=600'); await cache.put(key, r.clone()); return r; } catch (e) { return json({error: e.message}, 400); }
    }
    if (url.pathname === '/x402/money-trail' && req.method === 'GET') return paid(req, url, () => TRAILS[(url.searchParams.get('token') || '').toLowerCase()] ?? moneyTrail(url.searchParams.get('token')), trailReq);
    if (url.pathname === '/x402/line-read' && req.method === 'GET') return paid(req, url, () => lineRead(url.searchParams.get('agentId'), url.searchParams.get('vault'), url.searchParams.get('wallet')), lineReq);
    if (url.pathname !== '/mcp' || req.method !== 'POST') return json({error: 'POST /mcp (MCP JSON-RPC), GET /?tx=0x… (free), or GET /x402/ledger?address=0x… (0.05 USDG via x402)'}, 404);
    const m = await req.json().catch(() => null); if (!m) return json({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}}, 400);
    if (m.id === undefined) return new Response(null, {status: 202});
    const ok = result => json({jsonrpc: '2.0', id: m.id, result});
    if (m.method === 'initialize') return ok({protocolVersion: m.params?.protocolVersion ?? '2025-03-26', capabilities: {tools: {}}, serverInfo: {name: 'rh-tx-explain (JazzCat #1, New Jazz City)', version: '0.2.0'}});
    if (m.method === 'tools/list') return ok({tools: [TOOL, CONTROL_TOOL, ...PAID_TOOLS]});
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/call' && m.params?.name === TOOL.name) {
      try { const r = await explain(m.params.arguments?.hash); return ok({content: [{type: 'text', text: r.summary + `\n${r.link}`}], structuredContent: r}); }
      catch (e) { return ok({content: [{type: 'text', text: e.message}], isError: true}); }
    }
    if (m.method === 'tools/call' && m.params?.name === CONTROL_TOOL.name) {
      try { const r = await control(String(m.params.arguments?.agentId ?? '')); return ok({content: [{type: 'text', text: JSON.stringify(r)}], structuredContent: r}); }
      catch (e) { return ok({content: [{type: 'text', text: e.message}], isError: true}); }
    }
    const pt = m.method === 'tools/call' && PAID_TOOLS.find(t => t.name === m.params?.name);
    if (pt) {
      const cat = url.searchParams.get('cat') || '1'; let payTo;
      try { payTo = await catWallet(cat); } catch (e) { return ok({content: [{type: 'text', text: e.message}], isError: true}); }
      const q = new URLSearchParams(Object.entries(m.params.arguments || {}).map(([k, v]) => [k, String(v)])); if (cat !== '1') q.set('cat', cat);
      const pay = {url: `${url.origin}/x402/${pt.route}?${q}`, price: pt.price + ' USDG', payTo, rail: 'x402: USDG on Robinhood Chain ("robinhood" / eip155:4663, settled by x402.t0ll.xyz) or USDC on Base ("base" / eip155:8453, paid to the Cat holder, settled by facilitator.payai.network)', seller: 'JazzCat #' + cat};
      return ok({content: [{type: 'text', text: `Paid read, ${pay.price} to JazzCat #${cat}'s wallet ${payTo}. GET ${pay.url} and answer the 402 with an X-PAYMENT header. A failed read is never charged.`}], structuredContent: {paymentRequired: pay}});
    }
    return json({jsonrpc: '2.0', id: m.id, error: {code: -32601, message: 'Method not found'}});
  },
};
