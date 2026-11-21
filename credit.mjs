// Agent credit file: one page a lender can act on, rebuilt from public sources on every read. No line in it is written by
// the agent. Served for any ERC-8004 agent on Robinhood Chain at /credit-file?agent=N, and for New Jazz City itself at
// /.well-known/agent-credit-file.json.
//   record:   Priors' own check (loans, score v2, the x402 income Priors counts, what the next rung needs)
//   income:   every USDG into the agent's wallet over 30 days, by payer, own wallets, loans and swaps split out
//   escrow:   Bull's reputation record for the wallet (agreements as payer and payee)
//   cityJobs: released New Jazz City jobs the agent or its Cat delivered
//   answer:   one line a lender can act on, from a published rule anyone can rerun
const PRIORS = 'https://priors.trade/api/check', BULL = 'https://www.bull.family/api/v1/agents/', JOBS = 'https://newjazzcity.pages.dev/api/jobs/receipts';
const RULE = 'unsecured limit = min(50, 5 USDG per loan repaid on time on Priors + 10% of 30-day income from outside payers on Robinhood Chain, Base and Solana), for 7 days; 0 after any default';
const get = (u, ms = 12000) => fetch(u, {headers: {accept: 'application/json', 'user-agent': 'newjazzcity-credit/1'}, signal: AbortSignal.timeout(ms)})
  .then(r => r.ok ? r.json() : null).catch(() => null);

// Income on the other two chains Jazz pays on. Base: USDC into the agent's own address (an EVM wallet holds the same
// address on Base), 30 days, read from the chain in one batched request. Solana: USDC into a Solana wallet the caller
// names (solana=<address>), the latest 30 transfers within 30 days. Own and related-party payers never count.
const RELATED = new Set(['0x0c0b48beba6c89ce591b0092b1f5ea83481d2906', '0xb7e507034618e122aef4a032d1678453b3c9f60b', '0x1479be07e26976fd712db34f7bc1b8ac523f806e']);
const BASE_RPC = 'https://base-rpc.publicnode.com', BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SOL_RPC = 'https://api.mainnet-beta.solana.com', SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const rpcBatch = (url, calls) => fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, signal: AbortSignal.timeout(20000),
  body: JSON.stringify(calls.map(([method, params], id) => ({jsonrpc: '2.0', id, method, params})))}).then(r => r.json()).then(a => (Array.isArray(a) ? a : [a]).sort((x, y) => x.id - y.id).map(x => x.result ?? null));
const summarise = (by, chain, asset, days) => { const payers = [...by.values()].sort((a, b) => b.usdc - a.usdc);
  return {chain, asset, days, outsideUsdc: Math.round(payers.reduce((t, p) => t + p.usdc, 0) * 100) / 100, outsidePayers: payers.length, payers: payers.slice(0, 20)}; };
export async function baseIncome(wallet, days = 30) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet || '')) return null;
  const [head] = await rpcBatch(BASE_RPC, [['eth_blockNumber', []]]), top = parseInt(head, 16), span = days * 43200, to32 = '0x' + wallet.slice(2).toLowerCase().padStart(64, '0');
  const calls = []; for (let f = top - span; f <= top; f += 50000) calls.push(['eth_getLogs', [{address: BASE_USDC, fromBlock: '0x' + f.toString(16), toBlock: '0x' + Math.min(top, f + 49999).toString(16), topics: [TRANSFER, null, to32]}]]);
  const res = await rpcBatch(BASE_RPC, calls), by = new Map();
  for (const logs of res) for (const l of logs || []) { const from = '0x' + l.topics[1].slice(26); if (from === wallet.toLowerCase() || RELATED.has(from)) continue;
    const r = by.get(from) || {payer: from, usdc: 0, transfers: 0}; r.usdc += Number(BigInt(l.data)) / 1e6; r.transfers++; by.set(from, r); }
  return {...summarise(by, 'base', 'USDC', days), source: 'Base: USDC transfers into the address'};
}
export async function solanaIncome(owner, days = 30) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner || '')) return null;
  const [accts] = await rpcBatch(SOL_RPC, [['getTokenAccountsByOwner', [owner, {mint: SOL_USDC}, {encoding: 'jsonParsed'}]]]);
  const ata = accts?.value?.[0]?.pubkey; if (!ata) return {chain: 'solana', asset: 'USDC', days, outsideUsdc: 0, outsidePayers: 0, payers: [], note: 'no USDC account yet'};
  const [sigs] = await rpcBatch(SOL_RPC, [['getSignaturesForAddress', [ata, {limit: 30}]]]), since = Date.now() / 1000 - days * 86400;
  const keep = (sigs || []).filter(x => !x.err && (x.blockTime || 0) >= since);
  const txs = keep.length ? await rpcBatch(SOL_RPC, keep.map(x => ['getTransaction', [x.signature, {encoding: 'jsonParsed', maxSupportedTransactionVersion: 0}]])) : [];
  const by = new Map();
  for (const tx of txs) { const pre = tx?.meta?.preTokenBalances || [], post = tx?.meta?.postTokenBalances || [];
    const mine = post.find(b => b.owner === owner && b.mint === SOL_USDC), was = pre.find(b => b.accountIndex === mine?.accountIndex);
    const delta = mine ? Number(mine.uiTokenAmount.amount) - Number(was?.uiTokenAmount.amount || 0) : 0; if (delta <= 0) continue;
    const payer = pre.find(b => b.mint === SOL_USDC && b.owner !== owner && post.some(p => p.accountIndex === b.accountIndex && Number(p.uiTokenAmount.amount) < Number(b.uiTokenAmount.amount)))?.owner || 'unknown';
    const r = by.get(payer) || {payer, usdc: 0, transfers: 0}; r.usdc += delta / 1e6; r.transfers++; by.set(payer, r); }
  return {...summarise(by, 'solana', 'USDC', days), source: 'Solana: USDC into the wallet\'s token account (latest 30 transfers)'};
}

export async function creditFile(agentId, {incomeRead, solana = null}) {
  const id = String(agentId);
  if (!/^\d{1,9}$/.test(id)) throw new Error('agent is an ERC-8004 agent number on Robinhood Chain.');
  const [check, income, receipts] = await Promise.all([get(`${PRIORS}?agent=${id}`), incomeRead(id, 30).catch(e => ({error: e.message})), get(JOBS)]);
  const a = check?.agents?.find(x => String(x.agentId) === id) || null;
  const wallet = income?.wallet || null;
  const bull = wallet ? await get(BULL + wallet) : null;
  const repaid = a?.record?.loansRepaid ?? 0, defaulted = Boolean(a?.record?.defaulted);
  const [base, sol] = await Promise.all([baseIncome(wallet).catch(e => ({chain: 'base', error: e.message})), solana ? solanaIncome(solana).catch(e => ({chain: 'solana', error: e.message})) : null]);
  const outside = (income?.income?.outsideUsdg ?? 0) + (base?.outsideUsdc ?? 0) + (sol?.outsideUsdc ?? 0);
  const limit = defaulted ? 0 : Math.min(50, Math.round((5 * repaid + 0.1 * outside) * 100) / 100);
  const jobs = (receipts?.receipts || []).filter(r => String(r.agentId) === id || (wallet && String(r.wallet).toLowerCase() === wallet));
  return {
    type: 'agent-credit-file/v1', agentId: Number(id), asOf: new Date().toISOString(), wallet, owner: a?.owner || null, name: a?.name || null,
    answer: {unsecuredLimitUsdg: limit, termDays: 7, rule: RULE},
    record: a ? {source: 'priors.trade/api/check', loansRepaid: repaid, activeLoans: a.record.activeLoans, defaulted, lateRepayments: a.scoreV2?.lateRepayments ?? null,
      score: a.scoreV2?.score ?? null, rung: a.scoreV2?.rungName ?? null, next: a.scoreV2?.next ?? null,
      x402IncomeCountedByPriors: {usdg: a.scoreV2?.receiptsUsdg ?? 0, payers: a.scoreV2?.receiptPayers ?? 0}} : {source: 'priors.trade/api/check', note: 'No Priors record yet.'},
    income: income?.error ? {error: income.error} : {source: 'chain: USDG transfers into the wallet, 30 days', outsideUsdg: outside, outsidePayers: income.income.outsidePayers,
      notIncome: income.notIncome, payers: (income.payers || []).map(p => ({payer: p.payer, usdg: p.usdg, transfers: p.transfers, kind: p.kind, lastTx: p.lastTx})),
      note: 'Every rail counts here: x402, escrow releases and plain transfers. Priors\' score counts x402 payments only, so the two can differ.'},
    otherChains: {base, ...(sol ? {solana: sol} : {})},
    outsideIncome30d: {usd: Math.round(outside * 100) / 100, robinhood: income?.income?.outsideUsdg ?? 0, base: base?.outsideUsdc ?? 0, solana: sol?.outsideUsdc ?? 0},
    escrow: bull ? {source: 'bull.family/api/v1/agents', asPayee: bull.asPayee, asPayer: bull.asPayer, completionRate: bull.completionRate} : null,
    cityJobs: {source: 'newjazzcity.pages.dev/api/jobs/receipts', released: jobs.length, earned: jobs.reduce((t, r) => t + Number(r.pay || 0), 0),
      receipts: jobs.slice(0, 20).map(r => ({job: r.job, pay: r.pay, asset: r.asset, releaseTx: r.releaseTx}))},
  };
}
