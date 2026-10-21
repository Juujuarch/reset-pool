// RESET POOL — live dashboard (port 6969). TRAC-branded editorial style, matching /about.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.POOL_DASH_PORT || 6969;
const HOST = process.env.POOL_DASH_HOST || '0.0.0.0';
const LEDGER_FILE = process.env.POOL_LEDGER_FILE || path.join(__dirname, 'data', 'pool-state.json');
const GATEWAY = process.env.RESET_GATEWAY || 'https://reset.openmayhem.ai/v1';
const POOL_WALLET = process.env.POOL_WALLET_ADDRESS || '';
const FEE_WALLET = process.env.FEE_WALLET_ADDRESS || 'trac1qxfjjn7deyusu3450cv6n5tpewy6ked99vergt22zfsrjx8qthnqdmz94t';
const REPO = 'https://github.com/Juujuarch/reset-pool';
const DEC = 1e8;

const f8 = (u) => (Number(u || 0) / DEC).toFixed(8);
const fx = (u) => f8(u).replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m)) || '0';
const short = (a, n = 16) => (a && a.length > n + 4 ? a.slice(0, n) + '…' + a.slice(-6) : a || '—');

async function gw(p) {
  const res = await fetch(`${GATEWAY}${p}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  return res.json();
}

async function collect() {
  const out = { ts: new Date().toISOString(), errors: [] };
  try {
    const st = await gw('/state');
    const m = st.mine || {};
    out.chain = {
      tip: st.tip?.height, counted: st.counted, round: m.r,
      windowOpen: !!m.window_open, guideline: m.last_guideline,
      claimCount: m.claim_count, claimDeposit: m.claim_deposit,
      blocksLeftInRound: st.tip?.height && m.end ? Math.max(0, m.end - st.tip.height) : null,
      blocksToClaimEnd: st.tip?.height && m.claim_end ? Math.max(0, m.claim_end - st.tip.height) : null,
    };
  } catch (e) { out.errors.push('chain: ' + e.message); }
  if (POOL_WALLET) {
    try { out.poolBal = (await gw(`/account/${POOL_WALLET}`))?.balance ?? null; } catch { out.poolBal = null; }
  }
  try { out.ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')); } catch { out.ledger = null; }
  return out;
}

function estimate(chain, poolP, memberP) {
  if (!chain?.guideline || !poolP || !memberP) return null;
  const gross = Number(BigInt(chain.guideline) * BigInt(memberP) / BigInt(poolP));
  const feeBps = memberP >= 20 * DEC ? 0 : memberP >= 5 * DEC ? 200 : memberP >= 1 * DEC ? 500 : 1000;
  const net = gross * (1 - feeBps / 10000);
  return { net, perDay: net * 24, perWeek: net * 24 * 7, perMonth: net * 24 * 30 };
}

function ledgerSection(L) {
  if (!L) return `<table><tbody><tr><td class="mut" style="padding:18px 16px">Ledger not active yet — the contract is pending deployment. Every number on this page appears automatically once the claim loop starts.</td></tr></tbody></table>`;
  const t = L.totals || {};
  const members = (L.members || []).slice().sort((a, b) => Number(b.principal) - Number(a.principal));
  const roundRows = (L.rounds || []).slice(-24).reverse().map(r =>
    `<tr><td class="n">#${r.round}</td><td class="num">${f8(r.amount)}</td><td class="num">${f8(r.fee || 0)}</td><td class="num mut">${f8(r.dust || 0)}</td></tr>`).join('');
  return `
  <div class="stats">
    <div class="stat"><div class="sv">${fx(t.principal)}</div><div class="sl">Principal (RESET)</div></div>
    <div class="stat"><div class="sv">${fx(t.earningsOwed)}</div><div class="sl">Earnings Owed</div></div>
    <div class="stat"><div class="sv">${fx(t.feesAccrued)}</div><div class="sl">Fees Accrued</div></div>
    <div class="stat"><div class="sv">${members.length}</div><div class="sl">Members</div></div>
  </div>
  ${members.length ? `<h2 class="sub-h">Members</h2>
  <table class="tbl">
  <thead><tr><th>Address</th><th class="num">Principal</th><th class="num">Earnings</th><th class="num">Exit</th></tr></thead>
  <tbody>${members.map(m => `<tr>
    <td class="mono">${short(m.address)}</td>
    <td class="num n">${f8(m.principal)}</td>
    <td class="num">${f8(m.earnings)}</td>
    <td class="num">${Number(m.exiting) > 0 ? f8(m.exiting) : '<span class="mut">–</span>'}</td></tr>`).join('')}</tbody></table>` : ''}
  ${L.rounds?.length ? `<h2 class="sub-h">Rounds Settled</h2>
  <table class="tbl">
  <thead><tr><th>Round</th><th class="num">Payout</th><th class="num">Fee</th><th class="num">Dust</th></tr></thead>
  <tbody>${roundRows}</tbody></table>` : ''}`;
}

function calcSection(chain, L) {
  const poolP = L?.totals?.principal ? Number(L.totals.principal) : 0;
  const rows = [0.001, 0.01, 0.1, 0.5, 1, 5, 20].map(v => {
    const e = estimate(chain, poolP || 218092214228, Math.round(v * DEC));
    return `<tr><td class="n num">${v}</td><td class="num">${e ? fx(Math.round(e.net)) : '–'}</td>
    <td class="num pos">${e ? fx(Math.round(e.perDay)) : '–'}</td>
    <td class="num">${e ? fx(Math.round(e.perWeek)) : '–'}</td>
    <td class="num">${e ? fx(Math.round(e.perMonth)) : '–'}</td></tr>`;
  }).join('');
  return `<p class="note">Based on the live round guideline (${chain ? fx(chain.guideline) : '–'} RESET/round)
  and pro-rata share, with your fee tier already deducted. Yield falls as total network deposits rise —
  these are measurements, not promises.</p>
  <table class="tbl"><thead><tr><th class="num">Deposit (RESET)</th><th class="num">Net / round</th><th class="num">Per day</th><th class="num">Per week</th><th class="num">Per month</th></tr></thead>
  <tbody>${rows}</tbody></table>`;
}

function page(d) {
  const c = d.chain || {};
  const L = d.ledger;
  const t = L?.totals;
  const owed = t ? Number(t.principal) + Number(t.earningsOwed) + Number(t.dust) : null;
  const solv = (d.poolBal != null && owed != null) ? d.poolBal - owed : null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Dashboard — RESET Pool</title>
<link rel="icon" type="image/png" href="/assets/trac-favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
 --bg:#0e1416; --bg2:#121a1d; --panel:#131a1d; --line:#21292d;
 --txt:#e9e9eb; --txt2:#8b939f; --txt3:#5a626d;
 --red:#ea5b64; --red2:#ff8a91; --ok:#6fcf97;
 --mono:'JetBrains Mono',monospace; --ui:'Inter',sans-serif; --serif:'Instrument Serif',serif;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--txt);font-family:var(--ui);overflow-x:hidden;-webkit-font-smoothing:antialiased}

.glow{position:fixed;border-radius:50%;filter:blur(120px);pointer-events:none;z-index:0}
.g1{width:520px;height:520px;background:rgba(234,91,100,.08);top:-180px;left:-120px}
.g2{width:460px;height:460px;background:rgba(234,91,100,.05);bottom:-200px;right:-140px}

.wrap{position:relative;z-index:1;max-width:1080px;margin:0 auto;padding:0 28px}

nav{position:fixed;top:0;left:0;right:0;z-index:50;backdrop-filter:blur(20px);background:rgba(14,20,22,.72);border-bottom:1px solid var(--line)}
.nav-in{max-width:1080px;margin:0 auto;padding:16px 28px;display:flex;align-items:center;justify-content:space-between}
.logo{display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:13px;font-weight:600;letter-spacing:-.2px}
.logo img{width:20px;height:20px}
.navlinks{display:flex;gap:26px;font-size:12.5px;color:var(--txt2);align-items:center}
.navlinks a{color:inherit;text-decoration:none;transition:.2s}
.navlinks a:hover{color:var(--red2)}
.nav-cta{border:1px solid rgba(234,91,100,.35);border-radius:6px;padding:6px 13px;color:var(--red2) !important;
 font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.02em;transition:.18s}
.nav-cta:hover{background:rgba(234,91,100,.1);border-color:var(--red);transform:translateY(-1px)}

.hero{padding:150px 0 60px;position:relative}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--red2);margin-bottom:22px;display:flex;align-items:center;gap:10px}
.eyebrow::before{content:'';width:28px;height:1px;background:var(--red)}
h1{font-family:var(--serif);font-size:clamp(38px,5.5vw,62px);line-height:1.05;font-weight:400;letter-spacing:-.025em;margin-bottom:16px}
h1 em{font-style:italic;color:var(--red2)}
.lede{font-size:16px;line-height:1.75;color:var(--txt2);max-width:620px;font-weight:300}
.lede strong{color:var(--txt);font-weight:500}
.livepill{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11px;color:var(--txt2);
 border:1px solid var(--line);border-radius:99px;padding:6px 14px;margin-top:24px;background:var(--bg2)}
.pulse{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok);animation:p 2s infinite}
@keyframes p{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.85)}}

section{padding:64px 0 20px}
.sh{display:flex;align-items:baseline;gap:16px;margin-bottom:30px}
.sn{font-family:var(--mono);font-size:11px;color:var(--txt3)}
h2{font-family:var(--serif);font-size:clamp(26px,3.4vw,38px);font-weight:400;letter-spacing:-.02em}
h2 em{font-style:italic;color:var(--red2)}
h2.sub-h{font-size:14px;font-family:var(--mono);font-weight:600;color:var(--txt2);letter-spacing:.06em;text-transform:uppercase;margin:36px 0 12px}

.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.stats.g3{grid-template-columns:repeat(3,1fr)}
.stats.g5{grid-template-columns:repeat(5,1fr)}
.stat{background:var(--bg2);padding:22px 20px;transition:.25s}
.stat:hover{background:var(--panel)}
.k{display:block;font-size:11px;color:var(--txt3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px}
.v{display:block;font-family:var(--mono);font-size:21px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.v.red{color:var(--red2)}
.v.ok{color:var(--ok)}
.v small{font-size:12px;color:var(--txt3);font-weight:400}

.tbl{width:100%;border-collapse:collapse;font-size:13px;background:var(--bg2);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.tbl th{text-align:left;padding:12px 16px;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--txt3);border-bottom:1px solid var(--line);font-weight:500;background:#101619}
.tbl td{padding:12px 16px;border-bottom:1px solid rgba(33,41,45,.6);font-family:var(--mono);font-size:12.5px}
.tbl tr:last-child td{border-bottom:none}
.tbl tbody tr:hover td{background:rgba(234,91,100,.04)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.mono{font-family:var(--mono);font-size:12.5px;color:var(--txt2)}
.n{color:var(--txt);font-weight:500}
.pos{color:var(--ok)}
.mut{color:var(--txt3)}

.note{color:var(--txt2);font-size:13.5px;line-height:1.75;max-width:680px;margin-bottom:18px;font-weight:300}

.kv{border:1px solid var(--line);border-radius:12px;background:var(--bg2);overflow:hidden}
.kv>div{display:grid;grid-template-columns:260px 1fr;gap:16px;padding:13px 18px;border-bottom:1px solid var(--line);font-size:13.5px;transition:.2s}
.kv>div:hover{background:var(--panel)}
.kv>div:last-child{border-bottom:none}
.kv .k{color:var(--txt2);font-size:13px}
.kv code{font-family:var(--mono);font-size:12.5px;color:var(--red2);background:rgba(234,91,100,.08);padding:2px 8px;border-radius:5px}

.tiers{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:20px}
.tier{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:22px 20px;text-align:center;transition:.25s;position:relative;overflow:hidden}
.tier::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(234,91,100,.4),transparent);opacity:0;transition:.3s}
.tier:hover{border-color:#2a3238;transform:translateY(-2px)}
.tier:hover::before{opacity:1}
.tier .tf{font-family:var(--mono);font-size:28px;font-weight:600;color:var(--red2);letter-spacing:-.02em}
.tier.zero .tf{color:var(--ok)}
.tier .tp{font-size:11.5px;color:var(--txt2);margin-top:6px;font-weight:300}
.tier .tl{font-family:var(--mono);font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.1em;margin-top:10px}

a{color:var(--red2);text-decoration:none}
a:hover{text-decoration:underline}
footer{margin-top:80px;border-top:1px solid var(--line);padding:34px 0 44px;text-align:center;font-size:11.5px;color:var(--txt3);font-family:var(--mono);line-height:2}
footer a{color:var(--txt2)}

@media(max-width:860px){
 .stats,.stats.g3,.stats.g5,.tiers{grid-template-columns:repeat(2,1fr)}
 .kv>div{grid-template-columns:1fr}
 .navlinks{display:none}
 .hero{padding:120px 0 50px}
}
</style></head><body>
<div class="glow g1"></div><div class="glow g2"></div>

<nav><div class="nav-in">
  <div class="logo"><img src="/assets/trac-favicon.png" alt="">RESET POOL</div>
  <div class="navlinks">
    <a href="/#problem">Problem</a>
    <a href="/#how">How it works</a>
    <a href="/#trust">Trust &amp; Safety</a>
    <a href="/#economics">Economics</a>
    <a href="https://github.com/Juujuarch/reset-pool" target="_blank" rel="noopener">Source</a>
    <a href="/" class="nav-cta">About →</a>
  </div>
</div></nav>

<div class="wrap">

<div class="hero">
  <div class="eyebrow">Live Dashboard · poolreset.bond</div>
  <h1>The pool,<br>in <em>numbers.</em></h1>
  <p class="lede">Every figure below is read <strong>live</strong> from the RESET gateway and the
  replicated contract ledger. Nothing on this page is a snapshot from last week.</p>
  <div class="livepill"><span class="pulse"></span> auto-refresh 60s · ${d.ts.slice(11, 19)} UTC</div>
</div>

<section>
  <div class="sh"><span class="sn">01</span><h2>Pool <em>status</em></h2></div>
  <div class="stats">
    <div class="stat"><div class="k">Contract</div><div class="v ${POOL_WALLET ? 'ok' : 'mut'}">${POOL_WALLET ? 'Live' : '<span class="mut">Pending</span>'}</div></div>
    <div class="stat"><div class="k">Mine Round</div><div class="v red">#${c.round ?? '–'}</div></div>
    <div class="stat"><div class="k">Claim Window</div><div class="v ${c.windowOpen ? 'ok' : 'mut'}" style="font-size:16px;padding-top:5px">${c.windowOpen != null ? (c.windowOpen ? 'Open · ~' + (c.blocksToClaimEnd ?? '?') + ' blk' : 'Closed') : '–'}</div></div>
    <div class="stat"><div class="k">Pool Balance</div><div class="v">${d.poolBal != null ? fx(d.poolBal) : '–'}<small> RESET</small></div></div>
  </div>
  <div class="stats g3" style="margin-top:1px">
    <div class="stat"><div class="k">Owed to Members</div><div class="v">${owed != null ? fx(owed) : '–'}<small> RESET</small></div></div>
    <div class="stat"><div class="k">Solvency Margin</div><div class="v ${solv != null ? (solv >= 0 ? 'ok' : 'red') : ''}">${solv != null ? (solv >= 0 ? '+' : '−') + fx(Math.abs(solv)) : '–'}</div></div>
    <div class="stat"><div class="k">Blocks Left in Round</div><div class="v">${c.blocksLeftInRound ?? '–'}</div></div>
  </div>
</section>

<section>
  <div class="sh"><span class="sn">02</span><h2>Network <em>state</em></h2></div>
  <div class="stats g5">
    <div class="stat"><div class="k">BTC Tip</div><div class="v" style="font-size:17px">${c.tip ?? '–'}</div></div>
    <div class="stat"><div class="k">Counted</div><div class="v" style="font-size:17px">${c.counted ?? '–'}</div></div>
    <div class="stat"><div class="k">Guideline / Round</div><div class="v" style="font-size:17px">${c.guideline != null ? fx(c.guideline) : '–'}</div></div>
    <div class="stat"><div class="k">Claims This Round</div><div class="v" style="font-size:17px">${c.claimCount ?? '–'}</div></div>
    <div class="stat"><div class="k">Mine Deposits</div><div class="v" style="font-size:17px">${c.claimDeposit != null ? fx(c.claimDeposit) : '–'}</div></div>
  </div>
</section>

<section>
  <div class="sh"><span class="sn">03</span><h2>Pool <em>ledger</em></h2></div>
  ${ledgerSection(L)}
</section>

<section>
  <div class="sh"><span class="sn">04</span><h2>Estimated <em>earnings</em></h2></div>
  ${calcSection(c, L)}
</section>

<section>
  <div class="sh"><span class="sn">05</span><h2>Fee <em>tiers</em></h2></div>
  <p class="note">Fees apply to earnings only — principal is returned in full. The rate follows your own deposit, not the pool total.</p>
  <div class="tiers">
    <div class="tier"><div class="tf">10%</div><div class="tp">earnings fee</div><div class="tl">&lt; 1 RESET</div></div>
    <div class="tier"><div class="tf">5%</div><div class="tp">earnings fee</div><div class="tl">1 – 5 RESET</div></div>
    <div class="tier"><div class="tf">2%</div><div class="tp">earnings fee</div><div class="tl">5 – 20 RESET</div></div>
    <div class="tier zero"><div class="tf">0%</div><div class="tp">earnings fee</div><div class="tl">≥ 20 RESET</div></div>
  </div>
</section>

<section>
  <div class="sh"><span class="sn">06</span><h2>Wallets &amp; <em>audit</em></h2></div>
  <div class="kv">
    <div><div class="k">Pool wallet (deposits)</div><div>${POOL_WALLET ? `<code>${short(POOL_WALLET, 22)}</code>` : '<span class="mut">set at deploy</span>'}</div></div>
    <div><div class="k">Fee receivers (50/50)</div><div><code>${short(FEE_WALLET, 18)}</code> · <code>${POOL_WALLET ? short(POOL_WALLET, 18) : 'operator main'}</code></div></div>
    <div><div class="k">Contract version</div><div><code>v6.1 — split receivers · auto-stake · immutable</code></div></div>
    <div><div class="k">Verification</div><div><a href="${REPO}#verify-your-copy">md5 hashes on GitHub</a> · adversarial audit 80 checks · 1000-case settlement simulation</div></div>
    <div><div class="k">Independent check</div><div>Every member peer holds the replicated ledger — reconcile these numbers yourself via <code>member_read</code></div></div>
  </div>
</section>

<footer>
  RESET POOL · <a href="/">About</a> · <a href="https://github.com/Juujuarch/reset-pool">Source</a> · <a href="${REPO}/blob/main/TUTORIAL.md">Guide</a><br>
  Independent pool · not affiliated with Trac Systems · estimates are not promises
</footer>

</div>
</body>
</html>`;
}

const FAVICON = fs.readFileSync(path.join(__dirname, 'assets', 'trac-favicon.png'));
const HOME = fs.readFileSync(path.join(__dirname, 'about.html'));
const server = http.createServer(async (req, res) => {
  if (req.url === '/assets/trac-favicon.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
    return res.end(FAVICON);
  }
  if (req.url === '/dashboard' || req.url === '/about' || req.url === '/home') {
    const d = await collect();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page(d));
  }
  if (req.url === '/api/state') {
    const d = await collect();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(d, (k, v) => typeof v === 'bigint' ? String(v) : v));
  }
  // '/' renders the editorial about page as the home. '/dashboard' shows live data.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HOME);
});

server.listen(PORT, HOST, () => console.log(`[pool-dash] on http://${HOST}:${PORT}`));
