// WS-smoke-тест фазы 2: уникальность username, reserved, экономика, подарки, NFT.
// Запуск: node test/economy-test.js  (сервер должен работать на :9173)
const WebSocket = require('ws');
const URL = 'ws://127.0.0.1:9173';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  OK  ' + name); } else { fail++; console.log('  FAIL ' + name); } };

// Надёжный клиент: спонтанные broadcast'ы (chat_list, wallet_update, presence)
// не сбивают очередь — ждём сообщение с нужным типом, остальное буферизуем.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const a = client('alice'); await a.opened;
  const b = client('bob'); await b.opened;
  const o = client('owner'); await o.opened;

  console.log('== Уникальность username / reserved ==');
  const ra = await a.sendExpect({ t: 'register', username: 'alice', nickname: 'Алиса', pubkey: 'pk_a' }, 'registered');
  ok(ra.me.username === 'alice' && ra.me.balance === 700, 'alice registered with 700 stars');
  const rb = await b.sendExpect({ t: 'register', username: 'bob', nickname: 'Боб', pubkey: 'pk_b' }, 'registered');
  ok(rb.me.username === 'bob', 'bob registered');

  const dup = await a.sendExpect({ t: 'register', username: 'alice', nickname: 'Дубль', pubkey: 'pk_x' }, 'error');
  ok(dup.code === 'username_taken', 'dup username rejected');
  const badUser = await a.sendExpect({ t: 'register', username: 'a!b', nickname: 'x', pubkey: 'pk_x' }, 'error');
  ok(badUser.code === 'bad_username', 'invalid chars rejected');

  const collectible = await a.sendExpect({ t: 'register', username: 'duck', nickname: 'Утка', pubkey: 'pk_x' }, 'error');
  ok(collectible.code === 'collectible', 'collectible slug blocked from register');

  const reservedNo = await a.sendExpect({ t: 'register', username: 'strangerezz', nickname: 'x', pubkey: 'pk_x' }, 'error');
  ok(reservedNo.code === 'reserved', 'reserved rejected without owner code');

  const reg = await o.sendExpect({ t: 'register', username: 'strangerezz', nickname: 'Дуров', pubkey: 'pk_o', ownerCode: 'strangerezz-root-7' }, 'registered');
  ok(reg.me.owner === true && reg.me.username === 'strangerezz', 'owner claim with code works');

  const dup2 = await a.sendExpect({ t: 'register', username: 'strangerezz', nickname: 'y', pubkey: 'pk_x' }, 'error');
  ok(dup2.code === 'username_taken', 'reserved-username now taken after owner claim');

  console.log('== Кошелёк и звёзды ==');
  const aw = await a.sendExpect({ t: 'wallet_get' }, 'wallet');
  ok(aw.balance === 700 && Array.isArray(aw.gifts), 'alice starts with 700 stars');

  const cat = await a.sendExpect({ t: 'gifts_catalog' }, 'gifts_catalog');
  ok(cat.gifts.length === 12, 'catalog has 12 gifts');
  const g9 = cat.gifts.find((x) => x.id === 'g9');
  ok(g9.remains === g9.total && g9.upgrade === 2500, 'limited gift g9 full stock + upgrade price');

  console.log('== Покупка / выдача / вывод подарков ==');
  const buy1 = await a.sendExpect({ t: 'gift_buy', giftId: 'g1' }, 'gift_bought');
  ok(buy1.balance === 600, 'buy g1: 700-100=600');
  const buy12 = await a.sendExpect({ t: 'gift_buy', giftId: 'g12' }, 'gift_bought');
  ok(buy12.balance === 599, 'buy g12: 600-1=599');

  const aw1 = await a.sendExpect({ t: 'wallet_get' }, 'wallet');
  ok(aw1.gifts.length === 2, 'alice owns 2 gift copies');

  const g12copy = aw1.gifts.find((x) => x.giftId === 'g12').copy;
  const wd = await a.sendExpect({ t: 'gift_withdraw', copy: g12copy }, 'gift_withdrawn');
  ok(wd.balance === 699, 'withdraw g12 back to 699');

  const send = await a.sendExpect({ t: 'gift_send', giftId: 'g2', toUsername: 'bob' }, 'gift_sent');
  ok(send.balance === 449, 'alice sends g2 (250) -> 449');

  const g2recv = await new Promise((res) => {
    let n = 0;
    const tick = () => {
      const m = b.drainKind('gift_received');
      if (m) return res(m);
      if (++n > 60) return res(null);
      setTimeout(tick, 25);
    };
    tick();
  });
  ok(g2recv && g2recv.bonus === 25 && g2recv.gift.giftId === 'g2', 'bob got gift_received +25 bonus');

  const bo2 = await b.sendExpect({ t: 'wallet_get' }, 'wallet');
  ok(bo2.balance === 725, 'bob balance 700+25=725');

  const noSelf = await b.sendExpect({ t: 'gift_send', giftId: 'g1', toUsername: 'bob' }, 'error');
  ok(noSelf.code === 'self_gift', 'cannot gift yourself');
  const noUser = await a.sendExpect({ t: 'gift_send', giftId: 'g1', toUsername: 'nobody_xyz' }, 'error');
  ok(noUser.code === 'no_user', 'gift to unknown user rejected');

  console.log('== NFT: аукционы / ставки / ошибки ==');
  const nlist = await b.sendExpect({ t: 'nft_list' }, 'nft_list');
  ok(nlist.auctions.length === 3, '3 pool auctions active');
  const rock = nlist.auctions.find((x) => x.slug === 'rock');
  ok(rock && rock.base === 600 && rock.buyNow === 2500, 'rock auction with base+buyNow');

  const bidLo = await b.sendExpect({ t: 'nft_bid', slug: 'rock', amount: 100 }, 'error');
  ok(bidLo.code === 'bid_too_low', 'low bid rejected');

  const bid = await b.sendExpect({ t: 'nft_bid', slug: 'rock', amount: 600 }, 'nft_bid_ok');
  ok(bid.balance === 125 && bid.c.cur === 600, 'bob bids 600 -> 125 left');

  const bid2 = await o.sendExpect({ t: 'nft_bid', slug: 'rock', amount: 650 }, 'nft_bid_ok');
  ok(bid2.balance === 50, 'owner outbids 650 -> 50 left');

  const back = await b.sendExpect({ t: 'wallet_get' }, 'wallet');
  ok(back.balance === 725, 'bob refunded 600 (back to 725)');

  const bn = await b.sendExpect({ t: 'nft_bid', slug: 'rock', amount: 650 }, 'error');
  ok(bn.code === 'bid_too_low', 'must exceed current bid (step +50)');

  const selfBid = await o.sendExpect({ t: 'nft_bid', slug: 'rock', amount: 700 }, 'error');
  ok(selfBid.code === 'no_money', 'broke bidder blocked (pool auction is seller-less)');

  const oBack = await o.sendExpect({ t: 'wallet_get' }, 'wallet');
  ok(oBack.balance === 50, 'owner still 50');

  const bn2 = await a.sendExpect({ t: 'nft_bid', slug: 'rock', amount: 700 }, 'error');
  ok(bn2.code === 'no_money', 'alice (449) cannot bid 700');

  const getTooRich = await a.sendExpect({ t: 'gift_buy', giftId: 'g9' }, 'error');
  ok(getTooRich.code === 'no_money', 'cannot afford limited g9 (1200)');

  const buyN = await o.sendExpect({ t: 'nft_buy_now', slug: 'rock' }, 'error');
  ok(buyN.code === 'no_money', 'buyNow blocked: not enough stars');

  const claimNA = await b.sendExpect({ t: 'nft_claim', slug: 'rock' }, 'error');
  ok(claimNA.code === 'not_yours', 'claim before win rejected');

  const sellNA = await b.sendExpect({ t: 'nft_sell', slug: 'rock' }, 'error');
  ok(sellNA.code === 'not_yours', 'sell without ownership rejected');

  const cancelNA = await b.sendExpect({ t: 'nft_cancel', slug: 'rock' }, 'error');
  ok(cancelNA.code === 'cant_cancel', 'cancel of someone elses auction rejected');

  const badSlug = await o.sendExpect({ t: 'nft_bid', slug: 'nosuch', amount: 10 }, 'error');
  ok(badSlug.code === 'no_nft', 'unknown slug rejected');

  console.log('\n------- РЕЗУЛЬТАТ: ' + pass + ' OK, ' + fail + ' FAIL -------');
  a.close(); b.close(); o.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });