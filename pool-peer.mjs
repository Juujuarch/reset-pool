// Reset pool — Intercom subnet peer running PoolProtocol + PoolContract.
//
// DEPLOY REQUIREMENT (confirmed by deep debugging 21 Okt 2026):
// The mainnet MSB writer core is read-only for an unregistered wallet. To run the
// deploy-subnet command, the MSB admin (Trac Systems) must first whitelist this
// peer's MSB address as a writer/indexer — exactly how the intercom-dex deployment
// was done (their servicePeerKey is pre-approved). Contact Trac Systems with the
// MSB address printed at boot after funding.
//
// Sequence once whitelisted:
//   1. node pool-peer.mjs init-admin     (once — fresh store, no admin yet)
//   2. node pool-peer.mjs deploy-subnet  (once — registers the subnet bootstrap on MSB)
//   3. node pool-peer.mjs run            (daemon: serves tx + writes pool-state.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import b4a from 'b4a';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Bare runtime has no `process` — polyfill minimal pieces used here.
if (typeof globalThis.process === 'undefined') {
  globalThis.process = (await import('process')).default ?? { env: {}, argv: [], exit: () => {}, on: () => {} };
}

// Bare runtime has no `process` — no env vars. Config path is fixed for this deployment.
const CONFIG_FILE = path.join(__dirname, 'pool.config.json');

const input = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const REQUIRED = ['environment', 'msbBootstrap', 'msbChannel', 'msbNetworkId', 'msbDhtBootstrap',
  'peerDhtBootstrap', 'subnetChannel', 'storeDirectory'];
for (const f of REQUIRED) if (input[f] === undefined) throw new Error(`pool.json missing "${f}"`);

const command = globalThis.Bare?.argv?.[2] || (typeof process !== 'undefined' ? process.argv[2] : undefined) || 'run';

const { createConfig, ENV, Peer, Wallet } = await import('trac-peer');
const { ensureTextCodecs } = await import('trac-peer/src/textCodec.js');
const { MainSettlementBus } = await import('trac-msb/src/index.js');
const { createConfig: msbConfig, ENV: MSB_ENV } = await import('trac-msb/src/config/env.js');
const PeerWallet = (await import('trac-wallet')).default;
const PoolProtocol = (await import('./contract/protocol.js')).default;
const PoolContract = (await import('./contract/contract.js')).default;

async function until(fn, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, 100));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

async function walletAt(filename, WalletClass, options) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const wallet = new WalletClass(options);
  await wallet.ready;
  if (fs.existsSync(filename)) wallet.importFromFile(filename, b4a.alloc(0));
  else {
    await wallet.generateKeyPair(null, options.derivationPath);
    wallet.exportToFile(filename, b4a.alloc(0));
    fs.chmodSync(filename, 0o600);
  }
  return wallet;
}

const mc = msbConfig(MSB_ENV[(input.environment || 'mainnet').toUpperCase()], {
  bootstrap: input.msbBootstrap, channel: input.msbChannel, dhtBootstrap: input.msbDhtBootstrap,
  storesDirectory: input.storeDirectory, storeName: 'msb', enableInteractiveMode: false,
  enableWallet: true, enableRoleRequester: false, enableValidatorObserver: true, enableTxApplyLogs: false });

await ensureTextCodecs();
if (mc.networkId !== input.msbNetworkId) throw new Error('MSB networkId differs from config');

const msbWalletFile = path.join(input.storeDirectory, 'msb-wallet.json');
const bus = new MainSettlementBus(mc, await walletAt(msbWalletFile, PeerWallet,
  { networkPrefix: mc.addressPrefix, derivationPath: mc.derivationPath }));
await bus.ready();

const pc = createConfig(ENV[(input.environment || 'mainnet').toUpperCase()], {
  storesDirectory: input.storeDirectory, storeName: 'peer', bootstrap: input.subnetBootstrap ?? null,
  channel: input.subnetChannel, dhtBootstrap: input.peerDhtBootstrap, txContentHash: 'utf8-strict',
  enableInteractiveMode: false, replicate: true, enableUpdater: true, enableBackgroundTasks: true,
  enableTxlogs: false, apiMsgExposed: false, apiTxExposed: false });
const peer = new Peer({ config: pc, msb: bus,
  wallet: await walletAt(path.join(input.storeDirectory, 'peer-wallet.json'), Wallet,
    { networkPrefix: mc.addressPrefix, derivationPath: mc.derivationPath }),
  protocol: PoolProtocol, contract: PoolContract });
await peer.ready();
console.log('[pool-peer] subnet peer ready, writable:', peer.base.writable, 'isIndexer:', peer.base.isIndexer);

const stateFile = path.join(__dirname, 'data', 'pool-state.json');
fs.mkdirSync(path.dirname(stateFile), { recursive: true });

if (command === 'init-admin') {
  // Wait for the funded TNK balance to replicate before any admin write —
  // the crash 'preencode null' is a write attempted before getNodeEntry resolves.
  await until(() => bus.state.getNodeEntry(peer.wallet.address), 'peer TNK replicated', 120000);
  const admin = (await peer.base.view.get('admin'))?.value;
  if (admin) throw new Error('Admin already set: ' + admin);
  if (!peer.base.isIndexer) throw new Error('init-admin requires this peer to be the initial indexer');
  const { TerminalHandlers } = await import('trac-peer/src/terminal/handlers.js');
  await new TerminalHandlers(peer).addAdmin(`/add_admin --address ${peer.wallet.publicKey}`);
  await until(async () => (await peer.base.view.get('admin'))?.value === peer.wallet.publicKey, 'admin init');
  console.log('ADMIN_DONE init-admin', peer.wallet.publicKey);
  console.log('SAVE subnetBootstrap:', peer.base.key.toString('hex'));
  process.exit(0);
}

const admin = (await peer.base.view.get('admin'))?.value;
if (admin !== peer.wallet.publicKey) throw new Error(`This peer is not the admin (${admin} vs ${peer.wallet.publicKey})`);

if (command === 'deploy-subnet') {
  const bootstrap = peer.base.key.toString('hex');
  await until(() => bus.state.getNodeEntry(peer.wallet.address), 'admin TNK replicated');
  if (await bus.state.getRegisteredBootstrapEntry(bootstrap)) throw new Error('Subnet already deployed');
  // Exact pattern from RESET runtime admin.js:
  const { applyStateMessageFactory } = await import('trac-msb/src/messages/state/applyStateMessageFactory.js');
  const msg = await applyStateMessageFactory(peer.wallet, bus.config).buildPartialBootstrapDeploymentMessage(
    peer.wallet.address, peer.base.key, peer.config.channel,
    await bus.state.getIndexerSequenceState(), 'json');
  if (!await bus.network.validatorMessageOrchestrator.send(msg)) throw new Error('Subnet deployment rejected');
  await until(() => bus.state.getRegisteredBootstrapEntry(bootstrap), 'subnet deployment');
  console.log('ADMIN_DONE deploy-subnet', bootstrap);
  process.exit(0);
}

if (command !== 'run') throw new Error('Unknown command: ' + command);

console.log('POOL_PEER_READY ' + JSON.stringify({ peerPubkey: peer.wallet.publicKey,
  subnetBootstrap: peer.base.key.toString('hex'), channel: input.subnetChannel }));

let closing = false;
const shutdown = () => { closing = true; peer.close().then(() => process.exit(0), () => process.exit(1)); };
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, shutdown);

// ── state exporter for the dashboard ───────────────────────────────────────
async function exportState() {
  if (closing) return;
  try {
    const view = peer.base.view.checkout(peer.base.view.core.signedLength);
    const totals = (await view.get('totals'))?.value ?? null;
    const memberList = (await view.get('members'))?.value ?? [];
    const counters = (await view.get('counters'))?.value ?? {};
    const members = [];
    for (const m of memberList) {
      const rec = (await view.get('member/' + m))?.value;
      if (rec) members.push({ address: m, ...rec });
    }
    const rounds = [];
    const gwState = await fetch('https://reset.openmayhem.ai/v1/state').then(r => r.json()).catch(() => null);
    const cur = gwState?.mine?.r ?? 0;
    for (let r = Math.max(0, cur - 60); r <= cur; r++) {
      const rd = (await view.get('round/' + r))?.value;
      if (rd?.settled != null) rounds.push({ round: r, amount: rd.settled, fee: rd.fee, dust: rd.dust });
    }
    await view.close();
    const out = { ts: new Date().toISOString(), totals, counters, members, rounds };
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(out));
    fs.renameSync(stateFile + '.tmp', stateFile);
  } catch (e) {
    console.error('[export]', e.message);
  }
}
setInterval(exportState, 30000);
exportState();

await new Promise(() => {});
