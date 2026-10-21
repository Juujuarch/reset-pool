// RESET POOL — Full dashboard (port 6969).
// Sections: chain state, pool wallet, ledger (members/rounds/fees), economics
// calculator (live guideline), fee tiers, join guide, repo link.
// Ledger data comes from data/pool-state.json written by the operator loop.
// 4747 (mining dashboard) is NOT touched by this service.
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
  try {
    const d = await gw(`/account/${addr}`);
    return d?.balance ?? null;
  } catch { return null; }
}

async function collect() {
  const out = { ts: new Date().toISOString(), errors: [] };
  try {
    const st = await gw('/state');
    const m = st.mine || {};
    out.chain = {
      tip: st.tip?.height, counted: st.counted, round: m.r,
      roundStart: m.start, claimEnd: m.claim_end, roundEnd: m.end,
      windowOpen: !!m.window_open, guideline: m.last_guideline,
      claimCount: m.claim_count, claimDeposit: m.claim_deposit,
      mineCapacity: m.params?.mine_capacity ?? st.capacity_left ?? null,
      blocksLeftInRound: st.tip?.height && m.end ? Math.max(0, m.end - st.tip.height) : null,
      blocksToClaimEnd: st.tip?.height && m.claim_end ? Math.max(0, m.claim_end - st.tip.height) : null,
      emissionPerRound: 3.125,
    };
  } catch (e) { out.errors.push('chain: ' + e.message); }
  if (POOL_WALLET) {
    out.poolBal = await walletBalance(POOL_WALLET);
  }
  try { out.ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')); } catch { out.ledger = null; }
  return out;
}

// ── live economics: estimate pool share & member yield from live guideline ──
function estimate(chain, poolPrincipalUnits, memberPrincipalUnits) {
  if (!chain?.guideline || !poolPrincipalUnits || !memberPrincipalUnits) return null;
  // guideline = total mine payout per round (raw units) when window fully subscribed
  const gross = Number(BigInt(chain.guideline) * BigInt(memberPrincipalUnits) / BigInt(poolPrincipalUnits));
  const feeBps = memberPrincipalUnits >= 20 * DEC ? 0 : memberPrincipalUnits >= 5 * DEC ? 200 : memberPrincipalUnits >= 1 * DEC ? 500 : 1000;
  const net = gross * (1 - feeBps / 10000);
  return { gross, net, feeBps, roundsPerDay: 24, perDay: net * 24, perWeek: net * 24 * 7, perMonth: net * 24 * 30 };
}

function tierTable() {
  return `<table><thead><tr><th>Principal kamu</th><th>Fee earnings</th></tr></thead><tbody>
  <tr><td>&lt; 1 RESET</td><td class="num">10%</td></tr>
  <tr><td>1 – 5 RESET</td><td class="num">5%</td></tr>
  <tr><td>5 – 20 RESET</td><td class="num">2%</td></tr>
  <tr><td>≥ 20 RESET</td><td class="num">0%</td></tr>
  <tr><td>⭐ Staker (whitelisted, ≥ 0.5)</td><td class="num">0% + 50% bagan fee</td></tr>
  </tbody></table>`;
}

function ledgerSection(L) {
  if (!L) return `<div class="empty">Ledger belum aktif — kontrak belum di-deploy. Data muncul otomatis setelah claim loop jalan.</div>`;
  const t = L.totals || {};
  const members = (L.members || []).slice().sort((a, b) => Number(b.principal) - Number(a.principal));
  const rows = members.map(m => `<tr>
    <td><code>${short(m.address)}</code></td>
    <td class="num">${f8(m.principal)}</td>
    <td class="num">${f8(m.earnings)}</td>
    <td>${m.staker ? '⭐' : 'member'}</td>
    <td>${Number(m.exiting) > 0 ? f8(m.exiting) : '—'}</td></tr>`).join('');
  const rounds = (L.rounds || []).slice(-24).reverse().map(r => `<tr>
    <td>#${r.round}</td><td class="num">${f8(r.amount)}</td><td class="num">${f8(r.fee || 0)}</td><td class="num">${f8(r.dust || 0)}</td></tr>`).join('');
  return `
  <div class="grid">
    <div class="card"><div class="label">Total Principal</div><div class="big">${fx(t.principal)} RESET</div></div>
    <div class="card"><div class="label">Earnings Owed</div><div class="big">${fx(t.earningsOwed)}</div></div>
    <div class="card"><div class="label">Fees Accrued</div><div class="big">${fx(t.feesAccrued)}</div></div>
    <div class="card"><div class="label">Fees Swept</div><div class="big">${fx(t.feesSwept)}</div></div>
    <div class="card"><div class="label">Dust</div><div class="big">${fx(t.dust)}</div></div>
    <div class="card"><div class="label">Members</div><div class="big">${members.length}</div></div>
  </div>
  <h2>Members</h2>
  <table><thead><tr><th>Address</th><th>Principal</th><th>Earnings</th><th>Role</th><th>Exit</th></tr></thead>
  <tbody>${rows || '<tr><td colspan=5 class="empty">belum ada member</td></tr>'}</tbody></table>
  <h2>Rounds Settled</h2>
  <table><thead><tr><th>Round</th><th>Payout</th><th>Fee</th><th>Dust</th></tr></thead>
  <tbody>${rounds || '<tr><td colspan=4 class="empty">belum ada round</td></tr>'}</tbody></table>`;
}

function calcSection(chain, L) {
  const poolP = L?.totals?.principal ? Number(L.totals.principal) : 0;
  const presets = [0.001, 0.01, 0.1, 0.5, 1, 5, 20];
  const rows = presets.map(v => {
    const e = estimate(chain, poolP || 218092214228, Math.round(v * DEC)); // fallback: live network claim_deposit
    return `<tr><td class="num">${v}</td>
    <td class="num">${e ? fx(Math.round(e.net)) : '—'}</td>
    <td class="num">${e ? fx(Math.round(e.perDay)) : '—'}</td>
    <td class="num">${e ? fx(Math.round(e.perWeek)) : '—'}</td>
    <td class="num">${e ? fx(Math.round(e.perMonth)) : '—'}</td></tr>`;
  }).join('');
  return `
  <h2>Estimasi Earnings (live, round #${chain?.round ?? '—'})</h2>
  <div class="sub">baseline: guideline ${chain ? fx(chain.guideline) : '—'} RESET/round · pool principal ${poolP ? fx(poolP) : 'belum ada (pakai total network)'} · ${chain?.windowOpen ? 'window OPEN' : 'window closed'}</div>
  <table><thead><tr><th>Deposit</th><th>Net/round</th><th>/hari</th><th>/minggu</th><th>/bulan</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div class="sub">Estimasi pakai guideline live dan share pro-rata; fee tier sudah dipotong. Bukan janji hasil — yield turun kalau total deposit network naik.</div>`;
}

function page(d) {
  const c = d.chain || {};
  const L = d.ledger;
  const t = L?.totals;
  const owed = t ? Number(t.principal) + Number(t.earningsOwed) + Number(t.dust) : null;
  const solv = (d.poolBal != null && owed != null) ? d.poolBal - owed : null;
  const badges = [
    POOL_WALLET ? `<span class="badge b-ok">pool wallet set</span>` : `<span class="badge b-warn">⏳ belum deploy</span>`,
    c.round != null ? `<span class="badge b-ok">round #${c.round}</span>` : '',
    c.windowOpen != null ? `<span class="badge ${c.windowOpen ? 'b-ok' : 'b-warn'}">window ${c.windowOpen ? 'OPEN' : 'closed'}</span>` : '',
    c.blocksToClaimEnd != null ? `<span class="badge">claim ends in ~${c.blocksToClaimEnd} block</span>` : '',
  ].join(' ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>RESET POOL — poolreset.bond</title>
<link rel="icon" type="image/png" href="/assets/trac-favicon.png">
<link rel="apple-touch-icon" href="/assets/trac-favicon.png">
<style>
:root{--bg:#0b0e14;--card:#131824;--line:#232b3d;--txt:#e6ebf4;--dim:#8b95a9;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--acc:#5eead4}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--txt);font:14px/1.55 ui-monospace,'JetBrains Mono',Menlo,monospace;padding:20px;max-width:1000px;margin:0 auto}
h1{font-size:20px;letter-spacing:.5px}h2{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin:26px 0 8px}
.sub{color:var(--dim);font-size:12px;margin:6px 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.label{color:var(--dim);font-size:10.5px;text-transform:uppercase;letter-spacing:1px}
.big{font-size:16.5px;margin-top:4px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:6px}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;font-size:12px}
th{color:var(--dim);text-transform:uppercase;font-size:10px;letter-spacing:1px}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
code{color:var(--acc);font-size:12px}
.empty{color:var(--warn);padding:14px;text-align:center}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;font-size:11px;border:1px solid;margin-right:6px}
.b-ok{color:var(--ok);border-color:var(--ok)}.b-warn{color:var(--warn);border-color:var(--warn)}
.err{color:var(--bad);font-size:11px;margin-top:12px}
.kv{display:grid;grid-template-columns:210px 1fr;gap:4px 14px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:12.5px}
.kv .k{color:var(--dim)}
a{color:var(--acc)}
footer{margin-top:30px;color:var(--dim);font-size:11px;text-align:center}
</style></head><body>
<h1><img src="/assets/trac-favicon.png" style="width:22px;height:22px;vertical-align:-4px;margin-right:8px">⛏️ RESET POOL</h1>
<div class="sub">poolreset.bond · fair-share pool buat deposit &lt; 0.1 RESET · fee 10/5/2/0% dari earnings saja · principal balik utuh</div>
<div>${badges}</div>

<h2>Chain (live)</h2>
<div class="grid">
  <div class="card"><div class="label">BTC Tip</div><div class="big">${c.tip ?? '—'}</div></div>
  <div class="card"><div class="label">Counted</div><div class="big">${c.counted ?? '—'}</div></div>
  <div class="card"><div class="label">Round</div><div class="big">#${c.round ?? '—'}</div></div>
  <div class="card"><div class="label">Block sisa round</div><div class="big">${c.blocksLeftInRound ?? '—'}</div></div>
  <div class="card"><div class="label">Claim window</div><div class="big" style="font-size:13px">${c.windowOpen ? 'OPEN · sisa ~' + (c.blocksToClaimEnd ?? '?') + ' blk' : 'closed'}</div></div>
  <div class="card"><div class="label">Guideline/round</div><div class="big">${c.guideline != null ? fx(c.guideline) : '—'}</div></div>
  <div class="card"><div class="label">Claims ronde ini</div><div class="big">${c.claimCount ?? '—'}</div></div>
  <div class="card"><div class="label">Total deposit Mine</div><div class="big">${c.claimDeposit != null ? fx(c.claimDeposit) : '—'}</div></div>
</div>

<h2>Pool Wallet & Solvency</h2>
<div class="kv">
  <div class="k">Pool wallet (deposit)</div><div><code>${POOL_WALLET ? short(POOL_WALLET, 20) : '⏳ di-set saat deploy'}</code></div>
  <div class="k">Balance on-chain</div><div>${d.poolBal != null ? f8(d.poolBal) + ' RESET' : '—'}</div>
  <div class="k">Fee receiver</div><div><code>${short(FEE_WALLET, 20)}</code></div>
  <div class="k">Utang ledger (principal+earnings+dust)</div><div>${owed != null ? f8(owed) + ' RESET' : '—'}</div>
  <div class="k">Solvency margin</div><div>${solv != null ? (solv >= 0 ? '✅ +' : '❌ ') + f8(solv) : '—'}</div>
</div>

<h2>Ledger Pool</h2>
${ledgerSection(L)}

${calcSection(c, L)}

<h2>Fee Tiers</h2>
${tierTable()}
<div class="sub">Fee hanya dari earnings — principal tidak pernah terpotong. Rate ngikutin principal kamu sendiri, bukan total pool.</div>

<h2>Cara Join</h2>
<div class="kv">
  <div class="k">1. Siapkan wallet</div><div>RESET wallet + ~0.15 TNK untuk fee transaksi (min deposit <b>0.001 RESET</b>)</div>
  <div class="k">2. Clone kontrak</div><div><code>git clone ${REPO}</code> · verifikasi md5 sesuai README</div>
  <div class="k">3. Register + prove</div><div><code>member_register</code> + <code>sign_challenge</code> lewat agent/peer kamu</div>
  <div class="k">4. Deposit</div><div>Kirim RESET ke pool wallet → lapor txRef → credited otomatis</div>
  <div class="k">5. Pantau</div><div>Balance live di sini atau dari peer kamu sendiri (ledger tereplikasi)</div>
  <div class="k">Full guide</div><div><a href="${REPO}/blob/main/TUTORIAL.md">TUTORIAL.md</a> · <a href="${REPO}/blob/main/EXPLAINER.md">EXPLAINER.md</a> · <a href="${REPO}/blob/main/SECURITY-AUDIT.md">SECURITY-AUDIT.md</a></div>
</div>

<h2>Auditable</h2>
<div class="sub">Kontrak adversarially tested (64 checks) · settlement math 17 unit tests + 500-case property sweep · semua member pegang salinan ledger · <a href="${REPO}">repo: github.com/Juujuarch/reset-pool</a></div>

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

server.listen(PORT, HOST, () => console.log(`[pool-dash] full dashboard on http://${HOST}:${PORT}`));
