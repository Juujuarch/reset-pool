// RESET POOL — dashboard (port 6969). Flat, tight, TRAC-like. No ornament.
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
  if (!L) return `<tr><td colspan="4" class="muted">Ledger not active yet. Numbers appear once the contract is deployed and the claim loop is running.</td></tr>`;
  const t = L.totals || {};
  const members = (L.members || []).slice().sort((a, b) => Number(b.principal) - Number(a.principal));
  const roundRows = (L.rounds || []).slice(-24).reverse().map(r =>
    `<tr><td>#${r.round}</td><td class="num">${f8(r.amount)}</td><td class="num">${f8(r.fee || 0)}</td><td class="num">${f8(r.dust || 0)}</td></tr>`).join('');
  return `
  <div class="stats">
    <div><span class="k">Principal</span><span class="v">${fx(t.principal)}</span></div>
    <div><span class="k">Earnings owed</span><span class="v">${fx(t.earningsOwed)}</span></div>
    <div><span class="k">Fees accrued</span><span class="v">${fx(t.feesAccrued)}</span></div>
    <div><span class="k">Fees swept</span><span class="v">${fx(t.feesSwept)}</span></div>
    <div><span class="k">Members</span><span class="v">${members.length}</span></div>
  </div>
  ${members.length ? `<table>
  <thead><tr><th>Address</th><th class="num">Principal</th><th class="num">Earnings</th><th class="num">Exit</th></tr></thead>
  <tbody>${members.map(m => `<tr>
    <td class="mono">${short(m.address)}</td>
    <td class="num">${f8(m.principal)}</td>
    <td class="num">${f8(m.earnings)}</td>
    <td class="num">${Number(m.exiting) > 0 ? f8(m.exiting) : '<span class="muted">–</span>'}</td></tr>`).join('')}</tbody></table>` : ''}
  ${L.rounds?.length ? `<table>
  <thead><tr><th>Round</th><th class="num">Payout</th><th class="num">Fee</th><th class="num">Dust</th></tr></thead>
  <tbody>${roundRows}</tbody></table>` : ''}`;
}

function calcSection(chain, L) {
  const poolP = L?.totals?.principal ? Number(L.totals.principal) : 0;
  const rows = [0.001, 0.01, 0.1, 0.5, 1, 5, 20].map(v => {
    const e = estimate(chain, poolP || 218092214228, Math.round(v * DEC));
    return `<tr><td class="num">${v}</td><td class="num">${e ? fx(Math.round(e.net)) : '–'}</td>
    <td class="num">${e ? fx(Math.round(e.perDay)) : '–'}</td>
    <td class="num">${e ? fx(Math.round(e.perWeek)) : '–'}</td>
    <td class="num">${e ? fx(Math.round(e.perMonth)) : '–'}</td></tr>`;
  }).join('');
  return `<p class="note">Based on the live round guideline (${chain ? fx(chain.guideline) : '–'} RESET/round) and pro-rata share. Fees already deducted. Yield falls as network deposits rise.</p>
  <table><thead><tr><th class="num">Deposit (RESET)</th><th class="num">Net/round</th><th class="num">Per day</th><th class="num">Per week</th><th class="num">Per month</th></tr></thead>
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
<title>RESET Pool</title>
<link rel="icon" type="image/png" href="/assets/trac-favicon.png">
<style>
:root{--bg:#0e1416;--panel:#131a1d;--line:#21292d;--txt:#e9e9eb;--muted:#7d858c;--red:#ea5b64;--ok:#6fcf97}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--txt);font:15px/1.6 -apple-system,'Segoe UI',Inter,sans-serif;padding:0 24px 64px;max-width:1060px;margin:0 auto}
header{display:flex;align-items:center;justify-content:space-between;padding:28px 0 24px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px;font-size:16px;font-weight:600;letter-spacing:.2px}
.brand img{width:26px;height:26px}
.brand small{color:var(--muted);font-weight:400;font-size:13px;margin-left:2px}
nav a{color:var(--muted);text-decoration:none;font-size:14px;margin-left:24px}
nav a:hover{color:var(--txt)}
h2{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin:36px 0 14px}
.stats{display:flex;flex-wrap:wrap;gap:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel)}
.stats>div{flex:1 1 150px;padding:16px 18px;border-right:1px solid var(--line)}
.stats>div:last-child{border-right:none}
.k{display:block;font-size:12px;color:var(--muted);margin-bottom:4px}
.v{display:block;font-size:19px;font-weight:600;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--muted)}
table{width:100%;border-collapse:collapse;border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:12px 0 0;background:var(--panel);font-size:14px}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--line)}
thead th{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;background:#101619}
tbody tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)} .ok{color:var(--ok)} .red{color:var(--red)}
code{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--txt)}
.note{color:var(--muted);font-size:13.5px;max-width:640px;margin-bottom:4px}
.kv{border:1px solid var(--line);border-radius:8px;background:var(--panel)}
.kv>div{display:grid;grid-template-columns:230px 1fr;gap:16px;padding:11px 18px;border-bottom:1px solid var(--line);font-size:14px}
.kv>div:last-child{border-bottom:none}
.kv .k{color:var(--muted)}
ol{margin:0;padding:0;list-style:none;counter-reset:s}
ol li{display:grid;grid-template-columns:230px 1fr;gap:16px;padding:11px 18px;border-bottom:1px solid var(--line);font-size:14px;counter-increment:s}
ol li:last-child{border-bottom:none}
ol li::before{content:counter(s);color:var(--red);font-weight:600;font-variant-numeric:tabular-nums}
ol li b{color:var(--muted);font-weight:400;grid-column:1}
ol li span{grid-column:2}
a{color:var(--red);text-decoration:none}
a:hover{text-decoration:underline}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:13px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
@media(max-width:640px){.kv>div,ol li{grid-template-columns:1fr}ol li b,ol li span{grid-column:1}ol li::before{grid-column:1}}
</style></head><body>
<header>
  <div class="brand"><img src="/assets/trac-favicon.png" alt="">RESET Pool <small>· poolreset.bond</small></div>
  <nav><a href="${REPO}">Source</a><a href="/about">About</a><a href="${REPO}/blob/main/TUTORIAL.md">Guide</a></nav>
</header>

<h2>Pool status</h2>
<div class="stats">
  <div><span class="k">Contract</span><span class="v ${POOL_WALLET ? 'ok' : ''}">${POOL_WALLET ? 'Live' : '<span class="muted">Pending</span>'}</span></div>
  <div><span class="k">Round</span><span class="v">#${c.round ?? '–'}</span></div>
  <div><span class="k">Claim window</span><span class="v ${c.windowOpen ? 'ok' : 'muted'}">${c.windowOpen != null ? (c.windowOpen ? 'Open' : 'Closed') : '–'}</span></div>
  <div><span class="k">Pool balance</span><span class="v">${d.poolBal != null ? fx(d.poolBal) : '–'}</span></div>
  <div><span class="k">Solvency</span><span class="v ${solv != null ? (solv >= 0 ? 'ok' : 'red') : ''}">${solv != null ? (solv >= 0 ? '+' : '−') + fx(Math.abs(solv)) : '–'}</span></div>
</div>

<h2>Network</h2>
<div class="stats">
  <div><span class="k">BTC tip</span><span class="v">${c.tip ?? '–'}</span></div>
  <div><span class="k">Counted</span><span class="v">${c.counted ?? '–'}</span></div>
  <div><span class="k">Guideline / round</span><span class="v">${c.guideline != null ? fx(c.guideline) : '–'}</span></div>
  <div><span class="k">Claims this round</span><span class="v">${c.claimCount ?? '–'}</span></div>
  <div><span class="k">Mine deposits</span><span class="v">${c.claimDeposit != null ? fx(c.claimDeposit) : '–'}</span></div>
</div>

<h2>Ledger</h2>
<div class="stats">${ledgerSection(L)}</div>

<h2>Estimated earnings</h2>
${calcSection(c, L)}

<h2>Fees</h2>
<p class="note">Fees apply to earnings only — principal is returned in full. The rate depends on your own deposit, not the pool total.</p>
<table><thead><tr><th>Your principal</th><th class="num">Fee on earnings</th></tr></thead><tbody>
<tr><td>below 1 RESET</td><td class="num">10%</td></tr>
<tr><td>1 – 5 RESET</td><td class="num">5%</td></tr>
<tr><td>5 – 20 RESET</td><td class="num">2%</td></tr>
<tr><td>20 RESET and above</td><td class="num ok">0%</td></tr>
</tbody></table>

<h2>Join</h2>
<div class="kv"><ol>
<li><b>Prepare</b><span>A RESET wallet and about 0.15 TNK for network fees. Minimum deposit is 0.001 RESET.</span></li>
<li><b>Clone the contract</b><span><code>git clone ${REPO}</code> — verify the md5 hashes against the README.</span></li>
<li><b>Register</b><span><code>member_register</code>, then prove ownership with <code>sign_challenge</code> via your agent.</span></li>
<li><b>Deposit</b><span>Send RESET to the pool wallet and report the transfer reference. Credited once, verifiable on-chain.</span></li>
<li><b>Monitor</b><span>Read your numbers here or from your own peer — every member holds the ledger.</span></li>
</ol></div>

<footer>
  <div>Pool wallet <code>${POOL_WALLET ? short(POOL_WALLET, 12) : 'TBD'}</code> · Fee receiver <code>${short(FEE_WALLET, 12)}</code></div>
  <div>Independent pool · not affiliated with Trac Systems · <a href="${REPO}">source</a></div>
</footer>
</body></html>`;
}

const FAVICON = fs.readFileSync(path.join(__dirname, 'assets', 'trac-favicon.png'));
const ABOUT = fs.readFileSync(path.join(__dirname, 'about.html'));
const server = http.createServer(async (req, res) => {
  if (req.url === '/assets/trac-favicon.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
    return res.end(FAVICON);
  }
  if (req.url === '/about' || req.url === '/home') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(ABOUT);
  }
  if (req.url === '/dashboard') {
    const d = await collect();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page(d));
  }
  if (req.url === '/api/state') {
    const d = await collect();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(d, (k, v) => typeof v === 'bigint' ? String(v) : v));
  }
  // '/' and '/dashboard' render the live dashboard; '/about' is the editorial home.
  const d = await collect();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(d));
});

server.listen(PORT, HOST, () => console.log(`[pool-dash] on http://${HOST}:${PORT}`));
