// Agent-wallet handover read: an ERC-6551 (Tokenbound V3) account on Base or Robinhood Chain, read before you accept or
// spend from it. Three answers from the chain: who owns it now (the holder of the NFT it is bound to), which callers
// still hold a permission (live under the current owner, or dormant under a past owner and back if the NFT returns),
// and the lock and selector overrides. Reads the chain only.
const RPCS = {base: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.llamarpc.com'], robinhood: ['https://rpc.mainnet.chain.robinhood.com']};
const CHAIN_ID = {base: 8453, robinhood: 4663};
const PERM = '0x394777a58092892d136a90c4bb7e4350c72ac50fba6a0208128677f36527dcf5', OVR = '0x2c722487e90aca38ec1b074c3403210bd2bfb769b4da7f12f7bf0b9e37517c18', LOCK = '0xa7b24c66dd3269a292a60b3facdbb8f3e7557d1e19e64d99e0d6ee7250be63ad';
const ZERO = '0x0000000000000000000000000000000000000000';
const word = (h, i) => h.slice(2 + i * 64, 2 + (i + 1) * 64), addr = w => '0x' + w.slice(24).toLowerCase(), pad = a => a.toLowerCase().slice(2).padStart(64, '0');
async function rpc(chain, calls) {
  if (!calls.length) return [];
  const urls = RPCS[chain];
  for (let i = 0; i < 9; i++) {
    try {
      const r = await fetch(urls[i % urls.length], {method: 'POST', headers: {'content-type': 'application/json', 'user-agent': 'njc-tx-explain/1'}, body: JSON.stringify(calls.map(([method, params], id) => ({jsonrpc: '2.0', id, method, params})))});
      const j = await r.json(); if (!Array.isArray(j)) throw new Error('bad'); const out = []; for (const x of j) out[x.id] = x.error ? null : x.result; return out;
    } catch { await new Promise(res => setTimeout(res, 300 * (i + 1))); }
  }
  throw new Error('Chain RPC unavailable right now; nothing was charged.');
}
const call = (to, data) => ['eth_call', [{to, data}, 'latest']];
export async function tbaRead(account, chain = 'base') {
  if (!/^0x[0-9a-fA-F]{40}$/.test(account || '')) throw new Error('account (the 6551 wallet address, 0x…) is required.');
  chain = /^(rh|robinhood|4663)$/i.test(chain || '') ? 'robinhood' : /^(base|8453)?$/i.test(chain || '') ? 'base' : null;
  if (!chain) throw new Error('chain must be base or robinhood.');
  const a = account.toLowerCase();
  const [code, tok, own, state, until, locked, head] = await rpc(chain, [['eth_getCode', [a, 'latest']], call(a, '0xfc0c546a'), call(a, '0x8da5cb5b'), call(a, '0xc19d93fb'), call(a, '0xce0617ec'), call(a, '0xa4e2d634'), ['eth_blockNumber', []]]);
  if (!code || code === '0x') throw new Error(`No contract at ${account} on ${chain}: not a deployed 6551 wallet; nothing was charged.`);
  if (!tok || tok.length < 2 + 64 * 3) throw new Error('This contract has no token(): not an ERC-6551 account; nothing was charged.');
  const nft = {chainId: Number(BigInt('0x' + word(tok, 0))), contract: addr(word(tok, 1)), tokenId: BigInt('0x' + word(tok, 2)).toString()};
  const owner = own && own.length >= 66 ? addr(own.slice(2)) : null;
  const [ownerCode] = owner ? await rpc(chain, [['eth_getCode', [owner, 'latest']]]) : [null];
  const ownerKind = !owner ? null : ownerCode && ownerCode.startsWith('0xef0100') ? 'wallet (EIP-7702 delegated)' : ownerCode && ownerCode !== '0x' ? 'contract' : 'wallet';
  // permission, override and lock history: logs on the account itself, walked back from now
  const latest = BigInt(head), step = chain === 'base' ? 50000n : 9000000n, maxWin = chain === 'base' ? 30 : 14;
  const logs = []; let to = latest, wins = 0, reachedStart = false;
  while (wins < maxWin) {
    const from = to > step ? to - step + 1n : 0n; wins++;
    const [w] = await rpc(chain, [['eth_getLogs', [{address: a, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [[PERM, OVR, LOCK]]}]]]);
    if (w) logs.unshift(...w);
    if (from === 0n) { reachedStart = true; break; }
    to = from - 1n;
  }
  const covered = {fromBlock: reachedStart ? 0 : Number(to + 1n), toBlock: Number(latest), complete: reachedStart};
  const pairs = new Map(), ovr = new Map(); const lockEvents = [];
  for (const l of logs) {
    const t = l.topics[0], d = l.data, hasIdx = l.topics.length > 1;
    if (t === PERM) { const o = hasIdx ? addr(l.topics[1].slice(2)) : addr(word(d, 0)), c = hasIdx ? addr(l.topics[2].slice(2)) : addr(word(d, 1)); pairs.set(o + c, {grantedBy: o, caller: c, lastSetBlock: Number(BigInt(l.blockNumber)), tx: l.transactionHash}); }
    else if (t === OVR) { const o = addr(word(d, 0)), sel = '0x' + word(d, 1).slice(0, 8); ovr.set(o + sel, {setBy: o, selector: sel, lastSetBlock: Number(BigInt(l.blockNumber)), tx: l.transactionHash}); }
    else if (t === LOCK) lockEvents.push({lockedUntil: Number(BigInt(d)), block: Number(BigInt(l.blockNumber)), tx: l.transactionHash});
  }
  const P = [...pairs.values()], O = [...ovr.values()];
  const now = await rpc(chain, [...P.map(p => call(a, '0x1f9838b5' + pad(p.grantedBy) + pad(p.caller))), ...O.map(o => call(a, '0xee9c6054' + pad(o.setBy) + o.selector.slice(2).padEnd(64, '0')))]);
  const callers = P.map((p, i) => ({...p, on: !!now[i] && BigInt(now[i]) === 1n})).filter(p => p.on).map(p => ({caller: p.caller, grantedBy: p.grantedBy,
    status: p.grantedBy === owner ? 'LIVE: can act for the wallet now' : 'dormant: comes back if the NFT returns to ' + p.grantedBy, lastSetBlock: p.lastSetBlock, tx: p.tx}));
  const overrides = O.map((o, i) => ({...o, implementation: now[P.length + i] && now[P.length + i].length >= 66 ? addr(now[P.length + i].slice(2)) : ZERO})).filter(o => o.implementation !== ZERO)
    .map(o => ({selector: o.selector, implementation: o.implementation, setBy: o.setBy, status: o.setBy === owner ? 'LIVE' : 'dormant (past owner)', lastSetBlock: o.lastSetBlock, tx: o.tx}));
  const lockedUntil = until ? Number(BigInt(until)) : null, isLocked = locked ? BigInt(locked) === 1n : null;
  const live = callers.filter(c => c.status.startsWith('LIVE')), liveO = overrides.filter(o => o.status === 'LIVE'), dormant = callers.length - live.length + overrides.length - liveO.length;
  const flags = [];
  if (live.length) flags.push(`${live.length} caller(s) can act for this wallet under the current owner`);
  if (liveO.length) flags.push(`${liveO.length} function override(s) set by the current owner`);
  if (dormant) flags.push(`${dormant} permission(s)/override(s) from a past owner, dormant; they come back if the NFT returns to that owner`);
  if (isLocked) flags.push(`locked until ${new Date(lockedUntil * 1000).toISOString()}: the owner cannot move assets or change settings before then`);
  if (nft.chainId !== CHAIN_ID[chain]) flags.push(`bound to an NFT on chain ${nft.chainId}, not ${chain}: ownership resolves there`);
  if (!covered.complete) flags.push(`history read back to block ${covered.fromBlock}; older settings are not in this read`);
  return {chain, chainId: CHAIN_ID[chain], account: a, nft, owner, ownerKind, state: state ? BigInt(state).toString() : null, isLocked, lockedUntil,
    callers, overrides, lockHistory: lockEvents, coverage: covered,
    verdict: live.length || liveO.length ? 'not clean: someone besides the owner can act' : isLocked ? 'clean but locked' : 'clean: only the NFT holder can act',
    flags, by: `JazzCat #1 (agent #26063), New Jazz City: read from ${chain === 'base' ? 'Base' : 'Robinhood Chain'}`};
}
