// RESET Pool Dashboard — operator-facing pool stats on :6969.
// Reads live data from the RESET gateway + pool ledger state files.
// Does NOT touch the mining dashboard on :4747.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.POOL_DASH_PORT || 6969;
const HOST = process.env.POOL_DASH_HOST || '0.0.0.0';
// Pool ledger JSON produced by the operator claim loop. Created lazily.
const LEDGER_FILE = process.env.POOL_LEDGER_FILE || path.join(__dirname, 'data', 'pool-state.json');
const GATEWAY = process.env.RESET_GATEWAY || 'https://reset.openmayhem.ai/v1';
const POOL_WALLET = process.env.POOL_WALLET_ADDRESS || ''; // 64-hex, set after deploy

const DEC = 1e8; // 8-decimal base units → RESET
const fmt = (units) => (Number(units || 0) / DEC).toFixed(8).replace(/\.?0+$/, m => m.includes('.') ? m : m);
const f8 = (units) => (Number(units || 0) / DEC).toFixed(8);

async function gatewayGet(p) {
  const res = await fetch(`${GATEWAY}${p}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  return res.json();
}

async function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function collect() {
  const out = { ts: new Date().toISOString(), gateway: null, ledger: null, errors: [] };
  // Chain-side: pool wallet balance + current mine round (same endpoints the mining dash uses).
  if (POOL_WALLET) {
    try { out.gateway = await gatewayGet(`/account/${POOL_WALLET}`); }
    catch (e) { out.errors.push(`account: ${e.message}`); }
  } else {
    out.errors.push('POOL_WALLET_ADDRESS not set yet (contract not deployed)');
  }
  try {
    const st = await gatewayGet('/state');
    out.round = st?.mine?.round ?? null;
    out.windowOpen = st?.mine?.window_open ?? null;
  } catch (e) { out.errors.push(`state: ${e.message}`); }
  out.ledger = await loadLedger();
  return out;
}

function renderLedger(L) {
  if (!L) {
    return `<div class="empty">Ledger belum tersedia — kontrak belum di-deploy / claim loop belum jalan.<br>
    File yang ditunggu: <code>${LEDGER_FILE}</code></div>`;
  }
  const t = L.totals || {};
  const members = (L.members || []).slice().sort((a, b) => Number(b.principal) - Number(a.principal));
  const rows = members.map(m => `
    <tr>
      <td><code>${String(m.address || '').slice(0, 16)}…</code></td>
      <td class="num">${f8(m.principal)}</td>
      <td class="num">${f8(m.earnings)}</td>
      <td>${m.staker ? '⭐ staker' : 'member'}</td>
      <td>${m.exiting > 0 ? `exit ${f8(m.exiting)}` : '—'}</td>
    </tr>`).join('');
  return `
  <div class="grid">
    <div class="card"><div class="label">Total Principal</div><div class="big">${f8(t.principal)} RESET</div></div>
    <div class="card"><div class="label">Earnings Owed</div><div class="big">${f8(t.earningsOwed)}</div></div>
    <div class="card"><div class="label">Fees Accrued</div><div class="big">${f8(t.feesAccrued)}</div></div>
    <div class="card"><div class="label">Fees Swept</div><div class="big">${f8(t.feesSwept)}</div></div>
    <div class="card"><div class="label">Dust</div><div class="big">${f8(t.dust)}</div></div>
    <div class="card"><div class="label">Members</div><div class="big">${members.length}</div></div>
  </div>
  <h2>Members</h2>
  <table><thead><tr><th>Address</th><th>Principal</th><th>Earnings</th><th>Role</th><th>Exit</th></tr></thead>
  <tbody>${rows || '<tr><td colspan=5 class="empty">belum ada member</td></tr>'}</tbody></table>
  ${L.rounds ? `<h2>Rounds Settled (${L.rounds.length})</h2>
  <table><thead><tr><th>Round</th><th>Payout</th><th>Fee</th><th>Dust</th></tr></thead><tbody>
  ${L.rounds.slice(-20).reverse().map(r => `<tr><td>#${r.round}</td><td class="num">${f8(r.amount)}</td><td class="num">${f8(r.fee || 0)}</td><td class="num">${f8(r.dust || 0)}</td></tr>`).join('')}
  </tbody></table>` : ''}`;
}

function page(d) {
  const bal = d.gateway?.balance ?? null;
  const led = d.ledger?.totals;
  const solvency = (bal != null && led) ? (Number(bal) - (Number(led.principal) + Number(led.earningsOwed) + Number(led.dust))) : null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>RESET POOL — poolreset.bond</title>
<link rel="icon" type="image/png" href="/assets/trac-favicon.png">
<link rel="apple-touch-icon" href="/assets/trac-favicon.png">
<style>
:root{--bg:#0b0e14;--card:#131824;--line:#232b3d;--txt:#e6ebf4;--dim:#8b95a9;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--acc:#5eead4}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--txt);font:14px/1.5 ui-monospace,'JetBrains Mono',Menlo,monospace;padding:20px;max-width:960px;margin:0 auto}
h1{font-size:20px;letter-spacing:.5px}h2{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;margin:24px 0 8px}
.sub{color:var(--dim);font-size:12px;margin:4px 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.label{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:1px}
.big{font-size:17px;margin-top:4px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;font-size:12px}
th{color:var(--dim);text-transform:uppercase;font-size:10px;letter-spacing:1px}
td.num{text-align:right;font-variant-numeric:tabular-nums}
code{color:var(--acc)}
.empty{color:var(--warn);padding:14px;text-align:center}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;font-size:11px;border:1px solid}
.b-ok{color:var(--ok);border-color:var(--ok)}.b-warn{color:var(--warn);border-color:var(--warn)}.b-bad{color:var(--bad);border-color:var(--bad)}
.err{color:var(--bad);font-size:11px;margin-top:12px}
footer{margin-top:28px;color:var(--dim);font-size:11px;text-align:center}
</style></head><body>
<h1><img src="/assets/trac-favicon.png" style="width:22px;height:22px;vertical-align:-4px;margin-right:8px">⛏️ RESET POOL</h1>
<div class="sub">poolreset.bond · fair-share mining pool untuk deposit &lt; 0.1 RESET · fee 10/5/2/0% earnings only</div>
<div>
  <span class="badge ${POOL_WALLET ? 'b-ok' : 'b-warn'}">${POOL_WALLET ? 'POOL WALLET SET' : 'BELUM DEPLOY'}</span>
  ${d.round != null ? `<span class="badge b-ok">round #${d.round}</span>` : ''}
  ${d.windowOpen != null ? `<span class="badge ${d.windowOpen ? 'b-ok' : 'b-warn'}">claim window ${d.windowOpen ? 'OPEN' : 'closed'}</span>` : ''}
</div>
<h2>Chain</h2>
<div class="grid">
  <div class="card"><div class="label">Pool Wallet Balance</div><div class="big">${bal != null ? f8(bal) : '—'} RESET</div></div>
  <div class="card"><div class="label">Solvency Margin</div><div class="big">${solvency != null ? f8(solvency) : '—'}</div></div>
  <div class="card"><div class="label">Gateway</div><div class="big" style="font-size:12px">${d.errors.some(e=>e.includes('gateway')||e.includes('state')) ? '⚠ unreachable' : '✓ ' + new URL(GATEWAY).host}</div></div>
</div>
<h2>Ledger</h2>
${renderLedger(d.ledger)}
${d.errors.length ? `<div class="err">${d.errors.map(e=>'· '+e).join('<br>')}</div>` : ''}
<footer>ledger: <code>${path.basename(LEDGER_FILE)}</code> · updated ${d.ts} WIB-ish (server UTC) · bukan site resmi RESET — pool independen</footer>
<script>setTimeout(()=>location.reload(),60000)</script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/assets/trac-favicon.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
    return res.end(fs.readFileSync(path.join(__dirname, 'assets', 'trac-favicon.png')));
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

server.listen(PORT, HOST, () => console.log(`[pool-dash] listening on http://${HOST}:${PORT}`));
