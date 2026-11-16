// Robinhood Chain transaction explainer: give it a transaction hash, get a short plain-language summary of what happened.
// Read-only. No keys, no model calls: every sentence is built from the chain's own transaction, receipt and logs.
// MCP (streamable HTTP, JSON-RPC) at POST /mcp with one tool, explain_transaction. Humans: GET /?tx=0x...
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
async function rpcBatch(calls) {
  for (let i = 0; ; i++) {
    const RPC = RPCS[i % RPCS.length];
    const r = await fetch(RPC, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(calls.map(([method, params], id) => ({jsonrpc: '2.0', id, method, params})))});
    if (r.status === 429 && i < 7) { await new Promise(res => setTimeout(res, 150 * (i + 1))); continue; }
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

const TOOL = {name: 'explain_transaction', title: 'Explain a Robinhood Chain transaction',
  description: 'Takes a Robinhood Chain (chain 4663) transaction hash and returns a short plain-language summary of what happened: swaps, token and NFT transfers, mints, burns, approvals (flags unlimited ones), contract deployments, failures and the fee. Read-only; built from the chain\'s own data, no model in the loop.',
  inputSchema: {type: 'object', properties: {hash: {type: 'string', description: '0x-prefixed transaction hash'}}, required: ['hash']}};
const json = (o, s = 200) => new Response(JSON.stringify(o), {status: s, headers: {'content-type': 'application/json', 'access-control-allow-origin': '*'}});

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, {headers: {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST'}});
    if (req.method === 'GET' && url.pathname === '/') {
      const tx = url.searchParams.get('tx');
      if (tx) { try { return json(await explain(tx)); } catch (e) { return json({error: e.message}, 400); } }
      return json({name: 'Robinhood Chain transaction explainer', by: 'JazzCat #1, New Jazz City (newjazzcity.pages.dev)', mcp: url.origin + '/mcp', try: url.origin + '/?tx=0x…', tool: TOOL.name, readOnly: true});
    }
    if (url.pathname !== '/mcp' || req.method !== 'POST') return json({error: 'POST /mcp (MCP JSON-RPC) or GET /?tx=0x…'}, 404);
    const m = await req.json().catch(() => null); if (!m) return json({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}}, 400);
    if (m.id === undefined) return new Response(null, {status: 202});
    const ok = result => json({jsonrpc: '2.0', id: m.id, result});
    if (m.method === 'initialize') return ok({protocolVersion: m.params?.protocolVersion ?? '2025-03-26', capabilities: {tools: {}}, serverInfo: {name: 'rh-tx-explain (JazzCat #1, New Jazz City)', version: '0.1.1'}});
    if (m.method === 'tools/list') return ok({tools: [TOOL]});
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/call' && m.params?.name === TOOL.name) {
      try { const r = await explain(m.params.arguments?.hash); return ok({content: [{type: 'text', text: r.summary + `\n${r.link}`}], structuredContent: r}); }
      catch (e) { return ok({content: [{type: 'text', text: e.message}], isError: true}); }
    }
    return json({jsonrpc: '2.0', id: m.id, error: {code: -32601, message: 'Method not found'}});
  },
};
