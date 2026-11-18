// Income list: every USDG payment into an agent's wallet, one line each, in a form anyone can rerun from Robinhood Chain:
// tx hash, block, token contract, payer, and the payer's funder two hops back (the first USDG into the payer, then the first
// into that funder). Payers that share a funder are grouped, so three payers from one wallet count as one customer.
// Tokens that only look like USDG (same symbol, other contract) are listed as filtered out, never counted.
// Usage: node income-list.mjs <wallet> [fromBlock]   prints JSON
const RPC = 'https://rpc.mainnet.chain.robinhood.com', USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', RELAY = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';
// Known non-income senders on Robinhood Chain: the Priors pool (loans) and DEX pool managers / routers (swap proceeds).
const KNOWN = {'0x281210097f0de7a8fb6f87310af0f089c9c8de21': 'loan', '0x8366a39cc670b4001a1121b8f6a443a643e40951': 'swap',
  '0xbdbae060cbab0e9cfe802a7513dd5ecb36cda6c3': 'swap', '0xe8852602f84e04e284286d8db01a41edd0ccefb0': 'swap', '0x8876789976decbfcbbbe364623c63652db8c0904': 'swap'};
const STEP = 100000n, pad = a => '0x' + a.toLowerCase().slice(2).padStart(64, '0'), addr = w => '0x' + w.slice(-40).toLowerCase();
async function rpc(method, params) {
  for (let i = 0; i < 3; i++) {
    try { const j = await (await fetch(RPC, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})})).json(); if (j.result !== undefined) return j.result; } catch {}
    await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error('RPC unavailable: ' + method);
}
// a window the node refuses (too many logs or too slow) is split in half until it answers
async function span(filter, s, e) {
  try { return await rpc('eth_getLogs', [{...filter, fromBlock: '0x' + s.toString(16), toBlock: '0x' + e.toString(16)}]); }
  catch (err) { if (e - s < 500n) throw err; const m = (s + e) / 2n; return [...await span(filter, s, m), ...await span(filter, m + 1n, e)]; }
}
async function logs(filter, from, to) {
  const out = [];
  for (let s = from; s <= to; s += STEP) out.push(...await span(filter, s, s + STEP - 1n < to ? s + STEP - 1n : to));
  return out;
}
// first USDG into a wallet, scanning forward from the chain's USDG era; null when it never received any
async function firstFunder(w, to, from = 100000000n) {
  for (let s = from; s <= to; s += STEP * 20n) {
    const e = s + STEP * 20n - 1n < to ? s + STEP * 20n - 1n : to;
    let l; try { l = await rpc('eth_getLogs', [{address: USDG, topics: [TRANSFER, null, pad(w)], fromBlock: '0x' + s.toString(16), toBlock: '0x' + e.toString(16)}]); }
    catch { l = await logs({address: USDG, topics: [TRANSFER, null, pad(w)]}, s, e); }
    if (l.length) { const f = addr(l[0].topics[1]); return {from: f === RELAY ? 'relay-bridge' : f, tx: l[0].transactionHash, block: Number(BigInt(l[0].blockNumber))}; }
  }
  return null;
}
const wallet = (process.argv[2] || '').toLowerCase(), latest = BigInt(await rpc('eth_blockNumber', []));
const from = BigInt(process.argv[3] || 115600000);
const inUsdg = await logs({address: USDG, topics: [TRANSFER, null, pad(wallet)]}, from, latest);
const inAny = await logs({topics: [TRANSFER, null, pad(wallet)]}, from, latest);
const filtered = [];
for (const l of inAny) if (l.address.toLowerCase() !== USDG && l.topics.length === 3) {
  const s = await rpc('eth_call', [{to: l.address, data: '0x95d89b41'}, 'latest']).catch(() => null);
  let sym = '?'; try { const b = s.slice(2), n = parseInt(b.slice(64, 128), 16); sym = Buffer.from(b.slice(128, 128 + n * 2), 'hex').toString(); } catch {}
  if (/usd/i.test(sym)) filtered.push({tx: l.transactionHash, token: l.address.toLowerCase(), symbol: sym, from: addr(l.topics[1]), why: 'look-alike: symbol reads ' + sym + ', contract is not USDG ' + USDG});
}
const funders = new Map(), hop = async w => { if (!funders.has(w)) funders.set(w, await firstFunder(w, latest)); return funders.get(w); };
const lines = [];
for (const l of inUsdg) {
  const payer = addr(l.topics[1]), f1 = await hop(payer), f2 = f1 && f1.from !== 'relay-bridge' ? await hop(f1.from) : null;
  lines.push({tx: l.transactionHash, block: Number(BigInt(l.blockNumber)), logIndex: Number(BigInt(l.logIndex)), token: USDG, usdg: Number(BigInt(l.data)) / 1e6, payer,
    funder1: f1 && {wallet: f1.from, tx: f1.tx}, funder2: f2 && {wallet: f2.from, tx: f2.tx}});
}
// a customer is the earliest independent wallet behind a payer: a contract payer (escrow, desk) resolves to whoever funded it
const root = x => x.funder1 && (x.funder1.wallet === 'relay-bridge' ? x.payer : x.funder1.wallet);
// Classify every line before counting customers: loans and swap proceeds are not income; a contract payer (jar, escrow,
// desk) resolves to whoever funded it, and if that is the agent itself it is the agent's own money coming back. A plain
// wallet the agent funded first is still outside income (pay for work flows back that way), flagged so a reader can check the work.
const codeOf = new Map(), isContract = async a => { if (!codeOf.has(a)) codeOf.set(a, (await rpc('eth_getCode', [a, 'latest'])) !== '0x'); return codeOf.get(a); };
for (const x of lines) {
  const k = KNOWN[x.payer], contract = await isContract(x.payer), who = contract ? root(x) || x.payer : x.payer;
  x.kind = k ? k : KNOWN[who] ? KNOWN[who] : who === wallet ? 'own' : 'outside';
  x.customer = x.kind === 'outside' ? who : null;
  if (x.kind === 'outside' && !contract && x.funder1?.wallet === wallet) x.flag = 'payer was first funded by this agent: count as outside only if that was pay for work';
}
const customers = new Map();
for (const x of lines.filter(x => x.kind === 'outside')) { const c = customers.get(x.customer) || {customer: x.customer, usdg: 0, payments: 0, payers: new Set()}; c.usdg += x.usdg; c.payments++; c.payers.add(x.payer); customers.set(x.customer, c); }
const total = Math.round(lines.reduce((s, x) => s + x.usdg, 0) * 1e6) / 1e6;
const sumKind = k => Math.round(lines.filter(x => x.kind === k).reduce((s, x) => s + x.usdg, 0) * 1e6) / 1e6;
console.log(JSON.stringify({schema: 'njc-income-list/v1', chainId: 4663, wallet, window: {fromBlock: Number(from), toBlock: Number(latest)}, usdgContract: USDG,
  total, payments: lines.length, income: {outside: sumKind('outside'), customers: customers.size}, notIncome: {own: sumKind('own'), loan: sumKind('loan'), swap: sumKind('swap')}, customers: [...customers.values()].map(c => ({...c, usdg: Math.round(c.usdg * 1e6) / 1e6, payers: [...c.payers]})).sort((a, b) => b.usdg - a.usdg),
  lines, filteredOut: filtered,
  rule: 'Every transfer of the USDG contract above into the wallet is listed. Not income: loans (Priors pool), swap proceeds (DEX pool managers and routers), and money from contracts the agent itself funded (its own jars, escrows and refunds). Outside income: everything else, grouped by customer; a contract payer (escrow or desk) counts as whoever funded it. A plain-wallet payer first funded by the agent stays outside, flagged for a work check. Look-alike tokens are listed, never counted.',
  rerun: 'eth_getLogs on the USDG contract, topic0 Transfer, topic2 = this wallet, over the window; funder = first USDG Transfer into each payer.'}, null, 1));
