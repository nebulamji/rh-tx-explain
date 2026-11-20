// Agent credit file: one page a lender can act on, rebuilt from public sources on every read. No line in it is written by
// the agent. Served for any ERC-8004 agent on Robinhood Chain at /credit-file?agent=N, and for New Jazz City itself at
// /.well-known/agent-credit-file.json.
//   record:   Priors' own check (loans, score v2, the x402 income Priors counts, what the next rung needs)
//   income:   every USDG into the agent's wallet over 30 days, by payer, own wallets, loans and swaps split out
//   escrow:   Bull's reputation record for the wallet (agreements as payer and payee)
//   cityJobs: released New Jazz City jobs the agent or its Cat delivered
//   answer:   one line a lender can act on, from a published rule anyone can rerun
const PRIORS = 'https://priors.trade/api/check', BULL = 'https://www.bull.family/api/v1/agents/', JOBS = 'https://newjazzcity.pages.dev/api/jobs/receipts';
const RULE = 'unsecured limit = min(50, 5 USDG per loan repaid on time on Priors + 10% of 30-day income from outside payers), for 7 days; 0 after any default';
const get = (u, ms = 12000) => fetch(u, {headers: {accept: 'application/json', 'user-agent': 'newjazzcity-credit/1'}, signal: AbortSignal.timeout(ms)})
  .then(r => r.ok ? r.json() : null).catch(() => null);

export async function creditFile(agentId, {incomeRead}) {
  const id = String(agentId);
  if (!/^\d{1,9}$/.test(id)) throw new Error('agent is an ERC-8004 agent number on Robinhood Chain.');
  const [check, income, receipts] = await Promise.all([get(`${PRIORS}?agent=${id}`), incomeRead(id, 30).catch(e => ({error: e.message})), get(JOBS)]);
  const a = check?.agents?.find(x => String(x.agentId) === id) || null;
  const wallet = income?.wallet || null;
  const bull = wallet ? await get(BULL + wallet) : null;
  const repaid = a?.record?.loansRepaid ?? 0, defaulted = Boolean(a?.record?.defaulted);
  const outside = income?.income?.outsideUsdg ?? 0;
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
    escrow: bull ? {source: 'bull.family/api/v1/agents', asPayee: bull.asPayee, asPayer: bull.asPayer, completionRate: bull.completionRate} : null,
    cityJobs: {source: 'newjazzcity.pages.dev/api/jobs/receipts', released: jobs.length, earned: jobs.reduce((t, r) => t + Number(r.pay || 0), 0),
      receipts: jobs.slice(0, 20).map(r => ({job: r.job, pay: r.pay, asset: r.asset, releaseTx: r.releaseTx}))},
  };
}
