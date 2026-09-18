// Успешный E2E NFT: ставка → победа на аукционе → claim вывод в username.
// Сам поднимает сервер на :9174 с коротким раундом аукциона (2с) и
// отдельной tmp-БД (env уже читается сервером); :9173 не трогаем.
// Запуск: node test/nft-claim-test.js
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL = 'ws://127.0.0.1:9174';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  OK  ' + n); } else { fail++; console.log('  FAIL ' + n); } };

function client(name) {
  const ws = new WebSocket(URL);
  const waiters = [];
  let buf = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const wi = waiters.findIndex((w) => !w.t || m.t === w.t);
    if (wi >= 0) { const w = waiters.splice(wi, 1)[0]; w.res(m); }
    else buf.push(m);
  });
  return {
    ws,
    opened: new Promise((res) => ws.once('open', res)),
    sendExpect(o, t) {
      return new Promise((res) => { waiters.push({ t, res }); ws.send(JSON.stringify(o)); });
    },
    send(o) { ws.send(JSON.stringify(o)); },
    drainKind(t) {
      const i = buf.findIndex((m) => m.t === t);
      if (i >= 0) return buf.splice(i, 1)[0];
      return null;
    },
    close() { ws.close(); },
  };
}



async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durov-claim-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: '9174',
      DUROV_DATA_DIR: dataDir,
      DUROV_AUCTION_ROUND_SECONDS: '2',
      DUROV_AUCTION_TICK_MS: '500',
      OWNER_CODE: 'test-owner',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await new Promise((r) => setTimeout(r, 800));

  try {
    const w = client('claimbob'); await w.opened;

  console.log('== Регистрация ==');
  const reg = await w.sendExpect({ t: 'register', username: 'claimbob', nickname: 'КлеймБоб', pubkey: 'pk_cb' }, 'registered');
  ok(reg.me.username === 'claimbob' && reg.me.balance === 700, 'claimbob registered with 700 stars');

  console.log('== NFT: ставка → победа → вывод ==');
  const list = await w.sendExpect({ t: 'nft_list' }, 'nft_list');
  const aList = list.auctions || [];
  const auction = aList.find((x) => x.slug === 'rock') || aList[0];
  ok(!!auction, 'eсть активный аукцион (rock)');
  const base = Number(auction.base);

  const bid = await w.sendExpect({ t: 'nft_bid', slug: auction.slug, amount: base }, 'nft_bid_ok');
  ok(bid.slug === auction.slug && bid.balance === 700 - base, 'ставка ' + base + ' stars принята');

  console.log('== Ждём победы на аукционе (short round 5s) ==');
  const won = await new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const m = w.drainKind('nft_won');
      if (m) return res(m);
      if (Date.now() - t0 > 9000) return res(null);
      setTimeout(tick, 200);
    };
    tick();
  });
  ok(!!won && won.slug === auction.slug, 'выиграли аукцион: ' + auction.slug);

  const claim = await w.sendExpect({ t: 'nft_claim', slug: auction.slug }, 'nft_claimed');
  ok(!!claim && claim.username === auction.slug, 'NFT-username выведен в username: @' + auction.slug);
  ok(claim.me && claim.me.username === auction.slug, 'профиль обновлён на выведенный username');

  const bal = await w.sendExpect({ t: 'wallet_get' }, 'wallet');
  ok(bal.balance === 700 - base, 'баланс после claim: ' + (700 - base) + ' stars');

  console.log('========== ВСЕ СЦЕНАРИИ ПРОЙДЕНЫ ==========');
    w.close();
  } catch (e) {
    fail++;
    console.log('  FAIL исключение: ' + (e && e.message));
  } finally {
    child.kill('SIGKILL');
  }
  console.log('\n------- РЕЗУЛЬТАТ: ' + pass + ' OK, ' + fail + ' FAIL -------');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
