import {baseTrail} from './base.mjs';
import {solTrail} from './sol.mjs';
import {tbaRead} from './tba.mjs';
import {poisonCheck} from './poison.mjs';
import {incomeRead} from './income.mjs';
import {cityRound} from './city.mjs';
import {creditFile} from './credit.mjs';
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
const PRIORS_FACILITATOR = 'https://facilitator.priors.trade'; let PRIORS_KEY = null; // set per request from env.PRIORS_KEY
// New Jazz City's wallet (env CITY_WALLET). When set, sales by house-held Cats (Cat #1 and any Cat the house or the
// treasury holds) pay the city, so the city's ERC-8004 identity carries the income. Holder Cats keep their own pay.
let CITY_WALLET = null;
const HOUSE = new Set(['0xb7e507034618e122aef4a032d1678453b3c9f60b', '0x0c0b48beba6c89ce591b0092b1f5ea83481d2906']);
async function houseCat(n) { return n === '1' || HOUSE.has(((await catHolderEOA(n).catch(() => null)) || '').toLowerCase()); }
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
  const [head] = await rpcBatch([['eth_blockNumber', []]], OFFICIAL); const latest = BigInt(head), span = BigInt(Math.ceil(days * 86400 * 9.4)), start = latest > span ? latest - span : 0n;
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
  const counterparties = [...by].map(([k, c]) => ({address: k, ...(BRIDGES[k] ? {label: `${BRIDGES[k]} bridge: bridged in from another chain`, kind: 'bridged'} : {}), in: fmt(c.in, 6), out: fmt(c.out, 6), transfers: c.n})).sort((x, y) => y.transfers - x.transfers).slice(0, 25);
  const opening = balance - inSum + outSum;
  // funding: the first USDG in the window. A bridge fill says bridged and names the origin sender from the bridge's own record.
  const first = rows.find(r => r.dir === 'in'); let funding = null;
  if (first) { funding = {from: first.counterparty, tx: first.tx, usdg: first.usdg, kind: BRIDGES[first.counterparty] ? 'bridged' : 'direct'};
    if (BRIDGES[first.counterparty]) { funding.via = BRIDGES[first.counterparty]; funding.recheck = 'https://api.relay.link/requests/v2?hash=' + first.tx;
      const rr = await fetch(funding.recheck, {headers: {'user-agent': 'njc/1'}, signal: AbortSignal.timeout(10000)}).then(r => r.ok ? r.json() : null).catch(() => null), q = rr?.requests?.[0];
      funding.origin = q ? {sender: q.user, chainId: q.data?.inTxs?.[0]?.chainId ?? null, tx: q.data?.inTxs?.[0]?.hash ?? null, status: q.status} : 'bridged; origin not returned by the bridge record, recheck at the link'; } }
  return {address: a, chainId: CHAIN_ID, windowDays: days, fromBlock: Number(start), toBlock: Number(latest), transfers: rows.length,
    usdgIn: fmt(inSum, 6), usdgOut: fmt(outSum, 6), balanceNow: fmt(balance, 6), impliedOpeningBalance: fmt(opening, 6),
    reconciles: opening >= 0n, funding, note: opening >= 0n ? 'Balance now = opening + in - out over the window.' : 'Negative implied opening balance: transfers outside the window or a non-standard token path.',
    counterparties, rows: rows.slice(-200).map(({raw, ...r}) => ({...r, link: `${EXPLORER}/tx/${r.tx}`})), by: "JazzCat #1, New Jazz City"};
}

// ---- Paid: credit-line read for a lender, before a line opens (0.90 USDG via x402 to JazzCat #1) ----
const REGISTRY_8004 = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', LINE_PRICE = '900000'; // 0.90 USDG, 10% under MVA's $1 record check (KB 11-20)
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

// ---- Paid: money trail for a Robinhood Chain coin (0.90 USDG via x402 to JazzCat #1) ----
const KNOWN = {'0x8366a39cc670b4001a1121b8f6a443a643e40951': 'Uniswap v4 PoolManager: pool liquidity, not a holder'};
const BRIDGES = {'0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f': 'Relay'}; // a funder trace that reaches a bridge says bridged, never unknown
const TRAIL_PRICE = '900000', REG_START = 34600000n, ZERO_A = '0x0000000000000000000000000000000000000000', DEAD = '0x000000000000000000000000000000000000dead';
const trailReq = resource => ({...ledgerReq(resource), maxAmountRequired: TRAIL_PRICE,
  description: "Money trail for a Robinhood Chain coin: who launched it and through what, where the minted supply went, who bought in the first blocks, the top holders (wallet or contract) and their share, and the launcher's USDG in and out. JazzCat #1, independent: read from the chain, nothing taken from the project.",
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/money-trail?token={token}', queryParams: {token: {type: 'string', description: 'ERC-20 address on Robinhood Chain'}}}, output: {type: 'object'}}});
const baseTrailReq = resource => ({...ledgerReq(resource), maxAmountRequired: TRAIL_PRICE,
  description: "Base launch read for a recent coin (Clanker and others, up to ~7 days old): who launched it and through what, where the supply sits (burn, pool, wallets), who bought in the first blocks, flags. JazzCat #1, independent: read from Base.",
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/base-trail?token={token}', queryParams: {token: {type: 'string', description: 'ERC-20 address on Base'}}}, output: {type: 'object'}}});
// Base verdict: the flags line of the Base launch read, priced for bots that check before every buy; the full trail is the upsell.
const VERDICT_PRICE = '30000';
const baseVerdictReq = resource => ({...ledgerReq(resource), maxAmountRequired: VERDICT_PRICE,
  description: "Base token verdict for a recent coin (Clanker and others, up to ~7 days old): flags or no flags from its launch read (one wallet's share, top-wallet concentration, snipers in the first blocks, repeat mints), burned share, launcher. 0.03 USDC. Full trail at /x402/base-trail. Track record: every verdict hashed hourly on Robinhood Chain and scored at 24h and 72h, newjazzcity.pages.dev/verdicts/. JazzCat #1, independent: read from Base.",
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/base-verdict?token={token}', queryParams: {token: {type: 'string', description: 'ERC-20 address on Base'}}}, output: {type: 'object'}}});
async function baseVerdict(token, origin) {
  const r = await baseTrail(token), walletTop = r.topHolders.filter(h => h.kind === 'wallet')[0];
  return {chain: 'base', chainId: 8453, token: r.token, symbol: r.symbol, verdict: r.verdict, flags: r.flags, burnedPct: r.burnedPct, topWalletPct: walletTop?.pctOfSupply ?? 0,
    launcher: r.launch.launcher, launchBlock: r.launch.block, fullRead: `${origin}/x402/base-trail?token=${r.token}`, by: r.by};
}
const solTrailReq = resource => ({...ledgerReq(resource), maxAmountRequired: TRAIL_PRICE,
  description: "Solana coin trail: what the coin claims, mint and freeze authority, top holders outside pools, the creator's own holding, and where its creator fees route (pump.fun fee-sharing config and creator vaults, read on chain). JazzCat #1, independent.",
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/sol-trail?mint={mint}', queryParams: {mint: {type: 'string', description: 'Solana token mint'}}}, output: {type: 'object'}}});
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

// Paid: halt check. Is the stock behind a Robinhood Stock Token halted, per the exchanges' own lists (NYSE trade-halts covers
// NYSE, NYSE American and Nasdaq names; Nasdaq Trader is the second listing source), next to the issuer-relayed oracle row.
// An independent witness for any hook, desk or agent that trades Stock Tokens. 0.25 USDG to the Cat.
const HALT_PRICE = '250000', HARMONIC_EQ = 'https://harmonicagent.solutions/api/oracle/equities';
const riffReq = resource => ({...ledgerReq(resource), maxAmountRequired: '10000',
  description: "A riff: one bar from a JazzCat about any Robinhood Chain coin, read from its money trail (who launched it, launch-block buyers, the launcher's share, the biggest wallet). 0.01 USDG. The full trail is /x402/money-trail.",
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/riff?token={token}', queryParams: {token: {type: 'string', description: 'Robinhood Chain token'}}}}});
async function riff(token, cat) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token || '')) throw new Error('token=0x… is required');
  const t = token.toLowerCase(), key = new Request('https://coin.cache/' + t), hit = await caches.default.match(key);
  const h = hit ? await hit.json() : coinHeadline(TRAILS[t] ?? await moneyTrail(t));
  const bar = `$${h.symbol}: minted ${h.minted}; ${h.launchBlockBuyers ? `${h.launchBlockBuyers} launch-block buyers took ${h.launchBlockPct}%, ${h.stillHolding} still hold` : 'no launch-block buyers besides the launcher'}; the launcher holds ${h.launcherPct}%${h.topWallet ? `; the biggest plain wallet holds ${h.topWallet.pct}%` : ''}.`;
  return {riff: bar, by: 'JazzCat #' + (cat || 1), token: t, flags: h.flags, full: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/money-trail?token=' + t};
}
const haltReq = resource => ({...ledgerReq(resource), maxAmountRequired: HALT_PRICE,
  description: "Halt check for a Stock Token's underlying: the exchanges' own halt lists (NYSE + Nasdaq), reason, since, resumption, against the issuer-relayed oracle row. Independent witness, read by JazzCat #1.",
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/halt-check?symbol={symbol}', queryParams: {symbol: {type: 'string', description: 'ticker, e.g. AAPL'}}}}});
function etMs(date, time) { // a New York wall-clock date + time to epoch ms
  if (!date || !time) return null;
  const [y, m, d] = date.includes('/') ? [date.slice(6, 10), date.slice(0, 2), date.slice(3, 5)] : date.split('-');
  const g = Date.UTC(+y, +m - 1, +d, ...time.slice(0, 8).split(':').map(Number));
  return g + (new Date(new Date(g).toLocaleString('en-US', {timeZone: 'UTC'})) - new Date(new Date(g).toLocaleString('en-US', {timeZone: 'America/New_York'})));
}
export async function haltCheck(symbol) {
  const s = String(symbol || '').toUpperCase(); if (!/^[A-Z.]{1,8}$/.test(s)) throw new Error('symbol (ticker) is required, e.g. AAPL.');
  const get = (u, t) => fetch(u, {headers: {'user-agent': 'Mozilla/5.0'}, signal: AbortSignal.timeout(15000)}).then(r => r.ok ? (t ? r.text() : r.json()) : null).catch(() => null);
  const [ny, nq, hq] = await Promise.all([get('https://www.nyse.com/api/trade-halts/current'), get('https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts', true), get(HARMONIC_EQ)]);
  if (!ny && !nq) throw new Error('Both exchange halt lists are unreachable right now; not charged.');
  const now = Date.now(), lists = [];
  for (const h of ny?.results?.tradeHalts || []) if (h.symbol === s) { const r = etMs(h.formatedResumptionDate || h.formatedHaltDate, h.formatedResumptionTime);
    lists.push({source: 'NYSE trade-halts', venue: h.sourceExchange, reason: h.reason, haltedAtEt: `${h.formatedHaltDate} ${h.formatedHaltTime}`, resumesAtEt: h.formatedResumptionTime ? `${h.formatedResumptionDate || h.formatedHaltDate} ${h.formatedResumptionTime}` : null, haltedNow: !r || r > now}); }
  for (const it of (nq || '').match(/<item>[\s\S]*?<\/item>/g) || []) { const f = Object.fromEntries([...it.matchAll(/<ndaq:(\w+)>([\s\S]*?)<\/ndaq:\1>/g)].map(m => [m[1], m[2].trim()]));
    if (f.IssueSymbol !== s) continue; const r = etMs(f.ResumptionDate, f.ResumptionTradeTime);
    lists.push({source: 'Nasdaq Trader halts', venue: f.Market, reason: f.ReasonCode, haltedAtEt: `${f.HaltDate} ${(f.HaltTime || '').slice(0, 8)}`, resumesAtEt: f.ResumptionTradeTime ? `${f.ResumptionDate} ${f.ResumptionTradeTime}` : null, haltedNow: !r || r > now}); }
  const exchangeHalted = lists.some(l => l.haltedNow) && !lists.some(l => l.resumesAtEt && !l.haltedNow), row = hq?.rows?.find(r => r.symbol === s);
  const oracle = row ? {source: 'Harmonic equities oracle (issuer-relayed)', token: row.address, verdict: row.verdict, issuerHalted: row.issuer?.halted ?? null, rowAt: row.at} : null;
  const oracleHalted = oracle ? oracle.verdict === 'halted' || oracle.issuerHalted === true : null;
  return {symbol: s, checkedAt: new Date(now).toISOString(), exchangeHalted, exchangeLists: lists, listsRead: {nyse: !!ny, nasdaq: !!nq}, oracle,
    agree: oracle ? oracleHalted === exchangeHalted : null,
    verdict: exchangeHalted ? (oracle && !oracleHalted ? `HALTED on the exchange, but the oracle row says ${oracle.verdict}: do not trust an open verdict now` : 'HALTED on the exchange') : (oracle && oracleHalted ? 'clear on both exchange lists, but the oracle row says halted' : 'not halted on the exchange lists'),
    by: 'JazzCat #1 (agent #26063): independent of the issuer quote API'};
}

// Paid: transfer read. Right before a buyer accepts a two-step ownership transfer (Ownable2Step and similar), who can still act:
// current owner, pending owner, when the transfer started, and every ownership event since. 1.80 USDG to the Cat.
const TRANSFER_PRICE = '1800000', OT_STARTED = '0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700', OT_DONE = '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0';
const transferReq = resource => ({...ledgerReq(resource), maxAmountRequired: TRANSFER_PRICE,
  description: "Transfer read before you accept an agent or contract: current owner, pending owner, when the transfer started, every ownership event, and whether the seller can still act. Read from the chain by JazzCat #1.",
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/transfer-read?contract={contract}', queryParams: {contract: {type: 'string', description: 'contract address 0x…'}}}}});
// Poison check before paying an address copied from a wallet's history: fake look-alike tokens and look-alike
// counterparties (same first/last characters, different middle). 0.90 USDG to the Cat.
const incomeReq = resource => ({...ledgerReq(resource), maxAmountRequired: '900000',
  description: "Income read for an agent on Robinhood Chain: every USDG into its wallet over N days (max 60) by payer, with its own wallets, loans and swap proceeds split out from outside payers. Read from the chain by JazzCat #1.",
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/income-read?agent={agent}&days={days}', queryParams: {agent: {type: 'string', description: 'ERC-8004 agent id, or a wallet 0x…'}, days: {type: 'number', description: 'days back, max 60'}}}}});
const poisonReq = resource => ({...ledgerReq(resource), maxAmountRequired: '900000',
  description: "Poison check before you pay an address copied from a wallet's history on Robinhood Chain: fake look-alike tokens (USDG with hidden characters) and look-alike counterparties (same first and last characters, different middle), with the real address. Read from the chain by JazzCat #1.",
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/poison-check?address={address}', queryParams: {address: {type: 'string', description: 'wallet whose history you copy payees from, 0x…'}}}}});
// Agent-wallet handover read (ERC-6551 / Tokenbound V3) on Base or Robinhood Chain: owner now, callers still permitted
// (live or dormant), overrides and lock. 1.80 USDG to the Cat.
const tbaReq = resource => ({...ledgerReq(resource), maxAmountRequired: TRANSFER_PRICE,
  description: "Agent-wallet handover read before you accept or spend from an ERC-6551 wallet on Base or Robinhood Chain: who owns it now, which callers can still act (live or dormant from a past owner), overrides and lock. Read from the chain by JazzCat #1.",
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/tba-read?account={account}&chain={chain}', queryParams: {account: {type: 'string', description: '6551 wallet address 0x…'}, chain: {type: 'string', description: 'base or robinhood'}}}}});
export async function transferRead(contract) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract || '')) throw new Error('contract (0x address) is required.');
  const c = contract.toLowerCase();
  const [owner, pending, head, code] = await rpcBatch([['eth_call', [{to: c, data: '0x8da5cb5b'}, 'latest']], ['eth_call', [{to: c, data: '0xe30c3978'}, 'latest']], ['eth_blockNumber', []], ['eth_getCode', [c, 'latest']]], OFFICIAL);
  if (!code || code === '0x') throw new Error('No contract at ' + contract + ' on Robinhood Chain.');
  const latest = BigInt(head), from = latest > 9000000n ? latest - 9000000n : 0n;
  const [logs] = await rpcBatch([['eth_getLogs', [{address: c, fromBlock: '0x' + from.toString(16), toBlock: 'latest', topics: [[OT_STARTED, OT_DONE]]}]]], OFFICIAL);
  const ev = (logs || []).map(l => ({event: l.topics[0] === OT_STARTED ? 'OwnershipTransferStarted' : 'OwnershipTransferred', from: addr(l.topics[1]), to: addr(l.topics[2]), block: Number(BigInt(l.blockNumber)), tx: l.transactionHash}));
  const o = owner && owner.length >= 66 ? addr(owner) : null, p = pending && pending.length >= 66 ? addr(pending) : null, open = p && p !== ZERO_A;
  const started = [...ev].reverse().find(e => e.event === 'OwnershipTransferStarted' && e.to === p);
  return {contract: c, chainId: CHAIN_ID, owner: o, pendingOwner: open ? p : null, transferOpen: !!open, startedAt: started ? {block: started.block, tx: started.tx} : null, events: ev,
    verdict: open ? `transfer open: ${short(o)} still owns and can still act (change roles or cancel) until ${short(p)} accepts` : o ? `no transfer open; ${short(o)} owns it` : 'no owner() on this contract',
    note: 'Owner and pending owner are read now; events cover about the last 11 days. Roles specific to the contract (guardians, executors) are read on request.', by: 'JazzCat #1 (agent #26063), read from the chain'};
}

// Contract change watcher (Agraris Wanted request): every control change on a Robinhood Chain contract, read from the chain.
// Current owner, pending owner and EIP-1967 implementation / admin / beacon, plus every ownership, role, upgrade, admin and
// pause event in about the last 11 days, newest first. Poll it each hour (or each block) to get the changes as alerts.
const CHANGE_TOPICS = {[OT_STARTED]: 'OwnershipTransferStarted', [OT_DONE]: 'OwnershipTransferred',
  '0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d': 'RoleGranted', '0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b': 'RoleRevoked',
  '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b': 'Upgraded', '0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f': 'AdminChanged',
  '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e': 'BeaconUpgraded', '0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258': 'Paused',
  '0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa': 'Unpaused'};
const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', SLOT_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103', SLOT_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
async function contractChanges(contract) {
  const base = await transferRead(contract), c = base.contract;
  const [impl, admin, beacon, head] = await rpcBatch([['eth_getStorageAt', [c, SLOT_IMPL, 'latest']], ['eth_getStorageAt', [c, SLOT_ADMIN, 'latest']], ['eth_getStorageAt', [c, SLOT_BEACON, 'latest']], ['eth_blockNumber', []]]);
  const latest = BigInt(head), from = latest > 9000000n ? latest - 9000000n : 0n;
  const [logs] = await rpcBatch([['eth_getLogs', [{address: c, fromBlock: '0x' + from.toString(16), toBlock: 'latest', topics: [Object.keys(CHANGE_TOPICS)]}]]], OFFICIAL);
  const slot = v => v && /[1-9a-f]/.test(v.slice(26)) ? '0x' + v.slice(-40) : null;
  const changes = (logs || []).map(l => { const name = CHANGE_TOPICS[l.topics[0]], t = l.topics, data = l.data || '0x';
    const who = name === 'RoleGranted' || name === 'RoleRevoked' ? {role: t[1], account: addr(t[2]), by: addr(t[3])}
      : name === 'Upgraded' || name === 'BeaconUpgraded' ? {to: addr(t[1])}
      : name === 'AdminChanged' ? {from: '0x' + data.slice(26, 66), to: '0x' + data.slice(90, 130)}
      : name === 'Paused' || name === 'Unpaused' ? {by: '0x' + data.slice(-40)}
      : {from: addr(t[1]), to: addr(t[2])};
    return {change: name, ...who, block: Number(BigInt(l.blockNumber)), tx: l.transactionHash}; }).reverse();
  return {contract: c, chainId: CHAIN_ID, owner: base.owner, pendingOwner: base.pendingOwner, implementation: slot(impl), proxyAdmin: slot(admin), beacon: slot(beacon),
    changes, window: {fromBlock: Number(from), toBlock: Number(latest)},
    verdict: changes.length ? `${changes.length} control change(s) in the window; newest: ${changes[0].change} in block ${changes[0].block}` : 'no control changes in the window',
    howToWatch: 'Poll this read each hour (or each block) and alert on any change whose block is newer than your last poll.',
    by: 'JazzCat #1 (agent #26063), New Jazz City: read from the chain'};
}

// AI Portfolio & Risk Monitor (Agraris Wanted request 3e910fce): one wallet on Robinhood Chain, read from the chain.
// Holdings (every token the wallet touched, with live balances), USDG in and out over 7 days, and plain-language risk
// alerts with why each matters and a possible action. It never trades. Composes ledger, poisonCheck and contractChanges.
async function portfolioWatch(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) throw new Error('address (0x…) is required.');
  const a = address.toLowerCase();
  const [flow, poison] = await Promise.all([ledger(a, 7).catch(e => ({error: e.message})), poisonCheck(a).catch(e => ({error: e.message}))]);
  // tokens this wallet touched over about 11 days of Transfer logs, USDG always included
  const touched = [USDG];
  // Address-less log queries are capped at 30,000 blocks per call on Robinhood Chain, so read 24 windows (about a day).
  const [head] = await rpcBatch([['eth_blockNumber', []]]); const latest = BigInt(head), hx = x => '0x' + x.toString(16), W = 29999n, q = [];
  for (let i = 0n, to = latest; i < 12n && to > W; i++, to -= W + 1n) { const r = {fromBlock: hx(to - W), toBlock: hx(to)}; q.push(['eth_getLogs', [{...r, topics: [T.transfer, null, pad(a)]}]], ['eth_getLogs', [{...r, topics: [T.transfer, pad(a)]}]]); }
  let windowsRead = 0;
  for (let i = 0; i < q.length; i += 4) for (const logs of await rpcBatch(q.slice(i, i + 4), OFFICIAL).catch(() => [])) { if (logs) windowsRead++; for (const l of logs || []) if (l.topics.length === 3) touched.push(l.address.toLowerCase()); }
  const tokens = [...new Set(touched)].slice(0, 30);
  const calls = tokens.flatMap(t => [['eth_call', [{to: t, data: '0x70a08231' + pad(a).slice(2)}, 'latest']], ['eth_call', [{to: t, data: '0x95d89b41'}, 'latest']], ['eth_call', [{to: t, data: '0x313ce567'}, 'latest']]]);
  const res = []; for (let i = 0; i < calls.length; i += 30) res.push(...await rpcBatch(calls.slice(i, i + 30)).catch(() => calls.slice(i, i + 30).map(() => null)));
  res.push(...await rpcBatch([['eth_getBalance', [a, 'latest']]]));
  const holdings = [];
  tokens.forEach((t, i) => { const bal = BigInt(res[i * 3] && res[i * 3] !== '0x' ? res[i * 3] : '0x0'); if (bal === 0n) return;
    const dec = Number(BigInt(res[i * 3 + 2] && res[i * 3 + 2] !== '0x' ? res[i * 3 + 2] : '0x12')); holdings.push({token: t, symbol: decodeString(res[i * 3 + 1]) || '?', balance: fmt(bal, dec)}); });
  const eth = fmt(BigInt(res[res.length - 1] || '0x0'), 18);
  const alerts = [];
  if (poison.lookalikes?.length) alerts.push({level: 'high', what: `${poison.lookalikes.length} lookalike address(es) in this wallet's history`, why: 'Someone sent tiny transfers from addresses that copy the start and end of addresses you really pay, hoping you copy the wrong one next time.', action: 'Pay only full addresses you have saved; never copy a payee from recent history.'});
  if (poison.poisoned?.length) alerts.push({level: 'high', what: `${poison.poisoned.length} poisoned transfer(s): fake tokens or entries this wallet never sent`, why: 'Fake tokens with real-looking names are there to trick you into interacting with a scam contract.', action: 'Ignore and hide them; do not approve or swap them.'});
  // contract risk on the largest holdings (owner/proxy changes on the code you hold)
  const checked = [];
  for (const h of holdings.filter(h => h.token !== USDG).slice(0, 5)) {
    const c = await contractChanges(h.token).catch(() => null); if (!c) continue; checked.push(h.symbol);
    const up = c.changes.filter(x => x.change === 'Upgraded' || x.change === 'BeaconUpgraded' || x.change === 'AdminChanged');
    if (up.length) alerts.push({level: 'high', what: `${h.symbol}: its contract code changed (${up[0].change}, block ${up[0].block})`, why: 'An upgradeable token can change its rules after you buy: fees, transfers or balances.', action: 'Read the new implementation before adding more; consider reducing exposure.', tx: up[0].tx});
    if (c.pendingOwner) alerts.push({level: 'medium', what: `${h.symbol}: ownership transfer in progress to ${c.pendingOwner}`, why: 'A new owner can change what the owner controls on this token.', action: 'Watch who accepts it; know what the owner can do before it lands.'});
    const own = c.changes.filter(x => x.change === 'OwnershipTransferred');
    if (own.length && !up.length) alerts.push({level: 'medium', what: `${h.symbol}: owner changed recently (block ${own[0].block})`, why: 'Control moved to a new address.', action: 'Check whether the new owner is a known team wallet or a multisig.', tx: own[0].tx});
  }
  if (!flow.error && Number(flow.usdgOut) > Number(flow.usdgIn) * 2 && Number(flow.usdgOut) > 10) alerts.push({level: 'medium', what: `USDG out (${flow.usdgOut}) is more than twice USDG in (${flow.usdgIn}) this week`, why: 'Spending is outrunning income; at this pace the balance runs down.', action: 'Check the largest outgoing counterparties below.'});
  return {address: a, chainId: CHAIN_ID, generatedAt: new Date().toISOString(), eth, holdings, usdg7d: flow.error ? {error: flow.error} : {in: flow.usdgIn, out: flow.usdgOut, balance: flow.balanceNow, topCounterparties: (flow.counterparties || []).slice(0, 5)},
    alerts, checkedContracts: checked, tokensSeen: tokens.length, windowsRead, summary: alerts.length ? `${alerts.length} alert(s): ` + alerts.map(x => x.what).join('; ') : 'No risk alerts for this wallet in the window.',
    note: 'Read only: suggests actions, never executes trades. Poll it hourly; a new alert is the notification.', by: 'JazzCat #1 (agent #26063), New Jazz City: read from Robinhood Chain'};
}

// Quote a job in the buyer's own coin: dollar price -> token amount at the deepest pool's live price. Accepted only when that
// pool is deep enough to absorb selling 70% of the payment (the Cat keeps 30% of a project's coin as upside).
const CHAINS = {robinhood: 4663, base: 8453, solana: 'solana', ethereum: 1};
async function coinQuote(token, usd, chain = 'robinhood') {
  if (!token || !(usd > 0) || usd > 100000) throw new Error('token and usd (0 < usd <= 100000) are required.');
  const j = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + token).then(r => r.json());
  const pairs = (j.pairs || []).filter(p => p.chainId === chain && (p.baseToken.address || '').toLowerCase() === token.toLowerCase());
  if (!pairs.length) throw new Error('No ' + chain + ' pool found for ' + token + '.');
  const p = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0], price = Number(p.priceUsd), liq = p.liquidity?.usd || 0;
  const amount = usd / price, sell = usd * 0.7, accepted = liq >= sell * 50;
  return {token, chain, symbol: p.baseToken.symbol, usd, priceUsd: price, amount: Number(amount.toPrecision(8)), pool: p.pairAddress, poolLiquidityUsd: Math.round(liq),
    accepted, why: accepted ? 'pool covers a 70% sale at under ~2% impact' : `pool ($${Math.round(liq)}) too thin for a $${sell.toFixed(2)} sale; pay in USDG or USDC`,
    split: {keepPct: 30, convertPct: 70}, payTo: chain === 'robinhood' ? CAT1_WALLET : 'ask for the Cat holder wallet on ' + chain, quotedAt: new Date().toISOString(), validSeconds: 600};
}

// ERC-8004 agent card for JazzCat #1 as a seller: its paid endpoints and the wallet it is paid in.
// New Jazz City's own ERC-8004 registration: the city that runs the economy for every JazzCat. It sells the same work
// as the house Cats, and its registry wallet is the city's wallet, so the city's income and record are its own.
const NJC_TREASURY = '0x0C0B48Beba6c89CE591b0092B1F5EA83481D2906';
const NJC_CARD = () => ({type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'New Jazz City',
  description: 'New Jazz City: the city on Robinhood Chain where JazzCats work. Hire a Cat for chain reads over x402 (USDG on Robinhood Chain, USDC on Base): USDG ledger 0.05, Stock Token halt check 0.25, money trail, poison check, income read and credit-line read 0.90, transfer read and agent-wallet handover read 1.80, full check of any address 2.70. Post paid City Jobs for agents and Cats at newjazzcity.pages.dev/api/jobs, with pay locked in escrow until delivery.',
  image: 'https://newjazzcity.pages.dev/og.png',
  services: [...CAT1_CARD.services.filter(x => x.name === 'x402'),
    {name: 'MCP', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/mcp', version: '2025-06-18'},
    {name: 'MCP', endpoint: 'https://newjazzcity.pages.dev/mcp', version: '2025-06-18'},
    {name: 'jobs', endpoint: 'https://newjazzcity.pages.dev/api/jobs', version: '1'},
    {name: 'credit-file', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/.well-known/agent-credit-file.json', version: '1'},
    {name: 'web', endpoint: 'https://newjazzcity.pages.dev/'}],
  x402Support: true, active: true, supportedTrust: ['reputation'],
  registrations: NJC_ID ? [{agentId: NJC_ID, agentRegistry: 'eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'}] : [],
  agentWallet: 'eip155:4663:' + (CITY_WALLET || NJC_TREASURY)});
let NJC_ID = null;
const CAT1_CARD = {type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'JazzCat #1',
  description: 'JazzCat #1, New Jazz City: an on-chain jazz cat on Robinhood Chain that sells independent evidence to agents over x402 and BatchDesk. Halt check for Stock Tokens against the exchanges own lists (0.25 USDG), full check of any address (2.70 USDG), transfer read before you accept (1.80 USDG), credit-line read (0.90 USDG), money trail for any coin on Robinhood Chain or Solana (0.90 USDG; 0.70 per item in batches), USDG ledger with bridged funding traced (0.05 USDG), free transaction explainer. Every paid job is a row in its on-chain ReceiptBook. Paid in USDG straight into its own token-bound wallet.',
  image: 'https://jazzcatsfun.pages.dev/agents/1.svg',
  services: [
    {name: 'x402', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/line-read', version: '1'},
    {name: 'x402', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/money-trail', version: '1'},
    {name: 'x402', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/ledger', version: '1'},
    {name: 'x402', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/transfer-read', version: '1'},
    {name: 'x402', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/tba-read', version: '1'},
    {name: 'x402', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/poison-check', version: '1'},
    {name: 'x402', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/income-read', version: '1'},
    {name: 'llms', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/llms.txt', version: '1'},
    {name: 'x402', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/halt-check', version: '1'},
    {name: 'receipts', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/book.json', version: '1'},
    {name: 'profile', endpoint: 'https://njc-tx-explain.departmentofjazz.workers.dev/cat/1', version: '1'},
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
// Solana USDC, also settled by PayAI (its feePayer sponsors the transaction). One house Solana wallet receives for every Cat;
// the paying Cat is named in the response so its income list can credit it. Its USDC token account exists, as the x402 SVM scheme requires.
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', SOL_PAYTO = 'BifYmwXuP9jBY4YZSACwcNAhcNabKcxzgkMxCUJZq8gL', SOL_FEEPAYER = 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww', SOL_V2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
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
const CAT_AGENTS = {'1': 26063, '2': 26078, '3': 26079}; // ERC-8004 agent IDs whose agentWallet is the Cat's own 6551 wallet
const catCard = (n, wallet, origin) => ({type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'JazzCat #' + n,
  description: `JazzCat #${n}, New Jazz City: an on-chain jazz cat on Robinhood Chain that sells chain reads to agents over x402, paid in USDG to its own wallet. Full check of any address (2.70 USDG), credit-line read (0.90 USDG), money trail for any coin (0.90 USDG), USDG ledger for any address (0.05 USDG), free transaction explainer and agent-control check.`,
  image: `https://jazzcatsfun.pages.dev/agents/${n}.svg`,
  services: [...['line-read', 'money-trail', 'ledger', 'transfer-read', 'halt-check'].map(r => ({name: 'x402', endpoint: `${origin}/x402/${r}?cat=${n}`, version: '1'})),
    {name: 'MCP', endpoint: `${origin}/mcp?cat=${n}`, version: '2025-06-18'}, {name: 'web', endpoint: origin + '/'}],
  x402Support: true, active: true, supportedTrust: ['reputation'], agentWallet: 'eip155:4663:' + wallet,
  token: {chainId: 4663, contract: GENESIS, tokenId: n, account: 'ERC-6551 AccountV3, owned by whoever holds the Cat'},
  ...(CAT_AGENTS[n] ? {registrations: [{agentId: CAT_AGENTS[n], agentRegistry: 'eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'}]} : {})});

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
const NEXT = (origin, r) => ({moneyTrail: (r.tokens?.[0] || r.facts?.find?.(f => f.token)?.token) ? origin + '/x402/money-trail?token=' + (r.tokens?.[0] || r.facts.find(f => f.token).token) + ' (0.90 USDG): who launched the coin, who sold at launch, where its supply sits' : undefined,
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
// Each row is hashed with the one before it, so the whole book folds into one head: change any row and every hash after it
// changes. hash_n = sha256(hash_{n-1} | seq | chainId | payTx | workHash | amount | label); hash_0 = 32 zero bytes.
async function chained(rows) {
  let prev = '0x' + '0'.repeat(64);
  for (const r of rows) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode([prev, r.seq, r.chainId, r.payTx, r.workHash, r.amount, r.label].join('|')));
    r.prev = prev; r.hash = prev = '0x' + [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return prev;
}
// Cat ↔ City: every USDG transfer between New Jazz City (2906), the house wallet and the house Cat #1, read from the chain
// and tagged related party. These never count as anyone's outside income (credit files, the City Score).
const RELATED_WALLETS = ['0x0c0b48beba6c89ce591b0092b1f5ea83481d2906', '0xb7e507034618e122aef4a032d1678453b3c9f60b', '0x1479be07e26976fd712db34f7bc1b8ac523f806e'];
async function cityLedger() {
  const [head] = await rpcBatch([['eth_blockNumber', []]], OFFICIAL), latest = BigInt(head), from = latest > 9_000_000n ? latest - 9_000_000n : 0n;
  const pads = RELATED_WALLETS.map(a => '0x' + a.slice(2).padStart(64, '0'));
  const [logs] = await rpcBatch([['eth_getLogs', [{address: USDG, fromBlock: '0x' + from.toString(16), toBlock: 'latest', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pads, pads]}]]], OFFICIAL);
  const name = {[RELATED_WALLETS[0]]: 'New Jazz City (2906)', [RELATED_WALLETS[1]]: 'house wallet', [RELATED_WALLETS[2]]: 'JazzCat #1'};
  const rows = (logs || []).map(l => ({from: name['0x' + l.topics[1].slice(26)], to: name['0x' + l.topics[2].slice(26)], usdg: Number(BigInt(l.data)) / 1e6, tx: l.transactionHash, block: Number(BigInt(l.blockNumber))})).reverse();
  return {kind: 'related-party', wallets: name, note: 'Payments between New Jazz City and its own wallets and house Cats. Disclosed; never counted as outside income.', rows};
}
async function bookPage(url) {
  const rows = await bookRows(), total = rows.reduce((a, r) => a + r.amount, 0), buyers = new Set(rows.map(r => r.buyer)).size, head = await chained(rows);
  const chains = Object.fromEntries([...new Set(rows.map(r => r.chainId))].map(c => [c, rows.filter(r => r.chainId === c).length]));
  if (url.pathname.endsWith('.json')) return json({name: 'Jazz receipt chain', contract: BOOK, book: BOOK, chainId: CHAIN_ID, receipts: rows.length, head, chains, total, buyers,
    hashing: 'hash_n = sha256(hash_{n-1}|seq|chainId|payTx|workHash|amount|label), hash_0 = 0x00…00; head = the last hash', rows});
  const tr = rows.map(r => `<tr><td>${r.seq}</td><td>${esc(r.label)}</td><td>${esc(r.amount)} USDG</td><td><a href="${EXPLORER}/address/${r.buyer}">${short(r.buyer)}</a></td><td><a href="${EXPLORER}/tx/${r.payTx}">payment</a></td><td><a href="${EXPLORER}/tx/${r.recordTx}">receipt</a></td></tr>`).join('');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Book · New Jazz City</title>
<style>:root{--bg:#0b0b10;--fg:#e9e6ff;--mute:#9a95b8;--line:#2a2840;--acc:#6ee7ff}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}main{max-width:900px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}p{color:var(--mute);margin:4px 0 16px}table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--mute);font-weight:500}a{color:var(--acc)}.wrap{overflow-x:auto}</style></head>
<body><main><h1>The Book</h1><p>Every paid job New Jazz City's Cats have done, in order, written on Robinhood Chain by the house. ${rows.length} receipts · ${esc(Math.round(total * 100) / 100)} USDG · ${buyers} buyers. Book contract <a href="${EXPLORER}/address/${BOOK}">${short(BOOK)}</a>; every row links its payment.</p>
<div class="wrap"><table><thead><tr><th>#</th><th>Job</th><th>Paid</th><th>Buyer</th><th></th><th></th></tr></thead><tbody>${tr}</tbody></table></div></main></body></html>`, {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300'}});
}
// A Cat's own page: its wallet, its holder, what it sells and its paid jobs from the Book.
// Rows written before per-Cat sellers existed were all Cat #1's; later rows name their Cat in the label ("Cat #N · …").
async function catPage(n, url) {
  const wallet = await catWallet(n), holder = await catHolderEOA(n).catch(() => null);
  const [bal] = await rpcBatch([['eth_call', [{to: USDG, data: '0x70a08231' + wallet.slice(2).padStart(64, '0')}, 'latest']]]);
  const rows = (await bookRows()).filter(r => n === '1' ? !/^Cat #\d+ ·/.test(r.label) || r.label.startsWith('Cat #1 ·') : r.label.startsWith(`Cat #${n} ·`));
  const earned = rows.reduce((a, r) => a + r.amount, 0), o = url.origin;
  const tr = rows.map(r => `<tr><td>${esc(r.label)}</td><td>${esc(r.amount)} USDG</td><td><a href="${EXPLORER}/tx/${r.payTx}">payment</a></td></tr>`).join('') || '<tr><td colspan="3">No paid jobs yet.</td></tr>';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JazzCat #${esc(n)} · New Jazz City</title>
<style>:root{--bg:#0b0b10;--fg:#e9e6ff;--mute:#9a95b8;--line:#2a2840;--acc:#6ee7ff}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}main{max-width:820px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}p,li{color:var(--mute)}table{width:100%;border-collapse:collapse}td{padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}a{color:var(--acc)}img{width:120px;height:120px;border-radius:12px;background:#15131f}</style></head>
<body><main><img src="https://jazzcatsfun.pages.dev/agents/${esc(n)}.svg" alt="JazzCat #${esc(n)}"><h1>JazzCat #${esc(n)}</h1>
<p>An on-chain jazz cat in New Jazz City, Robinhood Chain. Its own wallet <a href="${EXPLORER}/address/${wallet}">${short(wallet)}</a> holds ${esc(Number(BigInt(bal || '0x0')) / 1e6)} USDG${holder ? `; held by <a href="${EXPLORER}/address/${holder}">${short(holder)}</a>` : ''}. Paid jobs: ${rows.length}, ${esc(Math.round(earned * 100) / 100)} USDG.</p>
<h2>What it sells</h2><ul><li>Full check of any address (poison, income, ledger, trail), 2.70 USDG</li><li>Money trail for any coin, 0.90 USDG</li><li>Credit-line read before a lender opens a line, 0.90 USDG</li><li>USDG ledger for any address, 0.05 USDG</li><li>Batches: 10 for 8, 50 for 35, 100 for 70</li><li>Paid in USDG on Robinhood Chain or USDC on Base, over x402. Agent card: <a href="${o}/agents/cat/${esc(n)}">/agents/cat/${esc(n)}</a></li></ul>
<h2>Paid jobs</h2><table>${tr}</table><p><a href="${o}/book">The Book</a>: every Cat's receipts, written on chain.</p></main></body></html>`, {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300'}});
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
<p>The full read: where the minted supply went, every launch-block buyer and what they hold now, the top 10 holders (wallet, contract or pool), and the launcher's USDG in and out. <b>0.90 USDG over x402</b>, paid to the Cat's own wallet, verified payee on Toll:</p>
<p><code>GET ${esc(pay)}</code></p>
<p class="m">Free tools: <a href="${esc(url.origin)}/?tx=">explain any transaction</a> · <a href="${esc(url.origin)}/control?agentId=26063">who controls an agent</a> · MCP at <code>${esc(url.origin)}/mcp</code></p>
</main></body></html>`;
  return new Response(html, {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600'}});
}
const b64 = o => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
// x402 v1 names the network "robinhood"; v2 clients want CAIP-2 "eip155:4663". Offer both, settle whichever the payer signed.
const v2Of = r => ({scheme: 'exact', network: 'eip155:' + CHAIN_ID, amount: r.maxAmountRequired, asset: r.asset, payTo: r.payTo, maxTimeoutSeconds: r.maxTimeoutSeconds, extra: r.extra});
const H402 = {'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-PAYMENT-RESPONSE, PAYMENT-RESPONSE, PAYMENT-REQUIRED'};
// $JAZZ holders: x-jazz-holder: <address>.<signature of "Jazz holder <address> <YYYY-MM-DD>">. The site checks the
// signature and the balance; the answer is cached for the day, and a holder's first JAZZ_FREE_CALLS paid reads a day are free.
let HOLDER_ENV = null;
async function holderPass(req) {
  const env = HOLDER_ENV, h = req.headers.get('x-jazz-holder') || '';
  const [address, signature] = h.split('.');
  if (!JAZZ_TOKEN || !env?.USAGE || !/^0x[0-9a-fA-F]{40}$/.test(address || '') || !signature) return null;
  const day = new Date().toISOString().slice(0, 10), a = address.toLowerCase(), key = `holder:${a}:${day}`;
  let st = JSON.parse(await env.USAGE.get(key) || 'null');
  if (!st) {
    const r = await fetch(`https://newjazzcity.pages.dev/api/city/holder?address=${a}&signature=${signature}`).then(x => x.json()).catch(() => null);
    if (!r) return null;
    st = {holder: !!r.holder, used: 0};
    await env.USAGE.put(key, JSON.stringify(st), {expirationTtl: 2 * 86400});
  }
  const free = Number(env.JAZZ_FREE_CALLS || 20);
  if (!st.holder || st.used >= free) return null;
  st.used++; await env.USAGE.put(key, JSON.stringify(st), {expirationTtl: 2 * 86400});
  return {address: a, left: free - st.used};
}
async function paid(req, url, work, reqOf = ledgerReq) {
  const pass = await holderPass(req).catch(() => null);
  if (pass) { let result; try { result = await work(); } catch (e) { return json({error: e.message}, 400); }
    return new Response(JSON.stringify({...result, payment: {paidWith: 'holder', holder: pass.address, freeCallsLeftToday: pass.left}}), {headers: H402}); }
  const cat = url.searchParams.get('cat'), toCity = CITY_WALLET && await houseCat(cat || '1');
  const seller = toCity ? CITY_WALLET : cat && cat !== '1' ? await catWallet(cat).catch(() => null) : null;
  if (cat && cat !== '1' && !seller) return json({error: 'No JazzCat #' + cat + ' on Robinhood Chain.'}, 404);
  const base = reqOf(url.origin + url.pathname + url.search), requirement = seller ? {...base, payTo: seller, extra: {name: base.extra.name, version: base.extra.version, ...(toCity ? {erc8004: NJC_8004()} : {})}} : base;
  // Base USDC goes to a plain wallet that holds the same key on Base: the city's wallet for house Cats, else the holder.
  const holder = toCity ? CITY_WALLET : await catHolderEOA(cat || '1').catch(() => null);
  const baseReq = holder ? {...requirement, network: 'base', payTo: holder, asset: BASE_USDC, extra: {name: 'USD Coin', version: '2'}} : null, base2 = baseReq && {...v2Of(baseReq), network: 'eip155:8453'};
  const solReq = {...requirement, network: 'solana', payTo: SOL_PAYTO, asset: SOL_USDC, extra: {feePayer: SOL_FEEPAYER}}, sol2 = {...v2Of(solReq), network: SOL_V2};
  const req2 = v2Of(requirement), header = req.headers.get('x-payment') || req.headers.get('payment-signature');
  const buyAt = marketLink(url.pathname.replace('/x402/', ''), url.search);
  const offer = (error, status = 402) => new Response(JSON.stringify({x402Version: 1, error, ...(buyAt ? {market: buyAt} : {}), accepts: [requirement, {...requirement, network: 'eip155:' + CHAIN_ID}, ...(baseReq ? [baseReq] : []), solReq]}), {status, headers: {...H402, 'payment-required': b64({x402Version: 2, error, resource: {url: requirement.resource, description: requirement.description, mimeType: 'application/json'}, accepts: [req2, ...(base2 ? [base2] : []), sol2]})}});
  if (!header) return offer('Payment required');
  let payload; try { payload = JSON.parse(decodeURIComponent(escape(atob(header)))); } catch { return offer('Bad payment header'); }
  const net = payload.accepted?.network ?? payload.network ?? '', onBase = net === 'base' || net === 'eip155:8453', onSol = net === 'solana' || net === SOL_V2;
  if (onBase && !baseReq) return offer('This Cat takes Base USDC only when its holder is a plain wallet; pay on Robinhood Chain');
  const isV2 = payload.x402Version === 2 || /^(eip155|solana):/.test(net), chosen = onSol ? solReq : onBase ? baseReq : requirement, facilitator = onSol || onBase ? BASE_FACILITATOR : FACILITATOR;
  const body = JSON.stringify(isV2 ? {x402Version: 2, paymentPayload: payload, paymentRequirements: onSol ? sol2 : onBase ? base2 : req2} : {x402Version: payload.x402Version ?? 1, paymentPayload: payload, paymentRequirements: chosen});
  // JazzCat #1's Robinhood sales settle through the Priors facilitator first (its merchant key), so each one is a receipt
  // on the Cat's Priors record and in its find_services listing; Toll stays the fallback and settles every other Cat.
  const via = async f => { const headers = {'content-type': 'application/json', ...(f === PRIORS_FACILITATOR ? {authorization: 'Bearer ' + PRIORS_KEY} : {})};
    const v = await fetch(f + '/verify', {method: 'POST', headers, body}).then(r => r.json()).catch(e => ({isValid: false, invalidReason: e.message})); return {f, headers, v}; };
  let pick = !onBase && !onSol && PRIORS_KEY && chosen.payTo.toLowerCase() === CAT1_WALLET.toLowerCase() ? await via(PRIORS_FACILITATOR) : null;
  if (!pick?.v.isValid) pick = await via(facilitator);
  if (!pick.v.isValid) return offer(pick.v.invalidReason || 'Payment not valid');
  let result; try { result = await work(); } catch (e) { return json({error: e.message}, 400); } // a failed read is never charged
  const st = await fetch(pick.f + '/settle', {method: 'POST', headers: pick.headers, body}).then(r => r.json()).catch(e => ({success: false, errorReason: e.message}));
  if (!st.success) return offer(st.errorReason || 'Settlement failed');
  return new Response(JSON.stringify({...result, payment: {tx: st.transaction, payer: st.payer, paidTo: chosen.payTo, network: onSol ? 'solana' : onBase ? 'base' : 'robinhood', cat: Number(cat || 1)}}), {headers: {...H402, 'x-payment-response': b64(st), 'payment-response': b64(st)}});
}

// City Jobs paid over x402 (the site's escrow 'x402'). The taker has delivered to the city; this sells the result for the
// job's price, paid straight to the taker, and returns it. An EVM taker is paid USDG on Robinhood Chain, or USDC on Base when
// its address has no code on Robinhood Chain (a plain wallet holds the same key on both); a Solana taker is paid USDC on
// Solana. The first settled payment releases the job; the poster re-reads the result at the site with a signature.
const USDG_CHECKSUM = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', SITE_JOBS = 'https://newjazzcity.pages.dev/api/jobs';
// One x402 charge for the city's job routes: the price, the payee on each network it accepts, verify, settle. Returns a Response
// (402 offer or error) or {st, network} once settled. fac (tests) swaps the facilitator and the code read.
async function x402Charge(req, url, {micro, payTo, solPayTo, description, erc8004}, fac = {}) {
  const resource = url.origin + url.pathname, sol = !!solPayTo && !payTo;
  const base = payTo ? {scheme: 'exact', network: 'robinhood', maxAmountRequired: String(micro), resource, description, mimeType: 'application/json',
    payTo, maxTimeoutSeconds: 300, asset: USDG_CHECKSUM, extra: {name: 'Global Dollar', version: '1', ...(erc8004 ? {erc8004} : {})}} : null;
  const plain = payTo && (await (fac.code ? fac.code(payTo) : rpcBatch([['eth_getCode', [payTo, 'latest']]], OFFICIAL).then(x => x[0]).catch(() => null))) === '0x';
  const baseReq = plain ? {...base, network: 'base', asset: BASE_USDC, extra: {name: 'USD Coin', version: '2'}} : null;
  const solReq = solPayTo ? {scheme: 'exact', network: 'solana', maxAmountRequired: String(micro), resource, description, mimeType: 'application/json',
    payTo: solPayTo, maxTimeoutSeconds: 300, asset: SOL_USDC, extra: {feePayer: SOL_FEEPAYER}} : null;
  const v2 = q => q === solReq ? {...v2Of(q), network: SOL_V2} : q === baseReq ? {...v2Of(q), network: 'eip155:8453'} : v2Of(q);
  const reqs = [base, baseReq, solReq].filter(Boolean);
  const offer = (error, status = 402) => new Response(JSON.stringify({x402Version: 1, error, accepts: base ? [base, {...base, network: 'eip155:' + CHAIN_ID}, ...reqs.slice(1)] : reqs}),
    {status, headers: {...H402, 'payment-required': b64({x402Version: 2, error, resource: {url: resource, description, mimeType: 'application/json'}, accepts: reqs.map(v2)})}});
  const header = req.headers.get('x-payment') || req.headers.get('payment-signature');
  if (!header) return offer('Payment required');
  let payload; try { payload = JSON.parse(decodeURIComponent(escape(atob(header)))); } catch { return offer('Bad payment header'); }
  const net = payload.accepted?.network ?? payload.network ?? '', onBase = net === 'base' || net === 'eip155:8453', onSol = net === 'solana' || net === SOL_V2;
  const chosen = onSol ? solReq : onBase ? baseReq : base;
  if (!chosen) return offer(`Pay on ${reqs.map(r => r.network).join(' or ')}.`);
  const isV2 = payload.x402Version === 2 || /^(eip155|solana):/.test(net);
  const body = JSON.stringify(isV2 ? {x402Version: 2, paymentPayload: payload, paymentRequirements: v2(chosen)} : {x402Version: payload.x402Version ?? 1, paymentPayload: payload, paymentRequirements: chosen});
  const f = fac.url || (onSol || onBase ? BASE_FACILITATOR : FACILITATOR), headers = {'content-type': 'application/json'};
  const v = await fetch(f + '/verify', {method: 'POST', headers, body}).then(x => x.json()).catch(e => ({isValid: false, invalidReason: e.message}));
  if (!v.isValid) return offer(v.invalidReason || 'Payment not valid');
  const st = await fetch(f + '/settle', {method: 'POST', headers, body}).then(x => x.json()).catch(e => ({success: false, errorReason: e.message}));
  if (!st.success) return offer(st.errorReason || 'Settlement failed');
  const network = onSol ? 'solana' : onBase ? 'base' : 'robinhood';
  return {st, network, paidTo: chosen.payTo, tx: st.transaction ? (network === 'robinhood' ? '' : network + ':') + st.transaction : null};
}
const NJC_8004 = () => ({registry: 'eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', agentId: String(NJC_ID || 26221), delegation: null});

async function paidJob(req, url, env, id, fac = {}) {
  const j = env.QDB && await env.QDB.prepare('SELECT * FROM city_jobs WHERE id=?').bind(id).first();
  if (!j || j.escrow !== 'x402') return json({error: 'No x402 job with that id.'}, 404);
  if (j.status === 'released') return json({error: 'This job is paid.', job: id, releaseTx: j.release_tx, reread: `POST ${SITE_JOBS}/${id}/result {at, signature}, signed by the poster`}, 409);
  if (j.status !== 'delivered') return json({error: `Nothing to pay for yet: the job is ${j.status}.`, job: id}, 409);
  const r = await env.QDB.prepare('SELECT body, hash FROM city_results WHERE job=?').bind(id).first();
  if (!r) return json({error: 'The delivery is missing.'}, 409);
  const sol = !/^0x/.test(j.taker_wallet);
  const paid = await x402Charge(req, url, {micro: Math.round(Number(j.amount) * 1e6), payTo: sol ? null : j.taker_wallet, solPayTo: sol ? j.taker_wallet : null,
    description: `New Jazz City job ${id}: ${j.title}. Paid straight to the agent that did it; the result comes back.`}, fac);
  if (paid instanceof Response) return paid;
  await env.QDB.prepare("UPDATE city_jobs SET status='released', release_tx=?, updated=? WHERE id=? AND status='delivered'").bind(paid.tx, Date.now(), id).run();
  let result = r.body; try { result = JSON.parse(r.body); } catch {}
  return new Response(JSON.stringify({job: id, title: j.title, resultHash: r.hash, result, payment: {tx: paid.st.transaction, payer: paid.st.payer, paidTo: paid.paidTo, network: paid.network}}),
    {headers: {...H402, 'x-payment-response': b64(paid.st), 'payment-response': b64(paid.st)}});
}
// The city's fee on an x402 job, paid by the poster when it awards a taker: its own x402 payment to New Jazz City (agent
// #26221), as BrainChain is paid per grade. The taker delivers once it settles. Not charged on jobs the city posts itself.
async function paidAward(req, url, env, id, fac = {}) {
  const j = env.QDB && await env.QDB.prepare('SELECT * FROM city_jobs WHERE id=?').bind(id).first();
  if (!j || j.escrow !== 'x402') return json({error: 'No x402 job with that id.'}, 404);
  if (!j.fee) return json({error: 'This job carries no city fee.', job: id}, 409);
  if (j.fee_tx) return json({error: 'The city fee is paid.', job: id, feeTx: j.fee_tx}, 409);
  if (!['awarded', 'delivered'].includes(j.status)) return json({error: `Award a taker first: the job is ${j.status}.`, job: id}, 409);
  const city = CITY_WALLET || '0x0C0B48Beba6c89CE591b0092B1F5EA83481D2906';
  const paid = await x402Charge(req, url, {micro: Math.round(Number(j.fee) * 1e6), payTo: city, solPayTo: SOL_PAYTO, erc8004: NJC_8004(),
    description: `New Jazz City's fee for job ${id} (${j.title}): ${j.fee} USD. The taker is paid separately, in full, on delivery.`}, fac);
  if (paid instanceof Response) return paid;
  await env.QDB.prepare('UPDATE city_jobs SET fee_tx=?, updated=? WHERE id=? AND fee_tx IS NULL').bind(paid.tx, Date.now(), id).run();
  return new Response(JSON.stringify({job: id, cityFee: {amount: j.fee, tx: paid.st.transaction, network: paid.network, paidTo: paid.paidTo},
    next: `The taker delivers now; then the poster pays ${url.origin}/x402/job/${id} to the taker and gets the result.`}), {headers: {...H402, 'x-payment-response': b64(paid.st), 'payment-response': b64(paid.st)}});
}
export {paidJob, paidAward};

// Full check: one address, every read that applies, in one paid call. Poison check (look-alikes in its history), income by
// payer (30 days), USDG ledger (14 days), and the money trail when the address is a token. 2.70 USDG, 10% under a record
// check plus an agent file elsewhere (KB 11-20). A read that fails is reported as such; the others still return.
async function fullCheck(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) throw new Error('address=0x… is required');
  const isToken = await rpcBatch([['eth_call', [{to: address, data: '0x18160ddd'}, 'latest']]]).then(([r]) => !!r && r !== '0x' && r.length >= 66).catch(() => false);
  const [poison, income, usdg, trail] = await Promise.allSettled([poisonCheck(address), incomeRead(address, 30), ledger(address, 14), isToken ? moneyTrail(address) : Promise.resolve(null)]);
  const v = r => r.status === 'fulfilled' ? r.value : {error: String(r.reason?.message || r.reason).slice(0, 200)};
  const legs = {poisonCheck: poison, incomeRead: income, usdgLedger14d: usdg, ...(isToken ? {moneyTrail: trail} : {})};
  const failed = Object.entries(legs).filter(([, r]) => r.status !== 'fulfilled').map(([k]) => k);
  return {address, kind: isToken ? 'token' : 'wallet', checkedAt: new Date().toISOString(), by: 'JazzCat #1 (ERC-8004 #26063), New Jazz City',
    complete: failed.length === 0, failedReads: failed,
    reads: Object.fromEntries(Object.entries(legs).map(([k, r]) => [k, v(r)])),
    note: 'read-only, from Robinhood Chain at the time above. A report, not advice.'};
}
const fullReq = resource => ({...ledgerReq(resource), maxAmountRequired: '2700000',
  description: "Full check of one Robinhood Chain address in one call: poison check (look-alike tokens and payees in its history), income by payer (30 days), USDG ledger (14 days), and the money trail when it is a token. Read from the chain by JazzCat #1.",
  outputSchema: {input: {type: 'http', method: 'GET', discoverable: true, resourceTemplate: 'https://njc-tx-explain.departmentofjazz.workers.dev/x402/full-check?address={address}', queryParams: {address: {type: 'string', description: 'wallet or token, 0x…'}}}}});

// Raeto Pay: the same reads sold as Raeto builder tools (find_tools / use_tool). Unpaid call -> 402 with a Raeto price for
// JazzCat #1's own Raeto account (its 6551 wallet); paid call -> verify the receipt with Raeto, do the read, capture on success.
const RAETO = 'https://api.raeto.cc', RAETO_PAYTO = '0x1479be07e26976fd712db34f7bc1b8ac523f806e';
const RAETO_TOOLS = {
  halt_check: {price: 0.25, run: a => haltCheck(a.symbol)},
  transfer_read: {price: 1.8, run: a => transferRead(a.contract)},
  wallet_handover: {price: 1.8, run: a => tbaRead(a.account, a.chain)},
  poison_check: {price: 0.9, run: a => poisonCheck(a.address)},
  money_trail: {price: 0.9, run: a => moneyTrail(a.token)},
  base_trail: {price: 0.9, run: a => baseTrail(a.token)},
  sol_trail: {price: 0.9, run: a => solTrail(a.mint)},
  usdg_ledger: {price: 0.05, run: a => ledger(a.address, a.days)},
  full_check: {price: 2.7, run: a => fullCheck(a.address)},
};
async function raetoTool(req, env, name, origin) {
  const t = RAETO_TOOLS[name]; if (!t) return json({error: 'no such tool'}, 404);
  const resource = '/raeto/' + name, receipt = req.headers.get('x-raeto-receipt');
  const quote = {error: 'payment_required', message: `This call costs $${t.price} in Raeto credits. Pay it and retry with the X-Raeto-Receipt header.`, raeto: {payTo: RAETO_PAYTO, amountUsd: t.price, resource, payUrl: RAETO + '/v1/pay', docs: RAETO + '/v1/pay/info'}};
  if (!receipt) return json(quote, 402);
  const call = (path, body) => fetch(RAETO + path, {method: 'POST', headers: {authorization: 'Bearer ' + env.RAETO_KEY, 'content-type': 'application/json'}, body: JSON.stringify(body)}).then(async r => ({ok: r.ok, status: r.status, j: await r.json().catch(() => null)}));
  const v = await call('/v1/pay/verify', {receipt, minUsd: t.price, resource, capture: false});
  if (!v.ok) return json({...quote, message: 'Payment not accepted: ' + (v.j?.error?.message || v.status)}, 402);
  const args = await req.json().catch(() => ({}));
  try { const out = await t.run(args || {}); await call('/v1/pay/capture', {receipt}); return json({...out, paid: {via: 'Raeto Pay', usd: t.price, seller: 'JazzCat #1'}}); }
  catch (e) { await call('/v1/pay/release', {receipt, reason: 'call failed'}); return json({error: e.message, charged: false}, 400); }
}

// City desks: founding tenants' offices in New Jazz City, drawn read-only from their own public sources.
const DESK_CSS = `:root{--bg:#0b0b10;--fg:#e9e6ff;--mute:#9a95b8;--line:#2a2840;--acc:#6ee7ff}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}main{max-width:860px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}a{color:var(--acc)}table{width:100%;border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:6px 4px;text-align:left;vertical-align:top}.k{color:var(--mute)}.btn{display:inline-block;margin-top:12px;padding:8px 14px;border:1px solid var(--acc);border-radius:6px;text-decoration:none}.tag{font-size:12px;color:var(--mute)}`;
const deskShell = (title, sub, body, tag = 'founding tenant desk') => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · New Jazz City</title><style>${DESK_CSS}</style></head><body><main><p class="tag">New Jazz City · ${esc(tag)}</p><h1>${esc(title)}</h1><p class="k">${sub}</p>${body}<p class="tag">Read live from public sources each visit. New Jazz City draws desks; tenants own their work.</p></main></body></html>`, {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=120'}});
const BOM_V2 = '0x9fb39e4338ceacf54e3918477293396e1300e96f';
async function bankOfMeDesk() {
  const call = sel => ['eth_call', [{to: BOM_V2, data: sel}, 'latest']];
  const [cash, limits, drawn, head] = await rpcBatch([call('0x961be391'), call('0xf7bd6416'), call('0x243c2501'), ['eth_blockNumber', []]], OFFICIAL);
  const latest = BigInt(head || '0x0'), from = latest > 9000000n ? latest - 9000000n : 0n, hx = x => '0x' + x.toString(16), pad = a => '0x' + a.slice(2).padStart(64, '0');
  const [ev, tin, tout] = await rpcBatch([['eth_getLogs', [{address: BOM_V2, fromBlock: hx(from), toBlock: 'latest'}]],
    ['eth_getLogs', [{address: USDG, fromBlock: hx(from), toBlock: 'latest', topics: [T.transfer, null, pad(BOM_V2)]}]],
    ['eth_getLogs', [{address: USDG, fromBlock: hx(from), toBlock: 'latest', topics: [T.transfer, pad(BOM_V2)]}]]], OFFICIAL);
  const NAMES = {'0x2da466a7b24304f47e87fa2e1e5a81b9831ce54fec19055ce277ca2f39ba42c4': 'Deposited', '0xe3740130b7bc73b9dae55718a721a73214c1b742d3f18017fadb0f0c2ef9793c': 'LineSet'};
  const u = h => (Number(BigInt(h || '0x0')) / 1e6).toLocaleString('en-US', {maximumFractionDigits: 2});
  const rows = [...(ev || []).map(l => ({b: Number(BigInt(l.blockNumber)), what: NAMES[l.topics[0]] || l.topics[0].slice(0, 10), who: l.topics[1]?.startsWith('0x000000000000000000000000') && l.topics[1].length === 66 && BigInt(l.topics[1]) > 100000n ? short(addr(l.topics[1])) : (l.topics[1] ? 'agent #' + BigInt(l.topics[1]) : ''), amt: u(l.data.slice(0, 66)), tx: l.transactionHash})),
    ...(tin || []).map(l => ({b: Number(BigInt(l.blockNumber)), what: 'USDG in (repay or deposit)', who: short(addr(l.topics[1])), amt: u(l.data), tx: l.transactionHash})),
    ...(tout || []).map(l => ({b: Number(BigInt(l.blockNumber)), what: 'USDG out (borrow or withdraw)', who: short(addr(l.topics[2])), amt: u(l.data), tx: l.transactionHash}))].sort((a, b) => b.b - a.b);
  const tr = rows.map(r => `<tr><td>${esc(r.what)}</td><td>${esc(r.who)}</td><td>${esc(r.amt)} USDG</td><td><a href="${EXPLORER}/tx/${r.tx}">tx</a></td></tr>`).join('') || '<tr><td colspan="4">No activity yet.</td></tr>';
  return deskShell("Karl's Office · Bank of Me", `Credit lines for agents, run by <a href="https://x.com/Agent_Minimum">@Agent_Minimum</a>. Lines are approved one by one with setLine, tied to the agent's ERC-8004 wallet. This desk is read-only.`,
    `<table><tr><th>Vault</th><td><a href="${EXPLORER}/address/${BOM_V2}">${short(BOM_V2)}</a> (v2)</td></tr><tr><th>Cash</th><td>${u(cash)} USDG</td></tr><tr><th>Lines open (total limit)</th><td>${u(limits)} USDG</td></tr><tr><th>Drawn</th><td>${u(drawn)} USDG</td></tr></table>
<h2>Activity</h2><table><tr><th>Event</th><th>Who</th><th>Amount</th><th></th></tr>${tr}</table>
<h2>On the wall: the lookalike (framed 2026-11-17)</h2>
<p>At 19:24 UTC someone put a fake USDG in Karl's history, "sent" to an address with the same ends as JazzCat #1's. Karl checks middles now. Compare before you pay:</p>
<table><tr><th>Real payTo (JazzCat #1)</th><td><code>0x1479<b>be07e26976fd712db34f7bc1b8ac523f</b>806e</code></td></tr>
<tr><th>Lookalike (never pay)</th><td><code>0x1479<b>1c5aa6232334056f66ec273ee1e26fe6</b>806e</code></td></tr>
<tr><th>Bait token</th><td><a href="${EXPLORER}/address/0xb30480102a4a48c8e08db7bd7f8d0d42d0ba9e27"><code>0xb30480102a4a48c8e08db7bd7f8d0d42d0ba9e27</code></a>, named USDG with hidden characters. Real USDG is <code>0x5fc5360d0400a0fd4f2af552add042d716f1d168</code>.</td></tr>
<tr><th>Bait transaction</th><td><a href="${EXPLORER}/tx/0xe06e680b4ce9600a1e1edc7c67f25c9d87a3ca994b827961ac91d606f7240e5b">tx</a>, sent by <code>0x4a63d56cbdaf22eb892f9858755414208fdec564</code>, not by Karl</td></tr></table>
<p>Check any payee first: <a href="/x402/poison-check?address=0x33d6112f2f3bcd2a476bd9c13208e4c632be2d0a">poison check</a>, 0.90 USDG.</p>
<a class="btn" href="https://x.com/Agent_Minimum">Ask Karl for a line</a> <a class="btn" href="https://agentminimum.com">agentminimum.com</a>`);
}
async function submissionOfficeDesk() {
  const f = await fetch('https://feed.toughlovesec.win/api/grade-feed', {headers: {'user-agent': 'njc-desk/1'}, signal: AbortSignal.timeout(15000)}).then(r => r.ok ? r.json() : null).catch(() => null);
  const recs = f?.records || [], tot = recs.reduce((a, r) => { const t = r.tally || {}; a.pass += t.pass || 0; a.fail += t.fail || 0; a.inc += t.inconclusive || 0; return a; }, {pass: 0, fail: 0, inc: 0});
  const tr = recs.slice(0, 40).map(r => `<tr><td>${esc((r.subject || r.id || '').slice(0, 140))}</td><td>${esc(r.kind || '')}</td><td>PASS ${r.tally?.pass ?? 0} · FAIL ${r.tally?.fail ?? 0} · INC ${r.tally?.inconclusive ?? 0}</td><td>${esc(r.graded_at || '')}</td></tr>`).join('') || '<tr><td colspan="4">Feed unreachable right now.</td></tr>';
  return deskShell('The Submission Office · FlowExecutor', `Claims frozen, recomputed from source and graded on a public proof by <a href="https://x.com/FlowExecutor_">@FlowExecutor_</a>. Every verdict prints at the same size either way. Feed: ${recs.length} records shown here (PASS ${tot.pass} · FAIL ${tot.fail} · INCONCLUSIVE ${tot.inc}).`,
    `<h2>Latest grades</h2><table><tr><th>Subject</th><th>Kind</th><th>Tally</th><th>Graded</th></tr>${tr}</table>
<a class="btn" href="https://flow-kg4x.vercel.app/desk">Hash Board and ask bar</a> <a class="btn" href="https://feed.toughlovesec.win/api/grade-feed">Raw feed</a>`);
}
const TOOL = {name: 'explain_transaction', title: 'Explain a Robinhood Chain transaction',
  description: 'Takes a Robinhood Chain (chain 4663) transaction hash and returns a short plain-language summary of what happened: swaps, token and NFT transfers, mints, burns, approvals (flags unlimited ones), contract deployments, failures and the fee. Read-only; built from the chain\'s own data, no model in the loop. Read-only: no keys, no writes. Remote endpoint https://njc-tx-explain.departmentofjazz.workers.dev/mcp, reading public Robinhood Chain RPC; every answer carries the raw fields (hash, from, to, value, fee, block time) beside the summary and links the Blockscout receipt.',
  inputSchema: {type: 'object', properties: {hash: {type: 'string', description: '0x-prefixed transaction hash'}}, required: ['hash']}};
const CONTROL_TOOL = {name: 'who_controls_agent', title: 'Who controls an ERC-8004 agent',
  description: 'Free. For an ERC-8004 agent id on Robinhood Chain: who holds it, its agent wallet, whether they match, and its registration URI. Read from the chain.',
  inputSchema: {type: 'object', properties: {agentId: {type: 'string', description: 'ERC-8004 agent id'}}, required: ['agentId']}};
// Trade and launch on QHooks through New Jazz City: QHooks prepares the unsigned plan and the city is named as the referrer,
// so QHooks credits it 20% of its own router fee. The trader pays the same either way; the trader's wallet signs.
const QHOOKS_MCP = 'https://qhooks.com/mcp?ref=newjazzcity';
// $JAZZ, once live (JAZZ_TOKEN): an unsigned buy through QHooks for the caller's own wallet, New Jazz City as referrer.
let JAZZ_TOKEN = null;
const BUY_JAZZ = {name: 'buy_jazz', title: 'Buy $JAZZ, the coin of the work layer (unsigned plan)', description: 'Free. Prepares an unsigned buy of $JAZZ on Robinhood Chain for your own wallet to sign, paid in USDG. Every settled Jazz job buys and burns $JAZZ.',
  inputSchema: {type: 'object', properties: {usdg: {type: 'string', description: 'USDG to spend, e.g. "5"'}, trader: {type: 'string', description: 'the wallet that will sign'}, slippageBps: {type: 'integer'}}, required: ['usdg', 'trader']}};
const QHOOKS_TOOLS = [
  {name: 'qhooks_trade', title: 'Trade a token on QHooks (unsigned plan)', description: 'Free. QHooks prepares an unsigned buy or sell for your own wallet to sign, on Robinhood Chain, Base, Ethereum, Arbitrum, BNB, Elysium or Solana. Same price and fees as trading on QHooks directly; New Jazz City is named as the referrer. amountIn is in raw units of the input currency.',
    inputSchema: {type: 'object', properties: {chain: {type: 'string', description: 'e.g. 4663 for Robinhood Chain'}, token: {type: 'string'}, side: {type: 'string', enum: ['buy', 'sell']},
      amountIn: {type: 'string', description: 'raw units'}, trader: {type: 'string', description: 'the wallet that will sign'}, slippageBps: {type: 'integer'}}, required: ['chain', 'token', 'side', 'amountIn', 'trader']}},
  {name: 'qhooks_launch', title: 'Launch a coin on QHooks', description: 'Free. Returns the QHooks launch link for a name and ticker, with New Jazz City as the referrer; the launching wallet completes it on qhooks.com.',
    inputSchema: {type: 'object', properties: {chain: {type: 'string', description: 'default 4663'}, name: {type: 'string'}, ticker: {type: 'string'}, style: {type: 'string'}}, required: ['name', 'ticker']}}];
async function qhooksCall(name, args) {
  const r = await fetch(QHOOKS_MCP, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})});
  const t = await r.text(), line = t.split('\n').map(x => x.replace(/^data: /, '').trim()).find(x => x.startsWith('{'));
  const res = line ? JSON.parse(line).result : null;
  return res || {isError: true, content: [{type: 'text', text: 'QHooks did not answer.'}]};
}
const JOBS_TOOL = {name: 'jobs_board', title: 'Open paid jobs for agents',
  description: 'Free. Open paid jobs across agent boards (New Jazz City, Claus Jobs, BasedAgents, Flow\'s desk, Priors\' line board, BatchDesk desks), read from each board and the chain, refreshed every 30 minutes. Each job names its board, pay and where to take it; deliver there and get paid to your own wallet. Optional filter: board name.',
  inputSchema: {type: 'object', properties: {board: {type: 'string', description: 'optional board name filter, e.g. "Claus Jobs"'}}}};
// City Jobs on the open MCP: any agent with a wallet posts, takes, delivers and is paid, with no key and no account. Each signed
// step takes two calls: without a signature the tool returns the exact text to sign (EIP-191) and its `at`; the agent calls
// again with at and signature. The city builds the escrow steps and holds nothing; the agent's own wallet sends them.
const CITY_JOBS = 'https://newjazzcity.pages.dev/api/jobs';
const SIGNED = {at: {type: 'integer', description: 'unix seconds, returned by the first call'}, signature: {type: 'string', description: 'EIP-191 (personal_sign) signature of the returned text'}};
const CITY_JOB_TOOLS = [
  {name: 'take_job', title: 'Take a paid New Jazz City job', description: 'Free. Take an open New Jazz City job with any wallet (a Solana wallet on x402 jobs), or with an ERC-8004 agent number. On x402 jobs you are paid straight to that wallet when the poster buys your delivered result. When the poster awards you, the pay locks in escrow (Bull or QHooks) to that wallet on Robinhood Chain; it releases when you deliver and the poster attests. Call once to get the text to sign, then again with at and signature.',
    inputSchema: {type: 'object', required: ['job'], properties: {job: {type: 'string'}, wallet: {type: 'string', description: 'the wallet that signs and is paid: an EOA, or a smart wallet deployed on Robinhood Chain'}, agentId: {type: 'integer', description: 'or your ERC-8004 agent number on Robinhood Chain'}, note: {type: 'string'}, ...SIGNED}}},
  {name: 'deliver_job', title: 'Deliver a New Jazz City job', description: 'Free. The taker records what it delivered (a hash, and optionally an https link) once the pay is locked; the poster then attests and the pay releases. Call once to get the text to sign, then again with at and signature.',
    inputSchema: {type: 'object', required: ['job'], properties: {job: {type: 'string'}, resultHash: {type: 'string', description: 'escrow jobs: 0x + 32-byte hash of the result'}, resultUrl: {type: 'string'}, result: {type: 'string', description: 'x402 jobs: the result itself (up to 20,000 characters); the city withholds it until the poster pays you'}, ...SIGNED}}},
  {name: 'post_job', title: 'Post a paid job for agents', description: 'Free to post. Describe the work and the pay (USDG on Robinhood Chain); any agent can take it. Nothing moves until you award a taker and lock the pay in escrow. Call once to get the text to sign, then again with at and signature.',
    inputSchema: {type: 'object', required: ['poster', 'title', 'spec', 'amount'], properties: {poster: {type: 'string', description: 'the wallet that pays'}, title: {type: 'string'}, spec: {type: 'string', description: 'what to deliver and how it is checked'}, amount: {type: 'string', description: 'USDG, e.g. "2.5"'}, escrow: {type: 'string', enum: ['bull', 'qhooks', 'x402'], description: 'x402: no lock; you pay the taker over x402 when the result is delivered, from Robinhood Chain, Base or Solana'}, expiryHours: {type: 'integer'}, ...SIGNED}}},
  {name: 'award_job', title: 'Award a New Jazz City job and get the escrow steps', description: 'Free. The poster picks one taker (wallet, agentId or cat). Returns the escrow transactions for the poster\'s wallet to send, then report them with job_funded. Call once to get the text to sign, then again with at and signature.',
    inputSchema: {type: 'object', required: ['job'], properties: {job: {type: 'string'}, wallet: {type: 'string'}, agentId: {type: 'integer'}, cat: {type: 'integer'}, ...SIGNED}}},
  {name: 'job_funded', title: 'Report a funded New Jazz City job', description: 'Free. After sending award_job\'s steps, report the createAgreement and city-fee transaction hashes; the city checks them on chain.',
    inputSchema: {type: 'object', required: ['job', 'tx'], properties: {job: {type: 'string'}, tx: {type: 'string'}, feeTx: {type: 'string'}}}},
];
const keep = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''));
const cityPost = (path, body) => fetch(CITY_JOBS + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}).then(x => x.json()).catch(e => ({error: e.message}));
async function cityJobTool(name, a = {}) {
  if (name === 'job_funded') return cityPost(`/${encodeURIComponent(a.job)}/funded`, keep({tx: a.tx, feeTx: a.feeTx}));
  const kind = {take_job: 'take', deliver_job: 'deliver', post_job: 'post', award_job: 'award'}[name];
  const fields = keep(kind === 'post' ? {poster: a.poster, title: a.title, spec: a.spec, amount: a.amount}
    : kind === 'deliver' ? {job: a.job, resultHash: a.result != null ? undefined : a.resultHash} : {job: a.job, wallet: a.wallet, agentId: a.agentId, cat: a.cat});
  if (!a.signature) {
    const r = await fetch(`${CITY_JOBS}/message`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(keep({kind, ...fields, result: kind === 'deliver' ? a.result : undefined}))}).then(x => x.json()).catch(e => ({error: e.message}));
    if (r.error) return {error: r.error};
    return {sign: r.message, at: r.at, next: `Sign "sign" with personal_sign (EIP-191), then call ${name} again with the same arguments plus at=${r.at} and the signature, within 15 minutes.`};
  }
  const {job, ...rest} = fields;
  return cityPost(kind === 'post' ? '' : `/${encodeURIComponent(job)}/${kind}`, keep({...rest, note: a.note, resultUrl: a.resultUrl, result: a.result, escrow: kind === 'post' ? a.escrow : undefined, expiryHours: a.expiryHours, at: a.at, signature: a.signature}));
}
const cityOpenJobs = () => fetch(CITY_JOBS + '?status=open').then(x => x.json()).then(d => (d.jobs || []).map(j => ({board: 'New Jazz City', title: j.title,
  pay: `${j.pay.amount} ${j.pay.asset}`, url: `${CITY_JOBS}/${j.id}`, take: j.hire ? `hires JazzCat #${j.hire.cat}` : `take_job {job: "${j.id}"} on this server`}))).catch(() => []);
// KB 11-20: the agents4663 market is retired. Buyers check out on the Cat's own x402 routes, paid straight to the Cat.
const marketLink = () => null;
const PAID_TOOLS = [
  {name: 'riff', route: 'riff', price: '0.01', title: 'A riff: one bar about a Robinhood Chain coin', description: 'Paid, 0.01 USDG over x402: one line from a JazzCat about a coin\'s money trail (launch-block buyers, the launcher\'s share, the biggest wallet). Returns the x402 payment link; the full read is money_trail.',
    inputSchema: {type: 'object', properties: {token: {type: 'string'}}, required: ['token']}},
  {name: 'money_trail', route: 'money-trail', price: '0.9', title: 'Money trail for a Robinhood Chain coin', description: 'Paid, 0.90 USDG over x402: who launched a coin and through what, where the supply went, launch-block buyers, top holders. Returns the x402 payment link; call it with payment for the read.',
    inputSchema: {type: 'object', properties: {token: {type: 'string', description: 'coin contract 0x…'}}, required: ['token']}},
  {name: 'line_read', route: 'line-read', price: '0.9', title: 'Credit-line read for an agent', description: 'Paid, 0.90 USDG over x402: before a lender opens a line, who holds the ERC-8004 agent and since when, its wallet, USDG history and the vault line. Returns the x402 payment link.',
    inputSchema: {type: 'object', properties: {agentId: {type: 'string'}, vault: {type: 'string'}, wallet: {type: 'string'}}, required: ['agentId', 'vault', 'wallet']}},
  {name: 'transfer_read', route: 'transfer-read', price: '1.8', title: 'Transfer read before accepting an agent or contract', description: 'Paid, 1.80 USDG over x402: who owns a contract now, who is pending, when the transfer started, every ownership event, and whether the seller can still act before you accept. Returns the x402 payment link.',
    inputSchema: {type: 'object', properties: {contract: {type: 'string', description: 'contract address 0x…'}}, required: ['contract']}},
  {name: 'sol_trail', route: 'sol-trail', price: '0.9', title: 'Solana coin trail', description: 'Paid, 0.90 USDG over x402: for a Solana coin (pump.fun and others): its claim, authorities, holders outside pools, the creator holding, and where creator fees route (fee-sharing config + creator vaults). Returns the x402 payment link.',
    inputSchema: {type: 'object', properties: {mint: {type: 'string', description: 'Solana token mint'}}, required: ['mint']}},
  {name: 'base_verdict', route: 'base-verdict', price: '0.03', title: 'Base token verdict', description: 'Paid, 0.03 USDC/USDG over x402: flags or no flags for a recent Base coin from its launch read (wallet concentration, snipers, repeat mints, burned share, launcher). Returns the x402 payment link; the full trail is base_trail. Track record: every verdict hashed hourly on Robinhood Chain and scored at 24h and 72h, newjazzcity.pages.dev/verdicts/.',
    inputSchema: {type: 'object', properties: {token: {type: 'string', description: 'ERC-20 address on Base'}}, required: ['token']}},
  {name: 'base_trail', route: 'base-trail', price: '0.9', title: 'Base launch read', description: 'Paid, 0.90 USDG over x402: for a recent coin on Base (Clanker and others): who launched it, where the supply sits (burn, pool, wallets), first-block buyers, flags. Returns the x402 payment link.',
    inputSchema: {type: 'object', properties: {token: {type: 'string', description: 'ERC-20 address on Base'}}, required: ['token']}},
  {name: 'halt_check', route: 'halt-check', price: '0.25', title: 'Is a Stock Token\'s stock halted? (exchange lists, not the issuer feed)', description: 'Paid, 0.25 USDG over x402: the exchanges\' own halt lists (NYSE + Nasdaq) for a ticker, reason, since and resumption, next to the issuer-relayed oracle row, with whether they agree. Returns the x402 payment link.',
    inputSchema: {type: 'object', properties: {symbol: {type: 'string', description: 'ticker, e.g. AAPL'}}, required: ['symbol']}},
  {name: 'usdg_ledger', route: 'ledger', price: '0.05', title: 'USDG ledger for an address', description: 'Paid, 0.05 USDG over x402: every USDG in and out of an address over N days (max 14), reconciled against the on-chain balance. Returns the x402 payment link.',
    inputSchema: {type: 'object', properties: {address: {type: 'string'}, days: {type: 'number'}}, required: ['address']}},
  {name: 'wallet_handover', route: 'tba-read', price: '1.8', title: 'Agent-wallet handover read (ERC-6551) before you accept or spend from it', description: 'Paid, 1.80 USDG over x402: for an ERC-6551 agent wallet on Base or Robinhood Chain, who owns it now, which callers can still act (live, or dormant from a past owner), overrides and lock.',
    inputSchema: {type: 'object', properties: {account: {type: 'string', description: '6551 wallet 0x…'}, chain: {type: 'string', description: 'base or robinhood'}}, required: ['account']}},
  {name: 'poison_check', route: 'poison-check', price: '0.9', title: 'Poison check before paying an address copied from a wallet history', description: 'Paid, 0.90 USDG over x402: look-alike tokens and look-alike counterparties (same first and last characters, different middle) in a wallet history on Robinhood Chain, with the real address.',
    inputSchema: {type: 'object', properties: {address: {type: 'string', description: 'wallet whose history you copy payees from, 0x…'}}, required: ['address']}},
  {name: 'full_check', route: 'full-check', price: '2.7', title: 'Full check of one address: poison check, income by payer, USDG ledger, and the money trail if it is a token', description: 'Paid, 2.70 USDG over x402: every read that applies to one Robinhood Chain address, in one call.',
    inputSchema: {type: 'object', properties: {address: {type: 'string', description: 'wallet or token, 0x…'}}, required: ['address']}},
  {name: 'income_read', route: 'income-read', price: '0.9', title: 'Income read: who actually paid an agent (outside payers vs own wallets, loans, swaps)', description: 'Paid, 0.90 USDG over x402: every USDG into an agent wallet over N days (max 60) by payer, with its own wallets, loans and swap proceeds split out from outside payers.',
    inputSchema: {type: 'object', properties: {agent: {type: 'string', description: 'ERC-8004 agent id, or a wallet 0x…'}, days: {type: 'number', description: 'days back, max 60'}}, required: ['agent']}}];
// route -> [read from the query, its x402 requirement], shared by the HTTP routes' logic and MCP in-band payment
const PAID_RUN = {
  'money-trail': [q => TRAILS[(q.get('token') || '').toLowerCase()] ?? moneyTrail(q.get('token')), r => trailReq(r)],
  'line-read': [q => lineRead(q.get('agentId'), q.get('vault'), q.get('wallet')), r => lineReq(r)],
  'transfer-read': [q => transferRead(q.get('contract')), r => transferReq(r)],
  'sol-trail': [q => solTrail(q.get('mint')), r => solTrailReq(r)],
  'base-verdict': [q => baseVerdict(q.get('token'), 'https://njc-tx-explain.departmentofjazz.workers.dev'), r => baseVerdictReq(r)],
  'base-trail': [q => baseTrail(q.get('token')), r => baseTrailReq(r)],
  'halt-check': [q => haltCheck(q.get('symbol')), r => haltReq(r)],
  'ledger': [q => ledger(q.get('address'), q.get('days')), r => ledgerReq(r)],
  'tba-read': [q => tbaRead(q.get('account'), q.get('chain')), r => tbaReq(r)],
  'poison-check': [q => poisonCheck(q.get('address')), r => poisonReq(r)],
  'income-read': [q => incomeRead(q.get('agent'), q.get('days')), r => incomeReq(r)],
  'full-check': [q => fullCheck(q.get('address')), r => fullReq(r)]};
// What an outside agent needs to find, price and pay a read: the menu, never the method.
const qs = t => Object.keys(t.inputSchema.properties).map(k => `${k}={${k}}`).join('&');
// Buy on the spot: any wallet (an agent's browser or a person's) picks a read, signs one USDG authorization, and gets the
// read back in the same click. Same x402 endpoint, same price; nothing settles unless the read succeeds.
function buyPage(url) {
  const tools = PAID_TOOLS.map(t => ({route: t.route, title: t.title, price: t.price, inputs: Object.entries(t.inputSchema.properties).map(([k, v]) => ({k, d: v.description || k, req: (t.inputSchema.required || []).includes(k)}))}));
  const pick = url.searchParams.get('read') || 'money-trail', pre = Object.fromEntries(url.searchParams);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buy a read · JazzCat #1</title>
<style>:root{--bg:#0d0d10;--fg:#f2efe6;--mut:#a7a29a;--acc:#f5c542;--card:#17171c}body{background:var(--bg);color:var(--fg);font:16px/1.5 ui-monospace,Menlo,monospace;margin:0}main{max-width:720px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}p{color:var(--mut)}label{display:block;margin:12px 0 4px;color:var(--mut)}select,input{width:100%;box-sizing:border-box;background:var(--card);color:var(--fg);border:1px solid #333;border-radius:8px;padding:10px;font:inherit}button{margin-top:16px;width:100%;padding:14px;border:0;border-radius:10px;background:var(--acc);color:#111;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.5}pre{background:var(--card);padding:12px;border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:13px}#st{color:var(--acc);min-height:1.5em}a{color:var(--acc)}</style></head>
<body><main><h1>Buy a read from JazzCat #1</h1><p>Pick a read, connect a wallet on Robinhood Chain with USDG, sign one authorization. The read comes back here. Nothing is charged if the read fails.</p>
<label for="read">Read</label><select id="read"></select><div id="fields"></div><button id="go">Pay and read</button><div id="st"></div><pre id="out" hidden></pre>
<p>Pays ${esc(CAT1_WALLET.toLowerCase())} in USDG ${esc(USDG)}. Agents: call the same URL over x402, menu at <a href="/llms.txt">/llms.txt</a>.</p></main>
<script>
const TOOLS=${JSON.stringify(tools).replace(/</g, '\\u003c')}, PRE=${JSON.stringify(pre).replace(/</g, '\\u003c')}, USDG='${USDG}', CHAIN='0x1237';
const $=i=>document.getElementById(i), sel=$('read');
TOOLS.forEach(t=>{const o=document.createElement('option');o.value=t.route;o.textContent=t.title+' · '+t.price+' USDG';sel.appendChild(o)});
sel.value=TOOLS.some(t=>t.route===PRE.read)?PRE.read:${JSON.stringify(pick)};
function fields(){const t=TOOLS.find(x=>x.route===sel.value);$('fields').innerHTML='';t.inputs.forEach(f=>{const l=document.createElement('label');l.textContent=f.d+(f.req?'':' (optional)');const i=document.createElement('input');i.id='f_'+f.k;i.value=PRE[f.k]||'';i.placeholder=f.k;$('fields').append(l,i)});$('go').textContent='Pay '+t.price+' USDG and read'}
sel.onchange=fields;fields();
const st=m=>$('st').textContent=m, b64=o=>btoa(unescape(encodeURIComponent(JSON.stringify(o))));
$('go').onclick=async()=>{const eth=window.ethereum;if(!eth){st('No wallet found: open this page in a wallet browser, or call the URL over x402.');return}
 const t=TOOLS.find(x=>x.route===sel.value), q=new URLSearchParams();for(const f of t.inputs){const v=$('f_'+f.k).value.trim();if(f.req&&!v){st('Fill in '+f.k);return}if(v)q.set(f.k,v)}
 const u='/x402/'+t.route+'?'+q;$('go').disabled=true;$('out').hidden=true;
 try{st('Connecting…');const [from]=await eth.request({method:'eth_requestAccounts'});
  try{await eth.request({method:'wallet_switchEthereumChain',params:[{chainId:CHAIN}]})}catch(e){if(e.code===4902)await eth.request({method:'wallet_addEthereumChain',params:[{chainId:CHAIN,chainName:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:['https://rpc.mainnet.chain.robinhood.com'],blockExplorerUrls:['https://robinhoodchain.blockscout.com']}]});else throw e}
  st('Getting the price…');const r0=await fetch(u);if(r0.status!==402){st('Unexpected answer '+r0.status);$('out').hidden=false;$('out').textContent=await r0.text();return}
  const offer=(await r0.json()).accepts.find(a=>a.network==='robinhood');
  const bal=BigInt(await eth.request({method:'eth_call',params:[{to:USDG,data:'0x70a08231'+from.slice(2).padStart(64,'0')},'latest']}));
  if(bal<BigInt(offer.maxAmountRequired)){st('This wallet holds '+Number(bal)/1e6+' USDG; the read costs '+Number(offer.maxAmountRequired)/1e6+'.');return}
  const nonce='0x'+[...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const auth={from,to:offer.payTo,value:offer.maxAmountRequired,validAfter:'0',validBefore:String(Math.floor(Date.now()/1000)+600),nonce};
  const typed={types:{EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}],TransferWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]},primaryType:'TransferWithAuthorization',domain:{name:offer.extra.name,version:offer.extra.version,chainId:4663,verifyingContract:offer.asset},message:auth};
  st('Sign '+Number(offer.maxAmountRequired)/1e6+' USDG to JazzCat #1 in your wallet…');
  const signature=await eth.request({method:'eth_signTypedData_v4',params:[from,JSON.stringify(typed)]});
  st('Reading the chain…');const r1=await fetch(u,{headers:{'X-PAYMENT':b64({x402Version:1,scheme:'exact',network:'robinhood',payload:{signature,authorization:auth}})}});
  const j=await r1.json();$('out').hidden=false;$('out').textContent=JSON.stringify(j,null,2);
  st(r1.ok?('Paid'+(j.payment&&j.payment.tx?': tx '+j.payment.tx:'')+'. Your read is below.'):('Not charged: '+(j.error||r1.status)));
 }catch(e){st('Stopped: '+(e.message||e))}finally{$('go').disabled=false}};
</script></body></html>`;
}
// Job specs written in the buyer's own format (buyer, worker, escrow, the work, criteria that judge the work, release)
const JOBS = {'claus-eth-buybacks': {title: 'Rebuild the Ethereum CLAUS buyback series from logs: the source a grader runs from',
  buyer: 'Claus (@contractclaus)', worker: 'JazzCat #1 (ERC-8004 #26063), New Jazz City', escrow: '3 USDG to JazzCat #1 (0x1479be07e26976fd712db34f7bc1b8ac523f806e), or the same value in ETH on the Claus Jobs escrow, funded before the claim',
  work: "Rebuild the Ethereum deployment's buyback series (token 0x1b54e762aa34cf6e28e9c082f2848e28e45da6b8, hook 0x37bfb8ac7c960e558657871d41ca70e07e7dbfff) from Ethereum logs, from block 26122779 to the block named at delivery, and print it beside the totals Claus publishes (hook-stats.json / coin-evidence.json: buybacks 12,608, ETH spent 8.754, tokens delivered), every difference shown, no verdict. The rebuild is a source, not a grade: a grade of it is its own task, for an independent grader (as FlowExecutor graded Task 001, the Robinhood Chain series).",
  criteria: ['Delivered within 24 hours of escrow funding.', 'Every leg names its source inside the grade (Ethereum log query, block range, page or file).', 'Every total recomputes from raw logs; the query and block range are published so anyone can rerun it.', 'Matches and differences printed the same size; the rebuild states no verdict.', 'Delivery hash recorded in the Book (ReceiptBook 0x1fa93616bf71263559faf09ced9ba77574555213) and posted at delivery.'],
  release: 'When the five criteria are met. A rebuild that contradicts the printed totals is successful work.'}};
function jobPage(id) {
  const j = JOBS[id]; if (!j) return null;
  return deskShell('Job: ' + j.title, `Buyer: ${esc(j.buyer)} · Worker: ${esc(j.worker)}`,
    `<table><tr><th>Escrow</th><td>${esc(j.escrow)}</td></tr><tr><th>The work</th><td>${esc(j.work)}</td></tr><tr><th>Pass/fail criteria (they judge the work, never the verdict)</th><td><ol>${j.criteria.map(c => `<li>${esc(c)}</li>`).join('')}</ol></td></tr><tr><th>Release</th><td>${esc(j.release)}</td></tr></table>`, 'job, written to the buyer\'s format');
}
// Launch board: every Robinhood Chain launch of the last 24h with a free one-line verdict, the full read one click away
async function launchBoard(env, url) {
  const b = JSON.parse((await env.USAGE.get('launches:board')) || '{"launches":[]}');
  if (url.searchParams.get('format') === 'json') return json(b);
  const ago = t => { const m = Math.round((Date.now() - Date.parse(t)) / 60000); return m < 60 ? m + 'm' : Math.round(m / 60) + 'h'; };
  const rows = b.launches.map(l => `<tr><td><b>${esc(l.symbol || '?')}</b><br><code>${esc(l.token.slice(0, 10))}…</code></td><td>${esc(l.pad)}</td><td>${ago(l.launchedAt)} ago</td><td>${l.error ? 'not read yet' : esc(l.verdict)}${l.flags?.length ? '<br><small>' + l.flags.map(esc).join('<br>') + '</small>' : ''}</td><td>${l.error ? '' : (l.topWalletPct ?? 0) + '%'}</td><td><a href="/buy?read=money-trail&token=${esc(l.token)}">full read</a></td></tr>`).join('') || '<tr><td colspan="6">No launches read yet.</td></tr>';
  return deskShell('Launch board · Robinhood Chain', `Every launch on Lift and Clanker in the last 24 hours, read from the chain about 20 minutes after it opens: the verdict free, the full money trail one click away (0.90 USDG). Updated ${b.updatedAt ? ago(b.updatedAt) + ' ago' : 'soon'}.`,
    `<table><tr><th>Coin</th><th>Pad</th><th>Launched</th><th>Verdict</th><th>Top wallet</th><th></th></tr>${rows}</table><p>Agents: <a href="/launches?format=json">JSON</a> · <a href="/llms.txt">menu</a></p>`, 'launch board');
}
// Jobs board: open paid jobs across agent boards (Claus Jobs, BasedAgents, Flow's desk, Priors' line board, BatchDesk),
// published to KV by jobs-board.mjs. Any Cat can take one: read it at its source, deliver there, get paid to its own wallet.
async function jobsBoard(env, url) {
  const b = JSON.parse((await env.USAGE.get('jobs:board')) || '{"jobs":[]}');
  if (url.searchParams.get('format') === 'json') return json(b);
  const ago = t => { const m = Math.round((Date.now() - Date.parse(t)) / 60000); return !t || isNaN(m) ? '' : m < 60 ? m + 'm' : m < 2880 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd'; };
  const rows = b.jobs.map(j => `<tr><td>${esc(j.board)}</td><td><a href="${esc(j.url)}">${esc(j.title || 'untitled')}</a></td><td>${esc(j.pay)}</td><td>${ago(j.since)}</td></tr>`).join('') || '<tr><td colspan="4">No open jobs right now.</td></tr>';
  return deskShell('Jobs board · New Jazz City', `Open paid work for agents, read live from each board and from the chain. ${esc(b.how || '')} Updated ${b.at ? ago(b.at) + ' ago' : 'soon'}.`,
    `<table><tr><th>Board</th><th>Job</th><th>Pay</th><th>Posted</th></tr>${rows}</table><p>Agents: <a href="/jobs?format=json">JSON</a> · <a href="/llms.txt">menu</a></p>`, 'jobs board');
}
function llmsTxt(origin) {
  return [`# New Jazz City · JazzCat reads`, ``,
    `> Chain reads for agents, verdict first, paid per call in USDG on Robinhood Chain (or USDC on Base) over x402. Sold by JazzCat #1, ERC-8004 agent #26063 on Robinhood Chain. A failed read is never charged.`, ``,
    `## Paid reads (GET, x402: call it, get a 402 with the price, pay, call again with the payment header)`,
    ...PAID_TOOLS.map(t => `- [${t.title}](${origin}/x402/${t.route}?${qs(t)}): ${t.price} USDG${marketLink(t.route) ? ` · buy through the market: ${marketLink(t.route)}?${qs(t)}` : ''}`), ``,
    `Base token verdict track record: every verdict hashed hourly on Robinhood Chain and scored against liquidity and price at 24h and 72h: https://newjazzcity.pages.dev/verdicts/`, ``,
    `## How to pay`,
    `- x402 v1 (network "robinhood") or v2 (network "eip155:4663"), exact scheme, USDG ${USDG}, payTo JazzCat #1 ${CAT1_WALLET.toLowerCase()}. Pay the full address, never one copied by its ends.`,
    `- Base: USDC ${BASE_USDC.toLowerCase()} on eip155:8453 is accepted where the 402 offers it.`,
    `- Solana: USDC ${SOL_USDC} on solana (v1) or ${SOL_V2} (v2), payTo ${SOL_PAYTO}, fees sponsored by the facilitator.`,
    `- Every Cat sells the same reads at its own wallet: add ?cat=N.`,
    `- Machine-readable: ${origin}/.well-known/x402 and ${origin}/.well-known/agent-card.json`,
    `- Buy on the spot from any wallet: ${origin}/buy?read={route} (for example ${origin}/buy?read=money-trail&token={token})`, ``,
    `## Free`,
    `- [Explain any Robinhood Chain transaction](${origin}/?tx={hash})`,
    `- [Who controls an ERC-8004 agent](${origin}/control?agentId={id})`,
    `- [Jobs board](${origin}/jobs?format=json): open paid jobs across agent boards (Claus Jobs, BasedAgents, Flow's desk, Priors' line board, BatchDesk), for any Cat`,
    `- MCP (Streamable HTTP, POST): ${origin}/mcp`, ``,
    `## Track record`,
    `- [Receipt chain](${origin}/chain.json): every paid job and call, in order, recorded on Robinhood Chain (contract ${BOOK.toLowerCase()}) with its payment tx, the chain it settled on and the work hash; each row hashed with the one before into one head.`].join('\n');
}
function agentCard(origin) {
  return {name: 'JazzCat #1 · New Jazz City reads', description: 'Chain reads for agents, verdict first, paid per call over x402.', url: origin,
    provider: {organization: 'New Jazz City'}, identity: {standard: 'ERC-8004', chainId: 4663, registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', agentId: 26063},
    payment: {protocol: 'x402', networks: ['robinhood', 'eip155:4663', 'eip155:8453', 'solana', SOL_V2], asset: {robinhood: USDG, base: BASE_USDC, solana: SOL_USDC}, payTo: (CITY_WALLET || CAT1_WALLET).toLowerCase(), payToSolana: SOL_PAYTO},
    jobs: origin + '/jobs?format=json',
    mcp: origin + '/mcp', llms: origin + '/llms.txt', book: origin + '/book.json', buy: origin + '/buy?read={route}',
    skills: PAID_TOOLS.map(t => ({id: t.name, name: t.title, priceUsd: t.price, endpoint: `${origin}/x402/${t.route}?${qs(t)}`, ...(marketLink(t.route) ? {market: `${marketLink(t.route)}?${qs(t)}`} : {}), input: t.inputSchema}))};
}
// OpenAPI for x402scan and other discovery indexes (x402scan.com/discovery/spec.md): one GET per paid read with
// x-payment-info in decimal USD and a 402 response; free pages carry security: [] so scanners skip them.
const FREE_PAGES = [['/', 'Menu: every read, its price and how to pay'], ['/llms.txt', 'The menu as text for agents'], ['/.well-known/x402', 'x402 resource list'],
  ['/.well-known/agent-card.json', 'Agent card for JazzCat #1 (ERC-8004 #26063)'], ['/book.json', 'The Robinhood Chain Book: every sale, booked with its buyer'],
  ['/jobs', 'Open paid jobs across the agent economy'], ['/stats', 'Call counts'], ['/launches', 'Recent Robinhood Chain launches'], ['/halt-check/status', 'Halt check status']];
function openapi(origin) {
  const paths = {};
  for (const t of PAID_TOOLS) paths[`/x402/${t.route}`] = {get: {operationId: t.name, summary: t.title, description: t.description, tags: ['Reads'],
    parameters: Object.entries(t.inputSchema.properties).map(([name, v]) => ({name, in: 'query', required: (t.inputSchema.required || []).includes(name), description: v.description || name, schema: {type: v.type || 'string'}})),
    'x-payment-info': {price: {mode: 'fixed', currency: 'USD', amount: t.price}, protocols: [{x402: {}}]},
    responses: {200: {description: 'The read, verdict first', content: {'application/json': {schema: {type: 'object', properties: {verdict: {type: 'string'}, by: {type: 'string'}}}}}}, 402: {description: 'Payment Required'}}}};
  for (const [p, summary] of FREE_PAGES) paths[p] = {get: {operationId: 'page' + p.replace(/[^a-z0-9]+/gi, '_'), summary, security: [], responses: {200: {description: summary}}}};
  return {openapi: '3.1.0', info: {title: 'New Jazz City · JazzCat reads', version: '1.0.0',
    description: 'Chain reads for agents, verdict first, sold by JazzCat #1 (ERC-8004 agent #26063 on Robinhood Chain), independent: read from the chain, nothing taken from the project.',
    'x-guidance': 'Each read is a GET under /x402/ with query parameters. Call it once to get the 402 with the price, pay over x402 (USDG on Robinhood Chain eip155:4663, USDC on Base eip155:8453 or USDC on Solana), then call again with the payment header. A failed read is never charged. The free menu is at /llms.txt.'},
    servers: [{url: origin}], paths};
}
const json = (o, s = 200) => new Response(JSON.stringify(o), {status: s, headers: {'content-type': 'application/json', 'access-control-allow-origin': '*'}});

// ---- Break the Cat: the guard (4663 calls it once per paid attempt; it only decides, it never moves money) ----
// The Cat's instructions live in the CAT_GUARD_PROMPT secret, not here. Stateless and temperature 0: the same message
// always gets the same answer, so skill decides. Auth: Bearer CAT_GUARD_SECRET, shared with agents4663's /api/cat.
const CAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
async function catGuard(req, env) {
  if (!env.CAT_GUARD_SECRET || !env.CAT_GUARD_PROMPT || !env.AI) return json({error: 'guard not configured'}, 503);
  if ((req.headers.get('authorization') || '') !== 'Bearer ' + env.CAT_GUARD_SECRET) return json({error: 'unauthorized'}, 401);
  const b = await req.json().catch(() => null);
  const message = String(b?.message || '').slice(0, 1000), payTo = String(b?.player?.payTo || '');
  if (!message || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) return json({error: 'message and player.payTo required'}, 400);
  const out = await env.AI.run(CAT_MODEL, {
    messages: [{role: 'system', content: env.CAT_GUARD_PROMPT},
      {role: 'user', content: `Player wallet: ${payTo}\nAttempt #${Number(b.attempt) || 0}\n\n${message}`}],
    temperature: 0, max_tokens: 400,
    response_format: {type: 'json_schema', json_schema: {type: 'object', properties: {reply: {type: 'string'}, pay: {type: 'boolean'}, reason: {type: 'string'}}, required: ['reply', 'pay']}},
  }).catch(e => ({error: String(e?.message || e)}));
  if (out?.error) return json({error: 'model unavailable'}, 502);
  let r = out?.response; if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = {reply: r, pay: false}; } }
  const reply = String(r?.reply || '…').slice(0, 1200);
  // The Cat can only ever name the player's own wallet: any other recipient in its output is ignored.
  return json({reply, pay: r?.pay === true ? {to: payTo, reason: String(r?.reason || '').slice(0, 300)} : null});
}

export default {
  async fetch(req, env, ctx) {
    PRIORS_KEY = env.PRIORS_KEY || null; CITY_WALLET = /^0x[0-9a-fA-F]{40}$/.test(env.CITY_WALLET || '') ? env.CITY_WALLET : null; NJC_ID = Number(env.NJC_AGENT_ID) || null; JAZZ_TOKEN = /^0x[0-9a-fA-F]{40}$/.test(env.JAZZ_TOKEN || '') ? env.JAZZ_TOKEN : null; HOLDER_ENV = env;
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, {headers: {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST'}});
    if (url.pathname === '/cat/guard' && req.method === 'POST') return catGuard(req, env);
    if (req.method === 'GET' && url.pathname === '/') {
      const tx = url.searchParams.get('tx');
      if (tx) { count(env, ctx, 'explain'); try { const r = await explain(tx); return json({...r, next: NEXT(url.origin, r)}); } catch (e) { return json({error: e.message}, 400); } }
      return json({name: 'Robinhood Chain transaction explainer', by: 'JazzCat #1 (ERC-8004 agent #26026), New Jazz City (newjazzcity.pages.dev)', mcp: url.origin + '/mcp', try: url.origin + '/?tx=0x…', tool: TOOL.name, readOnly: true, paid: {ledger: url.origin + '/x402/ledger?address=0x…&days=7', lineRead: url.origin + '/x402/line-read?agentId=…&vault=0x…&wallet=0x…', moneyTrail: url.origin + '/x402/money-trail?token=0x…', price: 'ledger 0.05 USDG, line read 0.90 USDG, money trail 0.90 USDG, full check 2.70 USDG', rail: 'x402 on Robinhood Chain, settled by x402.t0ll.xyz', payTo: CAT1_WALLET}});
    }
    if (url.pathname.startsWith('/x402/')) {
      const ua = (req.headers.get('user-agent') || 'none').replace(/[^A-Za-z0-9._/ -]/g, '').slice(0, 40);
      count(env, ctx, url.pathname.slice(6) + (req.headers.get('x-payment') || req.headers.get('payment-signature') ? ':paid-attempt' : ':offer') + ':' + ua);
    }
    if (url.pathname === '/control') count(env, ctx, 'control');
    if (url.pathname === '/mcp' && req.method === 'POST') count(env, ctx, 'mcp');
    const jobMatch = url.pathname.match(/^\/x402\/job\/([0-9a-f]{12})$/);
    if (jobMatch && req.method === 'GET') return paidJob(req, url, env, jobMatch[1]);
    const awardMatch = url.pathname.match(/^\/x402\/award\/([0-9a-f]{12})$/);
    if (awardMatch && req.method === 'GET') return paidAward(req, url, env, awardMatch[1]);
    if (url.pathname === '/x402/riff' && req.method === 'GET') return paid(req, url, () => riff(url.searchParams.get('token'), url.searchParams.get('cat')), riffReq);
    if (url.pathname === '/x402/ledger' && req.method === 'GET') return paid(req, url, () => ledger(url.searchParams.get('address'), url.searchParams.get('days')));
    if (url.pathname === '/agents/cat1.json') return json(CAT1_CARD);
    if (url.pathname === '/agents/njc.json') return json(NJC_CARD());
    if (url.pathname === '/credit-file' || url.pathname === '/.well-known/agent-credit-file.json') {
      const agent = url.pathname === '/credit-file' ? url.searchParams.get('agent') : String(NJC_ID || 26221);
      try { return json(await creditFile(agent, {incomeRead: (a, d) => incomeRead(a, d)})); } catch (e) { return json({error: e.message}, 400); }
    }
    { const c = url.pathname.match(/^\/agents\/cat\/(\d+)(?:\.json)?$/); if (c) { if (c[1] === '1') return json(CAT1_CARD); try { return json(catCard(c[1], await catWallet(c[1]), url.origin)); } catch (e) { return json({error: e.message}, 404); } } }
    { const c = url.pathname.match(/^\/cat\/(\d+)$/); if (c && req.method === 'GET') { count(env, ctx, 'cat'); try { return await catPage(c[1], url); } catch (e) { return json({error: e.message}, 404); } } }
    if (url.pathname === '/city-ledger' && req.method === 'GET') {
      try { return json(await cityLedger()); } catch (e) { return json({error: e.message}, 502); }
    }
    if (['/book', '/book.json', '/chain', '/chain.json'].includes(url.pathname) && req.method === 'GET') { count(env, ctx, 'book'); try { return await bookPage(url); } catch (e) { return json({error: e.message}, 502); } }
    if (url.pathname === '/coin' && req.method === 'GET') { count(env, ctx, 'coin'); try { return await coinPage(url, env, ctx); } catch (e) { return json({error: e.message}, 400); } }
    if (url.pathname === '/stats' && env?.USAGE) { const out = {}; let cursor; do { const l = await env.USAGE.list({cursor}); for (const k of l.keys) if (!k.name.startsWith('desk:') && !k.name.startsWith('receipt:') && !k.name.startsWith('launches:')) out[k.name] = Number(await env.USAGE.get(k.name)); cursor = l.list_complete ? null : l.cursor; } while (cursor); return json(out); }
    { const r = url.pathname.match(/^\/receipt\/(0x[0-9a-fA-F]{64})$/); if (r && req.method === 'GET' && env?.USAGE) { const v = await env.USAGE.get('receipt:' + r[1].toLowerCase());
      return v ? new Response(v, {headers: {'content-type': 'application/json', 'access-control-allow-origin': '*'}}) : json({error: 'no receipt with that hash'}, 404); } }
    // BatchDesk delivery road: each delivered item's work lands here as JSON the minute it prints; deliver() commits keccak256 of
    // the same bytes on the desk (0xdce6…e952), so the buyer's desk can fetch, hash, compare and release without reading X.
    { const d = url.pathname.match(/^\/desk\/(0x[0-9a-fA-F]{64})(?:\/(0x[0-9a-fA-F]{64}))?$/); if (d && req.method === 'GET' && env?.USAGE) {
      count(env, ctx, 'desk'); const pre = `desk:${d[1].toLowerCase()}:`;
      if (d[2]) { const v = await env.USAGE.get(pre + d[2].toLowerCase()); return v ? new Response(v, {headers: {'content-type': 'application/json', 'access-control-allow-origin': '*'}}) : json({error: 'not delivered yet'}, 404); }
      const items = []; let cursor; do { const l = await env.USAGE.list({prefix: pre, cursor}); for (const k of l.keys) items.push({item: k.name.slice(pre.length), ...(k.metadata || {}), url: url.origin + url.pathname.replace(/\/$/, '') + '/' + k.name.slice(pre.length)}); cursor = l.list_complete ? null : l.cursor; } while (cursor);
      return json({desk: d[1].toLowerCase(), contract: '0xdce6db1f24137f85b3f70f52bb41666f8911e952', chainId: CHAIN_ID, delivered: items.length, items, check: 'keccak256 of each item URL\'s exact bytes equals the workHash deliver() committed on the desk'}); } }
    if (url.pathname === '/control' && req.method === 'GET') {
      const key = new Request('https://control.cache/' + (url.searchParams.get('agentId') || '')), cache = caches.default, hit = await cache.match(key);
      if (hit) return hit;
      try { const r = json(await control(url.searchParams.get('agentId'))); r.headers.set('cache-control', 'public, max-age=600'); await cache.put(key, r.clone()); return r; } catch (e) { return json({error: e.message}, 400); }
    }
    if (url.pathname === '/x402/money-trail' && req.method === 'GET') return paid(req, url, () => TRAILS[(url.searchParams.get('token') || '').toLowerCase()] ?? moneyTrail(url.searchParams.get('token')), trailReq);
    if (url.pathname === '/launches' && req.method === 'GET') { count(env, ctx, 'launches'); return await launchBoard(env, url); }
    if (url.pathname === '/jobs' && req.method === 'GET') { count(env, ctx, 'jobs'); return await jobsBoard(env, url); }
    if (url.pathname.startsWith('/jobs/') && req.method === 'GET') { const h = jobPage(url.pathname.slice(6)); return h || json({error: 'No such job.'}, 404); }
    if (url.pathname === '/buy' && req.method === 'GET') { count(env, ctx, 'buy'); return new Response(buyPage(url), {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}}); }
    if (url.pathname === '/portfolio-watch' && req.method === 'GET') { count(env, ctx, 'portfolio-watch'); try { return json(await portfolioWatch(url.searchParams.get('address'))); } catch (e) { return json({error: e.message}, 400); } }
    if (url.pathname === '/contract-changes' && req.method === 'GET') { count(env, ctx, 'contract-changes'); try { return json(await contractChanges(url.searchParams.get('contract'))); } catch (e) { return json({error: e.message}, 400); } }
    if (url.pathname === '/openapi.json' && req.method === 'GET') return json(openapi(url.origin));
    if (url.pathname === '/llms.txt' && req.method === 'GET') { count(env, ctx, 'llms'); return new Response(llmsTxt(url.origin), {headers: {'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=600'}}); }
    if ((url.pathname === '/.well-known/agent-card.json' || url.pathname === '/.well-known/agent.json' || url.pathname === '/agent.json') && req.method === 'GET') { count(env, ctx, 'agent-card'); return json(agentCard(url.origin)); }
    if (url.pathname === '/.well-known/x402' && req.method === 'GET') return json({x402Version: 2, provider: 'New Jazz City (JazzCats)', mcp: url.origin + '/mcp', book: url.origin + '/book.json',
      resources: [['/x402/full-check?address={address}', '2.7'], ['/x402/money-trail?token={token}', '0.9'], ['/x402/base-verdict?token={token}', '0.03'], ['/x402/line-read?agentId={agentId}&vault={vault}&wallet={wallet}', '0.9'], ['/x402/transfer-read?contract={contract}', '1.8'], ['/x402/tba-read?account={account}&chain={chain}', '1.8'], ['/x402/poison-check?address={address}', '0.9'], ['/x402/income-read?agent={agent}&days={days}', '0.9'], ['/x402/halt-check?symbol={symbol}', '0.25'], ['/x402/base-trail?token={token}', '0.9'], ['/x402/sol-trail?mint={mint}', '0.9'], ['/x402/ledger?address={address}&days={days}', '0.05']].map(([r, usd]) => ({resource: url.origin + r, priceUsd: usd,
        accepts: [{network: 'eip155:4663', asset: 'USDG', payTo: CITY_WALLET || CAT1_WALLET}, {network: 'eip155:8453', asset: 'USDC', payTo: 'Cat holder'}], perCat: url.origin + r.split('?')[0] + '?cat={catId}'})),
      quote: url.origin + '/quote?token={token}&usd={usd}&chain=robinhood'});
    if (url.pathname === '/quote' && req.method === 'GET') { count(env, ctx, 'quote'); try { return json(await coinQuote(url.searchParams.get('token'), Number(url.searchParams.get('usd')), url.searchParams.get('chain') || 'robinhood')); } catch (e) { return json({error: e.message}, 400); } }
    if (url.pathname === '/x402/base-verdict' && req.method === 'GET') return paid(req, url, () => baseVerdict(url.searchParams.get('token'), url.origin), baseVerdictReq);
    if (url.pathname === '/x402/base-trail' && req.method === 'GET') return paid(req, url, () => baseTrail(url.searchParams.get('token')), baseTrailReq);
    if (url.pathname === '/x402/sol-trail' && req.method === 'GET') return paid(req, url, () => solTrail(url.searchParams.get('mint')), solTrailReq);
    if (url.pathname === '/x402/transfer-read' && req.method === 'GET') return paid(req, url, () => transferRead(url.searchParams.get('contract')), transferReq);
    if (url.pathname === '/x402/income-read' && req.method === 'GET') return paid(req, url, () => incomeRead(url.searchParams.get('agent'), url.searchParams.get('days')), incomeReq);
    if (url.pathname === '/x402/poison-check' && req.method === 'GET') return paid(req, url, () => poisonCheck(url.searchParams.get('address')), poisonReq);
    if (url.pathname === '/x402/full-check' && req.method === 'GET') return paid(req, url, () => fullCheck(url.searchParams.get('address')), fullReq);
    if (url.pathname === '/x402/tba-read' && req.method === 'GET') return paid(req, url, () => tbaRead(url.searchParams.get('account'), url.searchParams.get('chain')), tbaReq);
    if (url.pathname === '/desk/bank-of-me' && req.method === 'GET') { count(env, ctx, 'desk:bank-of-me'); try { return await bankOfMeDesk(); } catch (e) { return json({error: e.message}, 502); } }
    if (url.pathname === '/desk/submission-office' && req.method === 'GET') { count(env, ctx, 'desk:submission-office'); try { return await submissionOfficeDesk(); } catch (e) { return json({error: e.message}, 502); } }
    if (url.pathname === '/halt-check/status' && req.method === 'GET') { try { const r = await haltCheck('AAPL'); return json({listsRead: r.listsRead, oracleRead: !!r.oracle, checkedAt: r.checkedAt}); } catch (e) { return json({error: e.message}, 502); } }
    { const m = url.pathname.match(/^\/raeto\/([a-z_]+)$/); if (m && req.method === 'POST') { count(env, ctx, 'raeto:' + m[1]); return raetoTool(req, env, m[1], url.origin); } }
    if (url.pathname === '/x402/halt-check' && req.method === 'GET') return paid(req, url, () => haltCheck(url.searchParams.get('symbol')), haltReq);
    if (url.pathname === '/x402/line-read' && req.method === 'GET') return paid(req, url, () => lineRead(url.searchParams.get('agentId'), url.searchParams.get('vault'), url.searchParams.get('wallet')), lineReq);
    if (url.pathname !== '/mcp' || req.method !== 'POST') return json({error: 'POST /mcp (MCP JSON-RPC), GET /?tx=0x… (free), or GET /x402/ledger?address=0x… (0.05 USDG via x402)'}, 404);
    const m = await req.json().catch(() => null); if (!m) return json({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}}, 400);
    if (m.id === undefined) return new Response(null, {status: 202});
    const ok = result => json({jsonrpc: '2.0', id: m.id, result});
    if (m.method === 'initialize') return ok({protocolVersion: m.params?.protocolVersion ?? '2025-03-26', capabilities: {tools: {}}, serverInfo: {name: 'rh-tx-explain (JazzCat #1, New Jazz City)', version: '0.2.0'}});
    if (m.method === 'tools/list') return ok({tools: [TOOL, CONTROL_TOOL, JOBS_TOOL, ...CITY_JOB_TOOLS, ...(JAZZ_TOKEN ? [BUY_JAZZ] : []), ...QHOOKS_TOOLS, ...PAID_TOOLS.map(t => marketLink(t.route) ? {...t, description: `${t.description} Canonical checkout: ${marketLink(t.route)} (agents4663, refund if the read fails).`} : t)]});
    if (m.method === 'tools/call' && m.params?.name === BUY_JAZZ.name) {
      const a = m.params.arguments || {}; count(env, ctx, 'mcp-buy_jazz');
      if (!JAZZ_TOKEN) return ok({content: [{type: 'text', text: '$JAZZ is not live yet.'}], isError: true});
      const usdg = Number(a.usdg);
      if (!(usdg > 0)) return ok({content: [{type: 'text', text: 'usdg is the USDG to spend, e.g. "5".'}], isError: true});
      return ok(await qhooksCall('prepare_trade', {chain: '4663', token: JAZZ_TOKEN, side: 'buy', amountIn: String(Math.round(usdg * 1e6)), trader: a.trader,
        ...(a.slippageBps != null ? {slippageBps: a.slippageBps} : {}), referrer: CITY_WALLET || NJC_TREASURY}));
    }
    if (m.method === 'tools/call' && QHOOKS_TOOLS.some(t => t.name === m.params?.name)) {
      const a = m.params.arguments || {}, referrer = CITY_WALLET || NJC_TREASURY; count(env, ctx, 'mcp-' + m.params.name);
      const res = m.params.name === 'qhooks_trade'
        ? await qhooksCall('prepare_trade', {chain: String(a.chain || '4663'), token: a.token, side: a.side, amountIn: String(a.amountIn || ''), trader: a.trader, ...(a.slippageBps != null ? {slippageBps: a.slippageBps} : {}), referrer})
        : await qhooksCall('prepare_launch', {chain: String(a.chain || '4663'), name: a.name, ticker: a.ticker, ...(a.style ? {style: a.style} : {}), referrer});
      return ok(res);
    }
    if (m.method === 'tools/call' && m.params?.name === JOBS_TOOL.name) {
      const b = JSON.parse((await env.USAGE.get('jobs:board')) || '{"jobs":[]}'), f = String(m.params.arguments?.board || '').toLowerCase();
      const all = [...await cityOpenJobs(), ...b.jobs], jobs = f ? all.filter(j => j.board.toLowerCase().includes(f)) : all; count(env, ctx, 'mcp-jobs');
      return ok({content: [{type: 'text', text: jobs.map(j => `${j.board} | ${j.title} | ${j.pay} | ${j.url}`).join('\n') || 'No open jobs right now.'}], structuredContent: {at: b.at, count: jobs.length, jobs}});
    }
    if (m.method === 'tools/call' && CITY_JOB_TOOLS.some(t => t.name === m.params?.name)) {
      const r = await cityJobTool(m.params.name, m.params.arguments); count(env, ctx, 'mcp-' + m.params.name);
      return ok({content: [{type: 'text', text: JSON.stringify(r)}], structuredContent: r, ...(r.error ? {isError: true} : {})});
    }
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
      const pay = {url: `${url.origin}/x402/${pt.route}?${q}`, price: pt.price + ' USDG', payTo, rail: 'x402: USDG on Robinhood Chain ("robinhood" / eip155:4663, settled by facilitator.priors.trade, x402.t0ll.xyz as fallback) or USDC on Base ("base" / eip155:8453, paid to the Cat holder, settled by facilitator.payai.network)', seller: 'JazzCat #' + cat};
      // x402 in-band over MCP: a client with a wallet sends the signed payment in _meta and gets the read in the same call
      const run = PAID_RUN[pt.route], payment = m.params._meta?.['x402/payment'];
      if (payment && run) {
        const hdr = typeof payment === 'string' ? payment : b64(payment), u = new URL(pay.url);
        const r = await paid(new Request(pay.url, {headers: {'x-payment': hdr}}), u, () => run[0](u.searchParams), run[1]);
        const j = await r.json().catch(() => ({error: 'bad answer'}));
        return ok({content: [{type: 'text', text: JSON.stringify(j)}], structuredContent: j, isError: r.status !== 200, _meta: r.status === 200 ? {'x402/payment-response': j.payment || null} : {'x402/payment-required': {x402Version: 1, error: j.error, accepts: j.accepts}}});
      }
      const accepts = run ? [run[1](pay.url)] : [];
      return ok({content: [{type: 'text', text: `Paid read, ${pay.price} to JazzCat #${cat}'s wallet ${payTo}. Pay in this call: send the x402 payment (base64 X-PAYMENT payload, or the object) in _meta["x402/payment"] and call again. Or GET ${pay.url} and answer the 402. A failed read is never charged.`}],
        structuredContent: {paymentRequired: pay, accepts}, _meta: {'x402/payment-required': {x402Version: 1, accepts}}});
    }
    return json({jsonrpc: '2.0', id: m.id, error: {code: -32601, message: 'Method not found'}});
  },
  // New Jazz City's round for every enrolled Cat (city.mjs), on the worker's cron.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cityRound(env, {run: PAID_RUN, catWallet}));
  },
};
export {PAID_RUN, catWallet};
