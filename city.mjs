// New Jazz City's round: the done-for-you economy for every Cat enrolled in the city (newjazzcity.pages.dev/api/city).
// Runs on the worker's schedule, against the city's D1 (njc-quest). Holds no key and signs nothing:
//   1. keep only Cats whose holder's grant still holds (same holder and control, not expired, not revoked);
//   2. take the open City Jobs a Cat can do with its reads (one Cat per job, the least busy first);
//   3. when the pay is locked for a Cat, run the read and deliver it (stored, hashed, served by the city);
//   4. read each locked job's Bull agreement from the chain: released or refunded;
//   5. write the round's report.
// The poster's attest on Bull still releases the pay, into the Cat's own wallet.
const RPCS = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com', 'https://4663.rpc.thirdweb.com'];
const GENESIS = '0xb3d33af2ce8ce0792942b487e2213ac665dd83e2', RESOLVER = '0x841d8ec41fc0f8e253e5fc95f8023bca5e1b271d';
const CALLBOOK = '0xca249d64bc49fb33182c46939816dc4bae0f8189';
const RELEASED = '0x3bfce8de0db7450cc169b94323c210e69a36c6a4a58c9f5d96bec4973adce392';
// QHooks pay-when-done escrow: getAgreement(id) word 5 is the pay still held; TrancheReleased(id, tranche, payee).
const Q_RELEASED = '0x72ec94c9f72a73e34c8bc80509fd760d2ac4bd7fc3cf8159037dd5e05af31fbb';
const RECHECK_MS = 10 * 60e3, MAX_TAKES = 20, MAX_DELIVERIES = 10;
const word = v => BigInt(v).toString(16).padStart(64, '0'), addr = a => a.toLowerCase().slice(2).padStart(64, '0');
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function rpc(env, method, params) {
  for (const url of env.CITY_RPC ? [env.CITY_RPC] : RPCS) {
    try {
      const r = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', 'user-agent': 'newjazzcity-round/1'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
      const j = await r.json().catch(() => null);
      if (j && 'result' in j) return j.result;
      if (j?.error && /revert/i.test(j.error.message || '')) return null;
    } catch {}
  }
  throw new Error('the chain did not answer');
}
const call = (env, to, data) => rpc(env, 'eth_call', [{to, data}, 'latest']);

// controlOf(genesis, cat) on the control resolver: (root, fingerprint, depth, guarded); grantRevoked(digest) on the
// CallBook, with the grant's EIP-712 digest that the site stored at enrollment.
async function grantHolds(env, c) {
  if (c.expires * 1000 < Date.now()) return 'expired';
  const r = await call(env, RESOLVER, '0x8127a896' + addr(GENESIS) + word(c.cat));
  if (!r || r.length < 2 + 64 * 4) return 'unreadable';
  const root = '0x' + r.slice(2 + 24, 66), fp = '0x' + r.slice(66, 130), guarded = BigInt('0x' + r.slice(194, 258)) === 1n;
  if (!guarded) return 'unreadable';
  if (root.toLowerCase() !== c.holder.toLowerCase() || fp.toLowerCase() !== c.control.toLowerCase()) return 'changed hands';
  const digest = JSON.parse(c.grant_json).digest;
  if (digest && BigInt(await call(env, CALLBOOK, '0x6eb7be80' + digest.slice(2)) || '0x0') === 1n) return 'revoked';
  return null;
}

export async function cityRound(env, {run, catWallet}) {
  const db = env.QDB, t0 = Date.now(), origin = env.CITY_ORIGIN || 'https://newjazzcity.pages.dev';
  const report = {enrolled: 0, dropped: [], took: [], delivered: [], released: [], refunded: [], errors: []};
  if (!db) return {...report, errors: ['no city database bound']};

  // 1. Cats whose grant still holds.
  const live = [];
  for (const c of (await db.prepare('SELECT * FROM city_cats WHERE active=1').all()).results) {
    if (c.checked && t0 - c.checked < RECHECK_MS) { live.push(c); continue; }
    let why; try { why = await grantHolds(env, c); } catch (e) { report.errors.push({cat: c.cat, error: e.message}); live.push(c); continue; }
    await db.prepare(`UPDATE city_cats SET ${why ? 'active=0, ' : ''}checked=? WHERE cat=?`).bind(t0, c.cat).run();
    if (why) report.dropped.push({cat: c.cat, why}); else live.push(c);
  }
  report.enrolled = live.length;

  // 2. Take open jobs a Cat can do: one Cat per job, the least busy first.
  if (live.length) {
    const load = new Map(live.map(c => [c.cat, 0]));
    for (const r of (await db.prepare("SELECT b.cat, COUNT(*) n FROM city_bids b JOIN city_jobs j ON j.id=b.job WHERE b.cat IS NOT NULL AND j.status IN ('open','awarded','funded') GROUP BY b.cat").all()).results)
      if (load.has(r.cat)) load.set(r.cat, r.n);
    const open = (await db.prepare(`SELECT id, read, hire_cat FROM city_jobs j WHERE status='open' AND read IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM city_bids b WHERE b.job=j.id AND b.cat IS NOT NULL) ORDER BY created LIMIT ${MAX_TAKES}`).all()).results;
    for (const j of open) {
      // A job that hires one Cat goes to that Cat only, once it is in the city.
      if (j.hire_cat && !load.has(j.hire_cat)) { report.waiting = [...(report.waiting || []), {job: j.id, cat: j.hire_cat}]; continue; }
      const [cat] = j.hire_cat ? [j.hire_cat] : [...load.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
      try {
        const wallet = await catWallet(String(cat));
        await db.prepare('INSERT OR IGNORE INTO city_bids (job,taker,agent,cat,wallet,signer,note,created) VALUES (?,?,?,?,?,?,?,?)')
          .bind(j.id, 'cat:' + cat, null, cat, wallet, 'city', `JazzCat #${cat} runs ${j.read} for this job and delivers it the round the pay locks.`, t0).run();
        load.set(cat, load.get(cat) + 1); report.took.push({job: j.id, cat});
      } catch (e) { report.errors.push({job: j.id, error: e.message}); }
    }
  }

  // 3. Deliver for Cats whose pay is locked.
  const enrolled = new Set(live.map(c => c.cat));
  for (const j of (await db.prepare(`SELECT * FROM city_jobs WHERE status='funded' AND taker_cat IS NOT NULL AND read IS NOT NULL LIMIT ${MAX_DELIVERIES}`).all()).results) {
    if (!enrolled.has(j.taker_cat) || !run[j.read]) continue;
    try {
      const args = JSON.parse(j.read_args || '{}'), result = await run[j.read][0](new URLSearchParams(args));
      const body = JSON.stringify({job: j.id, cat: j.taker_cat, read: j.read, args, at: new Date().toISOString(), result});
      const hash = '0x' + hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
      await db.batch([
        db.prepare('INSERT OR REPLACE INTO city_results (job,cat,read,body,hash,created) VALUES (?,?,?,?,?,?)').bind(j.id, j.taker_cat, j.read, body, hash, Date.now()),
        db.prepare("UPDATE city_jobs SET status='delivered', result_hash=?, result_url=?, updated=? WHERE id=? AND status='funded'").bind(hash, `${origin}/api/city/result/${j.id}`, Date.now(), j.id)]);
      report.delivered.push({job: j.id, cat: j.taker_cat, hash});
    } catch (e) { report.errors.push({job: j.id, error: String(e.message).slice(0, 160)}); }
  }

  // 4. Settle from the chain: Bull's agreements(id) status 2 released, 3 refunded; a QHooks agreement is released once its
  //    TrancheReleased event is on chain and refunded when nothing is held and no release happened.
  for (const j of (await db.prepare("SELECT * FROM city_jobs WHERE status IN ('funded','delivered') AND agreement IS NOT NULL AND agreement_contract IS NOT NULL").all()).results) {
    try {
      const qhooks = j.escrow === 'qhooks', from = '0x' + Number(j.funded_block || 0).toString(16);
      const raw = await call(env, j.agreement_contract, (qhooks ? '0x4f9f6fe6' : '0xd5a7420d') + word(j.agreement));
      const word5 = raw && raw.length >= 2 + 64 * 6 ? BigInt('0x' + raw.slice(2 + 64 * 5, 2 + 64 * 6)) : null;
      const qlogs = qhooks && word5 === 0n ? await rpc(env, 'eth_getLogs', [{address: j.agreement_contract, fromBlock: from, toBlock: 'latest', topics: [Q_RELEASED, '0x' + word(j.agreement)]}]) : null;
      const status = word5 === null ? 0 : qhooks ? (word5 > 0n ? 1 : qlogs?.length ? 2 : 3) : Number(word5);
      if (status === 3) {
        await db.prepare("UPDATE city_jobs SET status='refunded', updated=? WHERE id=?").bind(Date.now(), j.id).run();
        report.refunded.push({job: j.id});
      } else if (status === 2) {
        const logs = qlogs || await rpc(env, 'eth_getLogs', [{address: j.agreement_contract, fromBlock: from, toBlock: 'latest', topics: [RELEASED, '0x' + word(j.agreement)]}]);
        const tx = Array.isArray(logs) && logs[0]?.transactionHash || null;
        await db.prepare("UPDATE city_jobs SET status='released', release_tx=?, updated=? WHERE id=?").bind(tx, Date.now(), j.id).run();
        report.released.push({job: j.id, cat: j.taker_cat, agentId: j.taker_agent, pay: j.amount, tx});
      }
    } catch (e) { report.errors.push({job: j.id, error: e.message}); }
  }

  await db.prepare('INSERT INTO city_rounds (at, report) VALUES (?,?)').bind(t0, JSON.stringify(report)).run();
  return report;
}
