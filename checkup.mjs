// Agent check-up: reads an agent's instructions, skills, memory notes, MCP configs or tool descriptions and reports what
// could turn it against its owner. Deterministic, no model:
//   hidden characters (zero-width, bidi controls, tag characters, mixed-script look-alike letters);
//   planted orders (ignore-the-rules, standing rules to send, pay or report, secrecy, asks for keys or the system prompt);
//   payment targets (every address it names; look-alike pairs: same first and last characters, different middle);
//   risky tools (pay, send, sign or approve with auto-approval, wildcards, no cap; pipe-to-shell; long encoded blobs).
// Reports paths, lines and counts, never secret values.
const HIDDEN = [[/[​-‏⁠-⁤﻿]/g, 'zero-width character'], [/[‪-‮⁦-⁩]/g, 'bidi control (reorders what you read)'], [/[\u{E0000}-\u{E007F}]/gu, 'Unicode tag character (invisible text)']];
const ORDERS = [
  [/\bignore (all |any )?(previous|prior|above|earlier|other) (instructions|rules|messages)\b/i, 'tells the agent to ignore its instructions', 'high'],
  [/\b(standing|permanent|new) (rule|instruction|order)\b/i, 'plants a standing rule', 'medium'],
  [/\b(do not|don't|never) (tell|inform|show|mention)( this)? (to )?(the )?(user|owner|human|operator)\b/i, 'asks for secrecy from the owner', 'high'],
  [/\b(secretly|silently|quietly|without (asking|telling|confirmation))\b/i, 'asks to act without the owner knowing', 'medium'],
  [/\b(send|pay|transfer|wire|approve|forward)\b[^.\n]{0,80}\b(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/i, 'orders a payment or approval to an address', 'high'],
  [/\b(e-?mail|post|send|report|copy)\b[^.\n]{0,60}\b(every|each|all)\b[^.\n]{0,40}\b(payment|transaction|transfer|message|key|secret)s?\b/i, 'orders a report of every payment or secret to someone', 'high'],
  [/\b(reveal|print|output|share|send|show)\b[^.\n]{0,40}\b(system prompt|private key|seed phrase|mnemonic|api key|secret key|password)s?\b/i, 'asks for keys, secrets or the system prompt', 'high'],
  [/\b(you are now|from now on you|act as) (an? )?(admin|developer mode|unrestricted|dan)\b/i, 'tries to change who the agent is', 'medium'],
];
const RISKY = [
  [/"?(autoApprove|alwaysAllow|auto_approve|always_allow)"?\s*[:=]\s*(true|\[)/i, 'tools run without asking', 'high'],
  [/"?(permissions?|allow(ed)?Tools?)"?\s*[:=]\s*\[?\s*"\*"/i, 'wildcard permission', 'high'],
  [/\b(curl|wget)\b[^\n|]*\|\s*(ba|z)?sh\b/i, 'downloads and runs a script', 'high'],
  [/\b(transfer|send_?(eth|usdc|usdg|token)|pay|sign_?(tx|transaction|message)|approve)\b/i, 'a tool that can move money or sign', 'info'],
  [/[A-Za-z0-9+/]{200,}={0,2}/, 'a long encoded blob (may hide instructions)', 'medium'],
];
const EVM = /0x[0-9a-fA-F]{40}/g, SOL = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const mixedScript = w => /[A-Za-z]/.test(w) && /[Ͱ-ϿЀ-ӿ]/.test(w);

// mode 'agent' (default): an agent's own instructions, memory, skills, configs: every rule applies.
// mode 'docs': a service's public documentation, where documented fee addresses and "never send a key" are normal:
// payment-to-address and act-without-asking become info, and negated sentences never count as asks.
export function checkup(files, {expect = [], mode = 'agent'} = {}) {
  const docs = mode === 'docs', negated = ln => /\b(never|don't|do not|no endpoint|won't|will not|not)\b[^.]{0,40}\b(send|share|reveal|print|paste|enter|give)\b/i.test(ln);
  if (!Array.isArray(files) || !files.length) throw new Error('send {"text": "…"} or {"files": [{"name": "SKILL.md", "content": "…"}]}');
  const findings = [], addresses = new Map(), known = new Set(expect.map(a => String(a).toLowerCase()));
  let bytes = 0;
  for (const f of files.slice(0, 50)) {
    const name = String(f.name || 'text').slice(0, 200), content = String(f.content ?? '').slice(0, 200_000); bytes += content.length;
    const lines = content.split('\n'), cap = (why, sev, line) => findings.length < 300 && findings.push({file: name, line, finding: why, severity: sev});
    lines.forEach((ln, i) => {
      for (const [re, why] of HIDDEN) { const n = (ln.match(re) || []).length; if (n) cap(`${n} ${why}${n > 1 ? 's' : ''}`, 'high', i + 1); re.lastIndex = 0; }
      if (ln.split(/\s+/).some(mixedScript)) cap('a word mixes Latin with Greek or Cyrillic look-alike letters', 'medium', i + 1);
      for (const [re, why, sev] of ORDERS) if (re.test(ln)) {
        if (/keys, secrets|payment or approval|without the owner/.test(why) && negated(ln)) continue;
        cap(why, docs && /payment or approval|without the owner|report of every/.test(why) ? 'info' : sev, i + 1);
      }
      for (const [re, why, sev] of RISKY) if (re.test(ln)) cap(why, sev, i + 1);
      for (const a of ln.match(EVM) || []) { const k = a.toLowerCase(); if (!addresses.has(k)) addresses.set(k, {address: a, chain: 'evm', file: name, line: i + 1}); }
      for (const a of ln.match(SOL) || []) if (/[0-9]/.test(a) && /[A-Za-z]/.test(a) && !addresses.has(a)) addresses.set(a, {address: a, chain: 'solana', file: name, line: i + 1});
    });
  }
  // Look-alikes: the same first 4 and last 4 characters, a different middle (address poisoning), within the files or
  // against the addresses the owner expects.
  const all = [...addresses.values()], key = a => a.address.toLowerCase().replace(/^0x/, ''), ends = a => key(a).slice(0, 4) + key(a).slice(-4);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++)
    if (all[i].chain === all[j].chain && ends(all[i]) === ends(all[j])) findings.push({file: all[j].file, line: all[j].line, finding: `look-alike of ${all[i].address.slice(0, 6)}…${all[i].address.slice(-4)} (same ends, different middle): address poisoning`, severity: 'high'});
  for (const a of all) if (known.size && !known.has(a.address.toLowerCase())) {
    const twin = [...known].find(k => k.replace(/^0x/, '').slice(0, 4) + k.slice(-4) === ends(a));
    findings.push({file: a.file, line: a.line, finding: twin ? `look-alike of an address you expect (${twin.slice(0, 6)}…${twin.slice(-4)}): address poisoning` : 'an address you did not list as expected', severity: twin ? 'high' : 'medium'});
  }
  const count = s => findings.filter(f => f.severity === s).length;
  const verdict = count('high') ? 'BLOCK' : count('medium') ? 'REVIEW' : 'CLEAR';
  return {type: 'agent-checkup/v1', mode, verdict, high: count('high'), medium: count('medium'), info: count('info'), files: files.length, bytes,
    addresses: all.map(({address, chain, file, line}) => ({address, chain, file, line})), findings,
    note: 'Deterministic scan by JazzCat #1 (New Jazz City). It reports paths, lines and counts, never secret values. CLEAR means none of these patterns, not a guarantee.',
    next: 'Before paying any address it names: poison_check (look-alikes in that wallet\'s history) or full_check.'};
}
