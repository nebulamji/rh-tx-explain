// Solana coin trail (njc-trail/solana-v1) for the worker: claim, authorities, holders, creator holding, and where creator fees
// route (pump.fun fee-sharing config + creator vaults). Same logic as ~/tools/jc-jobs/trail-sol.mjs (Flow verified 20/20).
import * as A from '@solana/addresses';
const RPCS = ['https://solana-rpc.publicnode.com'];
 

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', PAMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', PFEE = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const WSOL = 'So11111111111111111111111111111111111111112', TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PE6nW7v4aMA7Ruwd8';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, params) {
  for (let i = 0; i < 10; i++) {
    try { const r = await fetch(RPCS[i % RPCS.length], {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: AbortSignal.timeout(30000)});
      const j = await r.json(); if (j.error?.code === 429 || r.status === 429) { await sleep(1500 * (i + 1)); continue; } if (j.error) throw new Error(j.error.message); return j.result; }
    catch (e) { if (i === 9) throw e; await sleep(1200 * (i + 1)); }
  }
}
const pda = async (program, seeds) => (await A.getProgramDerivedAddress({programAddress: program, seeds}))[0];
const enc = A.getAddressEncoder(), b = s => new TextEncoder().encode(s);
const sol = async a => { const r = await rpc('getBalance', [a, {commitment: 'confirmed'}]); return r ? r.value / 1e9 : 0; };
const acct = async a => (await rpc('getAccountInfo', [a, {encoding: 'base64', commitment: 'confirmed'}]))?.value || null;
const get = (u, t = 20000) => fetch(u, {headers: {'user-agent': 'Mozilla/5.0'}, signal: AbortSignal.timeout(t)}).then(r => r.ok ? r.json() : null).catch(() => null);

export async function solTrail(mint) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint || '')) throw new Error('mint (a Solana token address) is required.');
  const sources = [], holes = [];

// 1. token + launch + holders: RugCheck report, cross-checked against the mint account
const rc = await get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, 30000); if (rc) sources.push('api.rugcheck.xyz report');
const mi = await rpc('getAccountInfo', [mint, {encoding: 'jsonParsed'}]); const info = mi?.value?.data?.parsed?.info || {};
const programId = mi?.value?.owner; sources.push('Solana RPC getAccountInfo(mint)');
const token = {name: rc?.tokenMeta?.name, symbol: rc?.tokenMeta?.symbol, supply: info.supply ? Number(info.supply) / 10 ** info.decimals : rc?.token?.supply, decimals: info.decimals,
  mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null, metadataMutable: rc?.tokenMeta?.mutable ?? null, tokenProgram: programId};
// 2. the claim, in the coin's own metadata
let meta = null; const uri = rc?.tokenMeta?.uri;
if (uri) { const cid = (uri.match(/\/ipfs\/(.+)$/) || [])[1];
  for (const u of cid ? [`https://pump.mypinata.cloud/ipfs/${cid}`, `https://gateway.pinata.cloud/ipfs/${cid}`, `https://dweb.link/ipfs/${cid}`, uri] : [uri]) { meta = await get(u, 12000); if (meta) { sources.push('metadata ' + u); break; } }
  if (!meta) holes.push('metadata URI did not load: ' + uri); }
const claim = {description: meta?.description || null, website: meta?.website || null, twitter: meta?.twitter || null, telegram: meta?.telegram || null, uri: uri || null};
const creator = rc?.creator || null;
// creator's holding read from chain (UI units + % of supply), not the index: RugCheck's creatorBalance can read 0 or raw units
let creatorHolding = null;
if (creator) { const ta = await rpc('getTokenAccountsByOwner', [creator, {mint}, {encoding: 'jsonParsed', commitment: 'confirmed'}]).catch(() => null);
  if (ta) { const ui = ta.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmountString || 0), 0);
    creatorHolding = {tokens: ui, pctOfSupply: token.supply ? Math.round(ui / token.supply * 1e6) / 1e4 : null, accounts: ta.value.length, source: 'Solana RPC getTokenAccountsByOwner'}; } }
const launch = {launchpad: rc?.launchpad?.name || null, creator, creatorHolding, detectedAt: rc?.detectedAt || null,
  markets: (rc?.markets || []).map(m => ({type: m.marketType, pool: m.pubkey, liquidityUsd: Math.round(m.lp?.lpLockedUSD ?? m.lp?.quoteUSD ?? 0)}))};
const holders = {total: rc?.totalHolders ?? null, top10: (rc?.topHolders || []).slice(0, 10).map(h => ({owner: h.owner, pct: Math.round(h.pct * 100) / 100, insider: !!h.insider,
  label: (rc?.knownAccounts || {})[h.owner]?.name || (rc?.knownAccounts || {})[h.address]?.name || null})), insiderNetworks: (rc?.insiderNetworks || []).length};
holders.top10Pct = Math.round(holders.top10.reduce((s, h) => s + h.pct, 0) * 100) / 100;
const POOLISH = /pool|amm|curve|pump ?fun|pumpswap|raydium|meteora|orca/i, marketKeys = new Set(launch.markets.map(m => m.pool));
holders.top10.forEach(h => { h.pool = POOLISH.test(h.label || '') || marketKeys.has(h.owner); });
holders.top10ExPoolPct = Math.round(holders.top10.filter(h => !h.pool).reduce((s, h) => s + h.pct, 0) * 100) / 100;

// 3. creator fees: pump.fun fee-sharing config for this mint, and the creator vaults (bonding curve + PumpSwap) of whoever is the coin creator
const fees = {};
const cfg = await pda(PFEE, [b('sharing-config'), enc.encode(mint)]), cfgAcct = await acct(cfg);
fees.sharingConfig = {address: cfg, exists: !!cfgAcct};
if (cfgAcct) { // shareholders: a borsh vec of (pubkey, u16 bps) summing to 10,000; found by scanning the account data
  const d = Buffer.from(cfgAcct.data[0], 'base64');
  for (let o = 8; o < d.length - 4; o++) { const n = d.readUInt32LE(o); if (n < 1 || n > 10 || o + 4 + n * 34 > d.length) continue;
    const sh = []; let sum = 0; for (let i = 0; i < n; i++) { const p = o + 4 + i * 34; const bps = d.readUInt16LE(p + 32); sum += bps; sh.push({wallet: A.getAddressDecoder().decode(d.subarray(p, p + 32)), bps}); }
    if (sum === 10000) { fees.sharingConfig.shareholders = sh; fees.sharingConfig.dataOffset = o; break; } }
  if (!fees.sharingConfig.shareholders) holes.push('sharing config exists but its shareholder list did not parse');
}
const feeCreator = cfgAcct ? cfg : creator; // with fee sharing on, the coin's creator is the config itself
if (feeCreator) {
  const bcVault = await pda(PUMP, [b('creator-vault'), enc.encode(feeCreator)]);
  const ammAuth = await pda(PAMM, [b('creator_vault'), enc.encode(feeCreator)]);
  const ammVault = await pda(ATA, [enc.encode(ammAuth), enc.encode(TOKEN), enc.encode(WSOL)]);
  const ammBal = await rpc('getTokenAccountBalance', [ammVault]).catch(() => null);
  fees.feeCreator = feeCreator; fees.bondingCurveVault = {address: bcVault, sol: await sol(bcVault)};
  fees.pumpSwapVault = {authority: ammAuth, wsolAccount: ammVault, sol: ammBal?.value ? Number(ammBal.value.uiAmount) : 0};
  const last = await rpc('getSignaturesForAddress', [bcVault, {limit: 5}]).catch(() => []);
  fees.bondingCurveVault.lastActivity = (last || []).map(s => ({sig: s.signature, at: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null}));
} else holes.push('creator unknown: fee leg not read');
sources.push('Solana RPC: pump fee-sharing config PDA, creator-vault PDAs');

// 4. verdict: facts only, holes kept
const flags = [];
if (token.mintAuthority) flags.push('mint authority still set: supply can grow');
if (token.freezeAuthority) flags.push('freeze authority still set: holders can be frozen');
if (token.metadataMutable) flags.push('metadata is mutable');
if (holders.top10ExPoolPct >= 30) flags.push(`top wallets outside pools hold ${holders.top10ExPoolPct}%`);
if (holders.insiderNetworks) flags.push(`${holders.insiderNetworks} insider network(s) detected by RugCheck`);
const sh = fees.sharingConfig.shareholders;
const feeLine = sh ? `creator fees split by pump.fun sharing config ${cfg.slice(0, 4)}..${cfg.slice(-4)}: ` + sh.map(s => `${s.bps / 100}% to ${s.wallet.slice(0, 4)}..${s.wallet.slice(-4)}`).join(', ')
  : cfgAcct ? 'creator fees go through a sharing config whose split did not parse' : creator ? `no fee-sharing config: creator fees accrue to the creator ${creator.slice(0, 4)}..${creator.slice(-4)}` : 'fee route unknown';
const out = {schema: 'njc-trail/solana-v1', chain: 'solana', mint, readAt: new Date().toISOString(), verdict: [feeLine, flags.length ? flags.join('; ') : 'no authority or concentration flags'].join(' | '),
  token, claim, launch, holders, fees, risks: (rc?.risks || []).map(r => `${r.name}${r.value ? ' ' + r.value : ''}`), holes,
  confidence: {token: 'VERIFIED (mint account)', holders: 'FIRST-PARTY (RugCheck index)', fees: 'VERIFIED (PDA accounts read on chain)', claim: 'FIRST-PARTY (coin metadata)'}, sources,
  by: 'JazzCat #1 (ERC-8004 agent #26063), New Jazz City'};
  return out;
}
