// RESET POOL — Full dashboard (port 6969). TRAC-branded glossy red theme.
// Palette: #EA5B64 (TRAC red) on #0E1416, text #E9E9EB.
// Ledger data: data/pool-state.json (operator loop). 4747 untouched.
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
const short = (a, n = 14) => (a && a.length > n + 4 ? a.slice(0, n) + '…' + a.slice(-6) : a || '—');

async function gw(p) {
  const res = await fetch(`${GATEWAY}${p}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  return res.json();
}

async function walletBalance(addr) {
  if (!addr) return null;
  try { return (await gw(`/account/${addr}`))?.balance ?? null; } catch { return null; }
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
  if (POOL_WALLET) out.poolBal = await walletBalance(POOL_WALLET);
  try { out.ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')); } catch { out.ledger = null; }
  return out;
}

function estimate(chain, poolPrincipalUnits, memberPrincipalUnits) {
  if (!chain?.guideline || !poolPrincipalUnits || !memberPrincipalUnits) return null;
  const gross = Number(BigInt(chain.guideline) * BigInt(memberPrincipalUnits) / BigInt(poolPrincipalUnits));
  const feeBps = memberPrincipalUnits >= 20 * DEC ? 0 : memberPrincipalUnits >= 5 * DEC ? 200 : memberPrincipalUnits >= 1 * DEC ? 500 : 1000;
  const net = gross * (1 - feeBps / 10000);
  return { net, feeBps, perDay: net * 24, perWeek: net * 24 * 7, perMonth: net * 24 * 30 };
}

const tierTable = () => `<table><thead><tr><th>Principal kamu</th><th class="num">Fee earnings</th></tr></thead><tbody>
  <tr><td>&lt; 1 RESET</td><td class="num red">10%</td></tr>
  <tr><td>1 – 5 RESET</td><td class="num red">5%</td></tr>
  <tr><td>5 – 20 RESET</td><td class="num red">2%</td></tr>
  <tr><td>≥ 20 RESET</td><td class="num ok">0%</td></tr>
  <tr><td>⭐ Staker (whitelisted, ≥ 0.5)</td><td class="num ok">0% + 50% bagan fee</td></tr>
  </tbody></table>`;

function ledgerSection(L) {
  if (!L) return `<div class="empty">⏳ Ledger belum aktif — kontrak belum di-deploy. Data muncul otomatis setelah claim loop jalan.</div>`;
  const t = L.totals || {};
  const members = (L.members || []).slice().sort((a, b) => Number(b.principal) - Number(a.principal));
  const rows = members.map(m => `<tr>
    <td><code>${short(m.address)}</code></td>
    <td class="num">${f8(m.principal)}</td>
    <td class="num red">${f8(m.earnings)}</td>
    <td>${m.staker ? '⭐' : '<span class="dim">member</span>'}</td>
    <td>${Number(m.exiting) > 0 ? f8(m.exiting) : '<span class="dim">—</span>'}</td></tr>`).join('');
  const rounds = (L.rounds || []).slice(-24).reverse().map(r => `<tr>
    <td>#${r.round}</td><td class="num">${f8(r.amount)}</td><td class="num red">${f8(r.fee || 0)}</td><td class="num dim">${f8(r.dust || 0)}</td></tr>`).join('');
  return `
  <div class="grid">
    <div class="card glow"><div class="label">Total Principal</div><div class="big">${fx(t.principal)} <span class="unit">RESET</span></div></div>
    <div class="card"><div class="label">Earnings Owed</div><div class="big red">${fx(t.earningsOwed)}</div></div>
    <div class="card"><div class="label">Fees Accrued</div><div class="big red">${fx(t.feesAccrued)}</div></div>
    <div class="card"><div class="label">Fees Swept</div><div class="big">${fx(t.feesSwept)}</div></div>
    <div class="card"><div class="label">Dust</div><div class="big dim">${fx(t.dust)}</div></div>
    <div class="card glow"><div class="label">Members</div><div class="big">${members.length}</div></div>
  </div>
  <h2>Members</h2>
  <table><thead><tr><th>Address</th><th class="num">Principal</th><th class="num">Earnings</th><th>Role</th><th>Exit</th></tr></thead>
  <tbody>${rows || '<tr><td colspan=5 class="empty">belum ada member</td></tr>'}</tbody></table>
  <h2>Rounds Settled</h2>
  <table><thead><tr><th>Round</th><th class="num">Payout</th><th class="num">Fee</th><th class="num">Dust</th></tr></thead>
  <tbody>${rounds || '<tr><td colspan=4 class="empty">belum ada round</td></tr>'}</tbody></table>`;
}

function calcSection(chain, L) {
  const poolP = L?.totals?.principal ? Number(L.totals.principal) : 0;
  const rows = [0.001, 0.01, 0.1, 0.5, 1, 5, 20].map(v => {
    const e = estimate(chain, poolP || 218092214228, Math.round(v * DEC));
    return `<tr><td class="num">${v}</td>
    <td class="num">${e ? fx(Math.round(e.net)) : '—'}</td>
    <td class="num red">${e ? fx(Math.round(e.perDay)) : '—'}</td>
    <td class="num">${e ? fx(Math.round(e.perWeek)) : '—'}</td>
    <td class="num">${e ? fx(Math.round(e.perMonth)) : '—'}</td></tr>`;
  }).join('');
  return `
  <h2>Estimasi Earnings <span class="live">● LIVE</span></h2>
  <div class="sub">round #${chain?.round ?? '—'} · guideline ${chain ? fx(chain.guideline) : '—'} RESET/round · pool principal ${poolP ? fx(poolP) : 'belum ada (baseline network)'} · fee tier sudah dipotong</div>
  <table><thead><tr><th class="num">Deposit</th><th class="num">Net/round</th><th class="num">/hari</th><th class="num">/minggu</th><th class="num">/bulan</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div class="sub">Yield turun kalau total deposit network naik. Bukan janji hasil.</div>`;
}

function page(d) {
  const c = d.chain || {};
  const L = d.ledger;
  const t = L?.totals;
  const owed = t ? Number(t.principal) + Number(t.earningsOwed) + Number(t.dust) : null;
  const solv = (d.poolBal != null && owed != null) ? d.poolBal - owed : null;
  const badges = [
    POOL_WALLET ? `<span class="badge ok">pool wallet set</span>` : `<span class="badge warn">⏳ belum deploy</span>`,
    c.round != null ? `<span class="badge">round #${c.round}</span>` : '',
    c.windowOpen != null ? `<span class="badge ${c.windowOpen ? 'ok' : 'warn'}">window ${c.windowOpen ? 'OPEN' : 'closed'}</span>` : '',
  ].join(' ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>RESET POOL — poolreset.bond</title>
<link rel="icon" type="image/png" href="/assets/trac-favicon.png">
<link rel="apple-touch-icon" href="/assets/trac-favicon.png">
<style>
:root{
  --bg:#0e1416; --bg2:#12191c; --card:rgba(234,91,100,.045); --card2:rgba(255,255,255,.02);
  --line:rgba(234,91,100,.16); --line2:rgba(233,233,235,.07);
  --txt:#e9e9eb; --dim:#8a9098; --red:#ea5b64; --red2:#ff8a91; --red-glow:rgba(234,91,100,.35);
  --ok:#5fd39a; --warn:#f0b64c;
}
*{box-sizing:border-box;margin:0}
body{
  background:
    radial-gradient(1100px 500px at 85% -10%, rgba(234,91,100,.13), transparent 60%),
    radial-gradient(900px 420px at -10% 110%, rgba(234,91,100,.07), transparent 55%),
    var(--bg);
  color:var(--txt); font:14px/1.55 ui-monospace,'JetBrains Mono',Menlo,monospace;
  padding:20px; max-width:1000px; margin:0 auto; min-height:100vh;
}
h1{font-size:21px;letter-spacing:.5px;display:flex;align-items:center;gap:10px}
h1 .tag{font-size:10px;letter-spacing:2px;color:var(--red);border:1px solid var(--line);border-radius:99px;padding:3px 10px;background:var(--card);text-transform:uppercase}
h2{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:2px;margin:28px 0 10px;display:flex;align-items:center;gap:8px}
h2::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}
.sub{color:var(--dim);font-size:12px;margin:6px 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.card{
  background:linear-gradient(160deg,var(--card),var(--card2));
  border:1px solid var(--line); border-radius:14px; padding:14px 16px;
  backdrop-filter:blur(6px); transition:border-color .2s, transform .2s;
}
.card:hover{border-color:rgba(234,91,100,.45); transform:translateY(-1px)}
.card.glow{box-shadow:0 0 24px rgba(234,91,100,.12), inset 0 1px 0 rgba(255,255,255,.06); border-color:rgba(234,91,100,.35)}
.label{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:1.4px}
.big{font-size:17px;margin-top:5px;font-weight:600;text-shadow:0 0 18px rgba(234,91,100,.25)}
.big.red{color:var(--red2)}
.unit{font-size:11px;color:var(--dim);font-weight:400}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card2);border:1px solid var(--line2);border-radius:12px;overflow:hidden;margin-bottom:6px}
th,td{padding:8px 12px;border-bottom:1px solid var(--line2);text-align:left;font-size:12.5px}
tr:last-child td{border-bottom:none}
th{color:var(--red2);background:rgba(234,91,100,.07);text-transform:uppercase;font-size:10px;letter-spacing:1.2px}
tbody tr:hover td{background:rgba(234,91,100,.05)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.red{color:var(--red2)} .red{color:var(--red2)} .ok{color:var(--ok)} .dim{color:var(--dim)}
code{color:var(--red2);font-size:12px;background:rgba(234,91,100,.08);padding:1px 6px;border-radius:6px}
.empty{color:var(--warn);padding:16px;text-align:center;font-size:12.5px}
.badge{display:inline-block;padding:3px 12px;border-radius:99px;font-size:11px;border:1px solid var(--line);background:var(--card);margin-right:6px;color:var(--txt)}
.badge.ok{color:var(--ok);border-color:rgba(95,211,154,.4)}
.badge.warn{color:var(--warn);border-color:rgba(240,182,76,.4)}
.live{color:var(--red);font-size:10px;letter-spacing:1px;animation:pulse 1.6s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.err{color:var(--bad);font-size:11px;margin-top:12px}
.kv{display:grid;grid-template-columns:220px 1fr;gap:5px 16px;background:linear-gradient(160deg,var(--card),var(--card2));border:1px solid var(--line);border-radius:14px;padding:14px 16px;font-size:12.5px}
.kv .k{color:var(--dim)}
a{color:var(--red2);text-decoration:none;border-bottom:1px dotted rgba(234,91,100,.4)}
a:hover{border-bottom-style:solid}
footer{margin-top:34px;color:var(--dim);font-size:11px;text-align:center;padding-top:16px;border-top:1px solid var(--line2)}
</style></head><body>
<h1><img src="/assets/trac-favicon.png" style="width:24px;height:24px">RESET POOL <span class="tag">on TRAC</span></h1>
<div class="sub">poolreset.bond · fair-share pool buat deposit &lt; 0.1 RESET · fee 10/5/2/0% dari earnings saja · principal balik utuh</div>
<div>${badges}</div>

<h2>Chain — Live</h2>
<div class="grid">
  <div class="card"><div class="label">BTC Tip</div><div class="big">${c.tip ?? '—'}</div></div>
  <div class="card"><div class="label">Counted</div><div class="big">${c.counted ?? '—'}</div></div>
  <div class="card glow"><div class="label">Round</div><div class="big red">#${c.round ?? '—'}</div></div>
  <div class="card"><div class="label">Sisa round</div><div class="big">${c.blocksLeftInRound ?? '—'} <span class="unit">blk</span></div></div>
  <div class="card"><div class="label">Claim window</div><div class="big" style="font-size:13px">${c.windowOpen ? '<span class="ok">OPEN</span> · ~' + (c.blocksToClaimEnd ?? '?') + ' blk' : '<span class="dim">closed</span>'}</div></div>
  <div class="card"><div class="label">Guideline/round</div><div class="big">${c.guideline != null ? fx(c.guideline) : '—'}</div></div>
  <div class="card"><div class="label">Claims ronde ini</div><div class="big">${c.claimCount ?? '—'}</div></div>
  <div class="card"><div class="label">Total deposit Mine</div><div class="big">${c.claimDeposit != null ? fx(c.claimDeposit) : '—'}</div></div>
</div>

<h2>Pool Wallet &amp; Solvency</h2>
<div class="kv">
  <div class="k">Pool wallet (deposit)</div><div><code>${POOL_WALLET ? short(POOL_WALLET, 20) : '⏳ di-set saat deploy'}</code></div>
  <div class="k">Balance on-chain</div><div>${d.poolBal != null ? f8(d.poolBal) + ' RESET' : '—'}</div>
  <div class="k">Fee receiver</div><div><code>${short(FEE_WALLET, 20)}</code></div>
  <div class="k">Utang ledger</div><div>${owed != null ? f8(owed) + ' RESET' : '—'}</div>
  <div class="k">Solvency margin</div><div>${solv != null ? (solv >= 0 ? '<span class="ok">✅ +' : '<span class="red">❌ </span>') + f8(Math.abs(solv)) + '</span>' : '—'}</div>
</div>

<h2>Ledger Pool</h2>
${ledgerSection(L)}

${calcSection(c, L)}

<h2>Fee Tiers</h2>
${tierTable()}
<div class="sub">Fee hanya dari earnings — principal tidak pernah terpotong. Rate ngikutin principal kamu sendiri.</div>

<h2>Cara Join</h2>
<div class="kv">
  <div class="k">1 · Siapkan wallet</div><div>RESET wallet + ~0.15 TNK fee transaksi (min deposit <b>0.001 RESET</b>)</div>
  <div class="k">2 · Clone kontrak</div><div><code>git clone ${REPO}</code> · verifikasi md5 sesuai README</div>
  <div class="k">3 · Register + prove</div><div><code>member_register</code> + <code>sign_challenge</code> lewat agent/peer kamu</div>
  <div class="k">4 · Deposit</div><div>Kirim RESET ke pool wallet → lapor txRef → credited otomatis</div>
  <div class="k">5 · Pantau</div><div>Live di sini atau dari peer kamu sendiri (ledger tereplikasi)</div>
  <div class="k">Docs</div><div><a href="${REPO}/blob/main/TUTORIAL.md">TUTORIAL</a> · <a href="${REPO}/blob/main/EXPLAINER.md">EXPLAINER</a> · <a href="${REPO}/blob/main/SECURITY-AUDIT.md">SECURITY-AUDIT</a></div>
</div>

<h2>Auditable</h2>
<div class="sub">Kontrak adversarially tested — 64 checks · settlement math 17 tests + 500-case property sweep · semua member pegang salinan ledger · <a href="${REPO}">github.com/Juujuarch/reset-pool</a></div>

${d.errors.length ? `<div class="err">${d.errors.map(e => '· ' + e).join('<br>')}</div>` : ''}
<footer>poolreset.bond · updated ${d.ts} · auto-refresh 60s · pool independen, bukan site resmi RESET · <a href="${REPO}">source</a></footer>
<script>setTimeout(()=>location.reload(),60000)</script>
</body></html>`;
}

const FAVICON = fs.readFileSync(path.join(__dirname, 'assets', 'trac-favicon.png'));
const server = http.createServer(async (req, res) => {
  if (req.url === '/assets/trac-favicon.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
    return res.end(FAVICON);
  }
  if (req.url === '/api/state') {
    const d = await collect();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(d, (k, v) => typeof v === 'bigint' ? String(v) : v));
  }
  const d = await collect();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(d));
});

server.listen(PORT, HOST, () => console.log(`[pool-dash] TRAC-glossy dashboard on http://${HOST}:${PORT}`));
