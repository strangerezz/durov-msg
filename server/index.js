const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const db = require('./db');
const items = require('./items');

const PORT = process.env.PORT || 9173;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Секретный код владельца: позволяет занять зарезервированный юзернейм
// (по умолчанию — 'strangerezz'). Поменяй на свой и держи в тайне.
const OWNER_CODE = process.env.OWNER_CODE || 'strangerezz-root-7';

db.init();

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 * 1024 });

// ---------- server secret + signed tokens ----------
const SECRET_FILE = path.join(db.DATA_DIR, 'server.secret');
function loadSecret() {
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

const sessionByUid = new Map(); // uid -> set of sockets
const sockets = new Map(); // socketId -> { ws, uid, room: null }

// ---------- helpers ----------
function sendTo(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastTo(uidVal, obj) {
  const set = sessionByUid.get(uidVal);
  if (!set) return;
  for (const ws of set) sendTo(ws, obj);
}

function broadcastUnread(uidVal, chatId, n) {
  broadcastTo(uidVal, { t: 'unread_update', chatId, unread: n });
}

function onlineInRoom(uidVal, chatId) {
  const set = sessionByUid.get(uidVal);
  if (!set) return false;
  for (const ws of set) {
    const rec = sockets.get(ws._id);
    if (rec && rec.room === chatId) return true;
  }
  return false;
}

function chatBroadcast(chatId, obj, exceptUid) {
  const chat = db.getChat(chatId);
  if (!chat) return;
  for (const m of chat.members) {
    if (m === exceptUid) continue;
    broadcastTo(m, obj);
  }
}

function canAccess(uidVal, chatId) {
  const chat = db.getChat(chatId);
  if (!chat) return null;
  return chat.members.includes(uidVal) ? chat : null;
}

function presence(uidVal) {
  const set = sessionByUid.get(uidVal);
  const online = !!(set && set.size > 0);
  return { uid: uidVal, online, lastSeen: online ? Date.now() : db.getUser(uidVal)?.lastSeen };
}

// ---------- auth via signed tokens ----------
function sign(uidVal) {
  return crypto.createHmac('sha256', SECRET).update(uidVal).digest('base64url');
}

function tokenFor(uidVal) {
  // uid.payload.signature — подпись HMAC-SHA256(uid), подделать без секрета нельзя
  return Buffer.from(uidVal, 'utf8').toString('base64url') + '.' + sign(uidVal);
}

function uidFromToken(token) {
  try {
    const dot = String(token).indexOf('.');
    if (dot < 0) return null; // старые/вшивые токены больше не принимаем
    const uidVal = Buffer.from(String(token).slice(0, dot), 'base64url').toString('utf8');
    const sig = String(token).slice(dot + 1);
    if (sign(uidVal) !== sig) return null;
    return uidVal;
  } catch {
    return null;
  }
}

// ---------- websocket handlers ----------
function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const uidVal = sockets.get(ws._id).uid;
  const chatId = msg.chatId;

  switch (msg.t) {
    case 'register': {
      const username = String(msg.username || '').toLowerCase().trim();
      if (!/^[a-z0-9_]{3,32}$/.test(username)) {
        return sendTo(ws, { t: 'error', code: 'bad_username', msg: 'Юзернейм: латиница/цифры/_, от 3 до 32 символов.' });
      }
      if (db.usernamesTaken(username)) {
        return sendTo(ws, { t: 'error', code: 'username_taken', msg: 'Этот юзернейм уже занят. Выбери другой.' });
      }
      const reserved = db.isReservedName(username);
      if (reserved && String(msg.ownerCode || '') !== OWNER_CODE) {
        return sendTo(ws, { t: 'error', code: 'reserved', msg: 'Этот юзернейм принадлежит Дурову 😉' });
      }
      if (db.getCollectible(username)) {
        return sendTo(ws, { t: 'error', code: 'collectible', msg: 'Этот юзернейм — коллекционный NFT, его нельзя зарегистрировать напрямую.' });
      }
      const user = db.createUser(username, msg.nickname, msg.pubkey, { owner: reserved });
      joinSession(ws, user.uid);
      sendTo(ws, { t: 'registered', me: db.sanitize(user), token: tokenFor(user.uid) });
      broadcastPresence(user.uid);
      return;
    }
    case 'login': {
      const uidFromTok = uidFromToken(msg.token);
      const user = uidFromTok && db.getUser(uidFromTok);
      if (!user) {
        return sendTo(ws, { t: 'error', code: 'bad_token', msg: 'Ключ не подошёл. Проверь и попробуй снова.' });
      }
      if (msg.pubkey) {
        if (user.pubkey && msg.pubkey !== user.pubkey) {
          return sendTo(ws, { t: 'error', code: 'wrong_device', msg: 'Крипто-ключ не совпадает с этим аккаунтом.' });
        }
        if (!user.pubkey) db.updateUser(user.uid, { pubkey: msg.pubkey });
      }
      joinSession(ws, user.uid);
      sendTo(ws, { t: 'logged_in', me: db.sanitize(user), token: msg.token });
      broadcastPresence(user.uid);
      return;
    }
    case 'profile_update': {
      if (!uidVal) return;
      const patch = {};
      if (msg.nickname !== undefined) patch.nickname = String(msg.nickname).slice(0, 60);
      if (msg.bio !== undefined) patch.bio = String(msg.bio).slice(0, 200);
      if (msg.avatar !== undefined) patch.avatar = msg.avatar;
      const u = db.updateUser(uidVal, patch);
      broadcastPresence(uidVal);
      relayProfile(u);
      return sendTo(ws, { t: 'profile_updated', me: db.sanitize(u) });
    }
    case 'search': {
      if (!uidVal) return;
      return sendTo(ws, { t: 'search_results', q: msg.q, users: db.searchUsers(msg.q, uidVal) });
    }
    case 'dm_create': {
      if (!uidVal) return;
      const other = db.getUser(msg.username, true);
      if (!other) return sendTo(ws, { t: 'error', code: 'not_found', msg: 'Пользователь не найден.' });
      if (other.uid === uidVal) return sendTo(ws, { t: 'error', code: 'self', msg: 'Это ты сам 😄' });
      const dm = db.createChat({ type: 'dm', owner: uidVal, members: [uidVal, other.uid] });
      return sendTo(ws, { t: 'dm_created', chat: withUnread(dm, uidVal), other: db.sanitize(other) });
    }
    case 'group_create': {
      if (!uidVal) return;
      const g = db.createChat({
        type: 'group', owner: uidVal, title: msg.title, about: msg.about, members: [uidVal],
        ...(msg.avatar !== undefined ? { avatar: msg.avatar } : {}),
      });
      return sendTo(ws, { t: 'chat_created', chat: g });
    }
    case 'channel_create': {
      if (!uidVal) return;
      const c = db.createChat({
        type: 'channel', owner: uidVal, title: msg.title, about: msg.about, members: [uidVal],
        ...(msg.avatar !== undefined ? { avatar: msg.avatar } : {}),
      });
      return sendTo(ws, { t: 'chat_created', chat: c });
    }
    case 'chat_open': {
      if (!uidVal) return;
      const chat = canAccess(uidVal, msg.chatId);
      if (!chat) return sendTo(ws, { t: 'error', code: 'no_access', msg: 'Нет доступа к чату.' });
      sockets.get(ws._id).room = msg.chatId;
      const all = db.getMessages(msg.chatId);
      const slice = all.slice(-120);
      const more = all.length > slice.length;
      db.setUnread(uidVal, msg.chatId, 0);
      broadcastUnread(uidVal, msg.chatId, 0);
      const members = chat.members.map((m) => {
        const u = db.getUser(m);
        return u ? db.sanitize(u) : null;
      }).filter(Boolean);
      sendTo(ws, {
        t: 'chat_opened',
        chat: withUnread(chat, uidVal),
        members,
        messages: slice.map((mm) => decodeMsg(mm, uidVal)),
        more,
      });
      return;
    }
    case 'chat_more': {
      if (!uidVal) return;
      const chat = canAccess(uidVal, msg.chatId);
      if (!chat) return sendTo(ws, { t: 'error', code: 'no_access', msg: 'Нет доступа к чату.' });
      const before = Number(msg.before) || Date.now();
      const all = db.getMessages(msg.chatId);
      const idx = all.findLastIndex((m) => m.ts < before);
      if (idx < 0) return sendTo(ws, { t: 'chat_more', chatId: msg.chatId, messages: [], more: false });
      const start = Math.max(0, idx - 39);
      const slice = all.slice(start, idx + 1);
      sendTo(ws, { t: 'chat_more', chatId: msg.chatId, messages: slice.map((mm) => decodeMsg(mm, uidVal)), more: start > 0 });
      return;
    }
    case 'msg_search': {
      if (!uidVal) return;
      const chat = canAccess(uidVal, msg.chatId);
      if (!chat) return;
      const q = String(msg.q || '').slice(0, 100).toLowerCase();
      if (q.length < 2) return sendTo(ws, { t: 'msg_search_results', chatId: msg.chatId, q, messages: [] });
      const out = [];
      for (const m of db.getMessages(msg.chatId)) {
        if (m.deleted) continue;
        const p = m.payload;
        let hay = '';
        if (typeof p === 'string') hay = p;
        else if (p && typeof p.text === 'string') hay = p.text;
        else if (chat.type === 'dm') continue; // шифротекст ищет только клиент
        if (hay.toLowerCase().includes(q)) out.push(m);
      }
      sendTo(ws, { t: 'msg_search_results', chatId: msg.chatId, q, messages: out.slice(-50) });
      return;
    }
    case 'chat_leave': {
      if (!uidVal) return;
      const chat = db.getChat(msg.chatId);
      if (!chat || chat.type === 'dm') return;
      chat.members = chat.members.filter((m) => m !== uidVal);
      db.updateChat(msg.chatId, { members: chat.members });
      sockets.get(ws._id).room = null;
      chatBroadcast(msg.chatId, { t: 'member_left', chatId: msg.chatId, uid: uidVal });
      sendTo(ws, { t: 'chat_force_close', chatId: msg.chatId });
      return;
    }
    case 'chat_add_members': {
      if (!uidVal) return;
      const chat = db.getChat(msg.chatId);
      if (!chat || !chat.members.includes(uidVal)) return;
      for (const id of msg.ids || []) {
        if (!chat.members.includes(id)) {
          chat.members.push(id);
          broadcastTo(id, { t: 'chat_invited', chat: withUnread(chat, id, 0) });
        }
      }
      db.updateChat(msg.chatId, { members: chat.members });
      chatBroadcast(msg.chatId, { t: 'members_updated', chatId: msg.chatId, ids: chat.members });
      return;
    }
    case 'chat_update': {
      if (!uidVal) return;
      const chat = db.getChat(msg.chatId);
      if (!chat || chat.owner !== uidVal || chat.type === 'dm') {
        return sendTo(ws, { t: 'error', code: 'no_permission', msg: 'Только владелец может менять.' });
      }
      const patch = {};
      if (msg.title !== undefined) patch.title = String(msg.title).slice(0, 80);
      if (msg.about !== undefined) patch.about = String(msg.about).slice(0, 300);
      if (Object.hasOwn(msg, 'avatar')) patch.avatar = msg.avatar;
      const updated = db.updateChat(msg.chatId, patch);
      chatBroadcast(msg.chatId, { t: 'chat_updated', chat: updated });
      return;
    }
    case 'msg_send': {
      if (!uidVal || !chatId) return;
      const chat = db.getChat(chatId);
      if (!chat || !chat.members.includes(uidVal)) return;
      if (chat.type === 'channel' && chat.owner !== uidVal) {
        return sendTo(ws, { t: 'error', code: 'no_permission', msg: 'В канале писать может только владелец.' });
      }
      const ts = Date.now();
      const meta = Object.assign({}, msg.meta || {});
      if (meta.ghost_timer) meta.ghost_deadline = Date.now() + Math.min(meta.ghost_timer, 3600 * 1000);
      if (meta.reply && meta.reply.id) {
        const t = db.getMessage(chatId, String(meta.reply.id));
        if (!t || t.deleted) {
          delete meta.reply;
        } else {
          let rtext = String(meta.reply.text || '').slice(0, 100);
          if (chat.type !== 'dm') {
            const p = t.payload;
            rtext = (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : rtext)).slice(0, 100);
          }
          const author = db.getUser(t.sender);
          meta.reply = {
            id: t.id,
            sender: t.sender,
            name: author ? (author.nickname || author.username) : '',
            kind: t.kind || 'text',
            text: rtext,
          };
        }
      }
      const m = db.addMessage(chatId, {
        id: msg.clientId || db.uid(),
        chatId,
        sender: uidVal,
        kind: msg.kind || 'text',
        ts,
        ...(chat.type === 'dm' ? (msg.cipher ? { cipher: msg.cipher } : { payload: msg.payload }) : { payload: msg.payload }),
        meta,
        edited: false,
        deleted: false,
        seenBy: [uidVal],
      });

      if (m.meta && m.meta.ghost_timer) {
        setTimeout(() => autoDeleteGhost(m), Math.min(m.meta.ghost_timer, 3600 * 1000) + 500);
      }

      broadcastMessage(chatId, m, uidVal);
      return;
    }
    case 'msg_edit': {
      if (!uidVal || !chatId) return;
      const chat = db.getChat(chatId);
      const m = db.getMessage(chatId, msg.id);
      if (!m || m.deleted) return;
      const isAuthor = m.sender === uidVal;
      if (!isAuthor && !msg.meta) return; // чужие правки возможны только для meta (реакции)
      const patch = {};
      if (isAuthor) {
        patch.edited = true;
        if (chat.type === 'dm') {
          if (msg.cipher) patch.cipher = msg.cipher; else patch.payload = msg.payload;
        } else patch.payload = msg.payload;
      }
      if (msg.meta) {
        const meta = Object.assign({}, m.meta || {}, msg.meta);
        if (Array.isArray(meta.reactions)) {
          meta.reactions = meta.reactions
            .slice(0, 50)
            .map((r) => (r && typeof r === 'object' && r.e !== undefined
              ? { e: String(r.e).slice(0, 8), uids: Array.isArray(r.uids) ? r.uids.slice(0, 2000) : [] }
              : null))
            .filter(Boolean);
        }
        patch.meta = meta;
      }
      const updated = db.updateMessage(chatId, msg.id, patch);
      chatBroadcast(chatId, { t: 'msg_updated', chatId, message: decodeMsg(updated, uidVal) });
      return;
    }
    case 'msg_delete': {
      if (!uidVal || !chatId) return;
      const m = db.getMessage(chatId, msg.id);
      if (!m || m.deleted) return;
      if (m.sender !== uidVal) return sendTo(ws, { t: 'error', code: 'no_permission', msg: 'Можно удалять только свои сообщения.' });
      db.updateMessage(chatId, msg.id, { deleted: true });
      purgeUploads(m);
      chatBroadcast(chatId, { t: 'msg_deleted', chatId, id: msg.id });
      return;
    }
case 'msg_seen': {
      if (!uidVal || !chatId) return;
      const chat = db.getChat(chatId);
      const m = db.getMessage(chatId, msg.id);
      if (m && !m.seenBy.includes(uidVal)) {
        const seenBy = [...m.seenBy, uidVal];
        db.updateMessage(chatId, msg.id, { seenBy });
        chatBroadcast(chatId, { t: 'msg_seen', chatId, id: msg.id, uid: uidVal });
        if (m.meta?.ghost && m.meta.ghost_views && !m.deleted) {
          const reads = seenBy.filter((u) => u !== m.sender).length;
          if (reads >= m.meta.ghost_views) {
            db.updateMessage(chatId, msg.id, { deleted: true });
            purgeUploads(m);
            chatBroadcast(chatId, { t: 'msg_deleted', chatId, id: msg.id, ghost: true });
          }
        }
      }
      return;
    }
    case 'typing': {
      if (!uidVal || !chatId) return;
      chatBroadcast(chatId, { t: 'typing', chatId, uid: uidVal, typing: !!msg.typing }, uidVal);
      return;
    }
    // ========================== экономика / подарки / NFT ==========================
    case 'wallet_get': {
      if (!uidVal) return;
      return sendTo(ws, {
        t: 'wallet',
        balance: db.getBalance(uidVal),
        gifts: db.getGifts(uidVal),
        nft: db.allCollectibles().filter((c) => c.owner === uidVal).map((c) => c.slug),
      });
    }
    case 'gifts_catalog': {
      if (!uidVal) return;
      const cat = items.STAR_GIFTS.map((g) => ({
        ...g,
        convert: g.convert || Math.max(1, Math.floor(g.price / 10)),
        remains: giftRemains(g),
      }));
      return sendTo(ws, { t: 'gifts_catalog', gifts: cat, balance: db.getBalance(uidVal) });
    }
    case 'gift_buy': {
      if (!uidVal) return;
      const g = items.giftById(msg.giftId);
      if (!g) return sendTo(ws, { t: 'error', code: 'no_gift', msg: 'Подарок не найден.' });
      if (!giftAvailable(g, uidVal)) {
        return sendTo(ws, { t: 'error', code: 'gift_unavailable', msg: 'Этот подарок нельзя купить (лимит или sold out).' });
      }
      if (!db.spendBalance(uidVal, g.price)) {
        return sendTo(ws, { t: 'error', code: 'no_money', msg: 'Не хватает звёзд 🪙. Получай подарки и продавай NFT.' });
      }
      const copy = makeGiftCopy(g, uidVal, null);
      db.addGift(uidVal, copy);
      sendTo(ws, { t: 'gift_bought', gift: copy, balance: db.getBalance(uidVal) });
      walletPing(uidVal);
      return;
    }
    case 'gift_send': {
      if (!uidVal) return;
      const target = msg.toUsername && db.getUser(String(msg.toUsername).toLowerCase(), true);
      if (!target) return sendTo(ws, { t: 'error', code: 'no_user', msg: 'Пользователь не найден.' });
      if (target.uid === uidVal) return sendTo(ws, { t: 'error', code: 'self_gift', msg: 'Нельзя дарить подарок самому себе.' });
      const g = items.giftById(msg.giftId);
      if (!g) return sendTo(ws, { t: 'error', code: 'no_gift', msg: 'Подарок не найден.' });
      if (!giftAvailable(g, uidVal)) {
        return sendTo(ws, { t: 'error', code: 'gift_unavailable', msg: 'Этот подарок закончился (лимит или sold out).' });
      }
      if (!db.spendBalance(uidVal, g.price)) {
        return sendTo(ws, { t: 'error', code: 'no_money', msg: 'Не хватает звёзд 🪙.' });
      }
      const reward = g.convert || Math.max(1, Math.floor(g.price / 10));
      db.addBalance(target.uid, reward);
      const copy = makeGiftCopy(g, uidVal, target.uid);
      db.addGift(target.uid, copy);
      sendTo(ws, { t: 'gift_sent', gift: copy, balance: db.getBalance(uidVal) });
      walletPing(uidVal);
      broadcastTo(target.uid, { t: 'gift_received', gift: copy, balance: db.getBalance(target.uid), bonus: reward });
      return;
    }
    case 'gift_upgrade': {
      if (!uidVal) return;
      const gift = db.getGifts(uidVal).find((x) => x.copy === msg.copy || x.token === msg.copy);
      const g = gift && items.giftById(gift.giftId);
      if (!gift || gift.unique || !g || !g.upgrade) {
        return sendTo(ws, { t: 'error', code: 'bad_upgrade', msg: 'Этот подарок нельзя апгрейдить.' });
      }
      if (!db.spendBalance(uidVal, g.upgrade)) {
        return sendTo(ws, { t: 'error', code: 'no_money', msg: 'Не хватает звёзд на апгрейд 🪙.' });
      }
      gift.unique = true;
      gift.token = db.uid();
      gift.upgradedAt = Date.now();
      db.persist();
      sendTo(ws, { t: 'gift_upgraded', gift, balance: db.getBalance(uidVal) });
      walletPing(uidVal);
      return;
    }
    case 'gift_withdraw': {
      if (!uidVal) return;
      const gift = db.getGifts(uidVal).find((x) => x.copy === msg.copy);
      const g = gift && items.giftById(gift.giftId);
      if (!gift || gift.unique || !g) return sendTo(ws, { t: 'error', code: 'no_gift', msg: 'Такой подарок не найден.' });
      const back = g.convert || Math.max(1, Math.floor(g.price / 10));
      db.removeGift(uidVal, gift.copy);
      db.addBalance(uidVal, back);
      sendTo(ws, { t: 'gift_withdrawn', balance: db.getBalance(uidVal) });
      walletPing(uidVal);
      return;
    }
    case 'nft_list': {
      if (!uidVal) return;
      return sendTo(ws, {
        t: 'nft_list',
        auctions: db.allCollectibles().filter((c) => c.status === 'auction').map(publicCollectible),
        mine: db.allCollectibles().filter((c) => c.owner === uidVal).map(publicCollectible),
      });
    }
    case 'nft_bid': {
      if (!uidVal) return;
      const c = collectibleOrError(ws, msg.slug);
      if (!c) return;
      if (c.status !== 'auction') return sendTo(ws, { t: 'error', code: 'no_auction', msg: 'Аукциона сейчас нет.' });
      const amount = Math.floor(Number(msg.amount));
      if (!isFinite(amount) || amount <= 0) return sendTo(ws, { t: 'error', code: 'bad_bid', msg: 'Некорректная ставка.' });
      const cur = topBid(c);
      const min = cur ? cur.amount + items.AUCTION_STEP : c.auction.minBid;
      if (amount < min) {
        return sendTo(ws, { t: 'error', code: 'bid_too_low', msg: 'Минимальная ставка сейчас ' + min + ' звёзд.' });
      }
      if ((c.owner && c.owner === uidVal) || (c.seller && c.seller === uidVal)) {
        return sendTo(ws, { t: 'error', code: 'self_bid', msg: 'Нельзя ставить против себя.' });
      }
      if (!db.spendBalance(uidVal, amount)) {
        return sendTo(ws, { t: 'error', code: 'no_money', msg: 'Не хватает звёзд на ставку 🪙.' });
      }
      if (cur) db.addBalance(cur.uid, cur.amount); // возврат прежнему лидеру (в т.ч. самому себе)
      c.auction.bids = [{ uid: uidVal, amount, ts: Date.now() }];
      db.setCollectible(c);
      sendTo(ws, { t: 'nft_bid_ok', slug: c.slug, amount, balance: db.getBalance(uidVal), c: publicCollectible(c) });
      broadcastAll({ t: 'nft_update', c: publicCollectible(c) });
      return;
    }
    case 'nft_sell': {
      if (!uidVal) return;
      const c = collectibleOrError(ws, msg.slug);
      if (!c) return;
      if (c.owner !== uidVal) return sendTo(ws, { t: 'error', code: 'not_yours', msg: 'У тебя нет этого NFT.' });
      const minBid = Math.max(1, Math.floor(Number(msg.minBid)));
      const dur = Math.min(7 * 24 * 3600, Math.max(60, Math.floor(Number(msg.seconds) || items.AUCTION_ROUND_SECONDS))) * 1000;
      Object.assign(c, {
        status: 'auction',
        seller: uidVal,
        auction: { minBid, endAt: Date.now() + dur, bids: [], buyNow: msg.buyNow ? Math.floor(Number(msg.buyNow)) || null : null },
      });
      db.setCollectible(c);
      broadcastAll({ t: 'nft_update', c: publicCollectible(c) });
      sendTo(ws, { t: 'nft_sold', slug: c.slug, c: publicCollectible(c) });
      return;
    }
    case 'nft_cancel': {
      if (!uidVal) return;
      const c = collectibleOrError(ws, msg.slug);
      if (!c) return;
      if (c.owner !== uidVal || c.status !== 'auction' || (c.auction.bids || []).length) {
        return sendTo(ws, { t: 'error', code: 'cant_cancel', msg: 'Нельзя снять аукцион с этого NFT.' });
      }
      c.status = 'owned';
      delete c.auction;
      db.setCollectible(c);
      return sendTo(ws, { t: 'nft_cancelled', slug: c.slug });
    }
    case 'nft_buy_now': {
      if (!uidVal) return;
      const c = collectibleOrError(ws, msg.slug);
      if (!c) return;
      const buyNow = c.auction && c.auction.buyNow;
      if (c.status !== 'auction' || !buyNow) return sendTo(ws, { t: 'error', code: 'no_buy_now', msg: '«Купить сейчас» недоступно.' });
      if (!db.spendBalance(uidVal, buyNow)) {
        return sendTo(ws, { t: 'error', code: 'no_money', msg: 'Не хватает звёзд 🪙.' });
      }
      const prev = topBid(c);
      if (prev && prev.uid !== uidVal) db.addBalance(prev.uid, prev.amount);
      const seller = c.seller || null;
      settleTransfer(c, uidVal);
      if (seller && seller !== uidVal) {
        db.addBalance(seller, Math.round(buyNow * (100 - items.SELL_FEE_PERCENT) / 100));
        broadcastTo(seller, { t: 'nft_sold_out', slug: c.slug, proceeds: Math.round(buyNow * (100 - items.SELL_FEE_PERCENT) / 100) });
      }
      sendTo(ws, { t: 'nft_bought', slug: c.slug, balance: db.getBalance(uidVal) });
      walletPing(uidVal);
      broadcastAll({ t: 'nft_update', c: publicCollectible(c) });
      return;
    }
    case 'nft_claim': {
      if (!uidVal) return;
      const c = collectibleOrError(ws, msg.slug);
      if (!c) return;
      if (c.owner !== uidVal || c.status !== 'owned') {
        return sendTo(ws, { t: 'error', code: 'not_yours', msg: 'Ты пока не владелец этого NFT.' });
      }
      const u = db.getUser(uidVal);
      if (!u) return;
      if (u.username === c.slug) return sendTo(ws, { t: 'nft_claimed', username: c.slug });
      const clash = db.getUser(c.slug, true);
      if (clash && clash.uid !== uidVal) {
        return sendTo(ws, { t: 'error', code: 'taken', msg: 'Этот юзернейм уже занят другим пользователем.' });
      }
      db.updateUser(uidVal, { username: c.slug });
      const fresh = db.getUser(uidVal);
      sendTo(ws, { t: 'nft_claimed', username: c.slug, me: db.sanitize(fresh) });
      return;
    }
    default:
      return;
  }
}

function decodeMsg(m, uidVal) {
  if (m.deleted) return { ...m, deleted: true, payload: null, cipher: null };
  return { ...m };
}

function withUnread(chat, uidVal) {
  return { ...chat, unread: db.getUnread(uidVal, chat.id) };
}

function broadcastMessage(chatId, message, senderUid) {
  const chat = db.getChat(chatId);
  if (!chat) return;
  for (const m of chat.members) {
    if (m === senderUid) continue;
    const payload = { t: 'msg_new', chatId, message: decodeMsg(message, m), self: false };
    if (onlineInRoom(m, chatId)) {
      broadcastTo(m, payload);
    } else {
      const n = db.bumpUnread(m, chatId, 1);
      broadcastTo(m, payload);
      broadcastUnread(m, chatId, n);
    }
  }
  // echo back to sender (all their devices)
  broadcastTo(senderUid, { t: 'msg_new', chatId, message: decodeMsg(message, senderUid), self: true });
}

function purgeUploads(m) {
  if (!m || !m.payload) return;
  for (const field of ['url', 'src', 'audio']) {
    const val = m.payload[field];
    if (typeof val === 'string' && val.startsWith('/uploads/')) {
      const file = path.join(db.UPLOADS_DIR, path.basename(val));
      fs.unlink(file, () => {});
    }
  }
}

function autoDeleteGhost(m) {
  const chat = db.getChat(m.chatId);
  if (!chat) return;
  const fresh = db.getMessage(m.chatId, m.id);
  if (!fresh || fresh.deleted) return;
  db.updateMessage(m.chatId, m.id, { deleted: true });
  purgeUploads(fresh);
  chatBroadcast(m.chatId, { t: 'msg_deleted', chatId: m.chatId, id: m.id, ghost: true });
}

// призраки переживают рестарт сервера: таймеры восстанавливаются из ghost_deadline
function restoreGhostTimers() {
  db.forEachMessage((chatId, m) => {
    if (m.deleted || !m.meta || !m.meta.ghost || !m.meta.ghost_deadline) return;
    const left = m.meta.ghost_deadline - Date.now();
    if (left <= 0) autoDeleteGhost(m);
    else setTimeout(() => autoDeleteGhost(m), left + 200);
  });
}

// ---------- экономика (звёзды), подарки, NFT ----------
function giftRemains(g) {
  if (!g.limited) return null;
  return Math.max(0, g.total - db.countGiftCopies(g.id));
}

function giftAvailable(g, uidVal) {
  if (g.per_user_deal && db.countUserGift(g.id, uidVal) >= g.per_user_deal) return false;
  if (g.limited && giftRemains(g) <= 0) return false;
  return true;
}

function makeGiftCopy(g, fromUid, toUid) {
  const fromU = fromUid && db.getUser(fromUid);
  return {
    copy: db.uid(),
    giftId: g.id,
    emoji: g.emoji,
    name: g.name,
    price: g.price,
    unique: false,
    token: null,
    from: fromUid || null,
    fromName: fromU ? (fromU.nickname || fromU.username) : null,
    ts: Date.now(),
  };
}

function walletPing(uidVal) {
  broadcastTo(uidVal, { t: 'wallet_update', balance: db.getBalance(uidVal) });
}

function broadcastAll(obj) {
  for (const uid of sessionByUid.keys()) broadcastTo(uid, obj);
}

function topBid(c) {
  const bids = (c.auction && c.auction.bids) || [];
  return bids.length ? bids[bids.length - 1] : null;
}

function publicCollectible(c) {
  const top = topBid(c);
  return {
    slug: c.slug,
    status: c.status,
    seller: c.seller || null,
    owner: c.owner || null,
    base: (c.auction && c.auction.minBid) || c.base || null,
    buyNow: (c.auction && c.auction.buyNow) || null,
    endAt: (c.auction && c.auction.endAt) || null,
    cur: top ? top.amount : null,
    curUid: top ? top.uid : null,
  };
}

function collectibleOrError(ws, slug) {
  const c = db.getCollectible(slug);
  if (!c) {
    sendTo(ws, { t: 'error', code: 'no_nft', msg: 'Такой NFT-юзернейм не найден.' });
    return null;
  }
  return c;
}

function settleTransfer(c, winnerUid) {
  c.owner = winnerUid;
  c.seller = null;
  c.status = 'owned';
  delete c.auction;
  db.setCollectible(c);
}

// фрагмент-стиль: держим фиксированное число слотов из пула на аукционах
function ensurePoolAuctions() {
  const ownedSlugs = new Set();
  for (const c of db.allCollectibles()) if (c.owner) ownedSlugs.add(c.slug);
  const active = db.allCollectibles().filter((c) => c.status === 'auction');
  if (active.length >= items.AUCTION_TOP_ACCOUNTS) return;
  const need = items.AUCTION_TOP_ACCOUNTS - active.length;
  const pool = items.COLLECTIBLE_NAMES.filter((p) =>
    !ownedSlugs.has(p.username) && !active.some((c) => c.slug === p.username));
  pool.slice(0, need).forEach((p) => {
    let rec = db.getCollectible(p.username);
    if (!rec) rec = { slug: p.username, base: p.base, owner: null, status: 'pool' };
    rec.status = 'auction';
    rec.seller = null;
    rec.auction = { minBid: p.base, endAt: Date.now() + items.AUCTION_ROUND_SECONDS * 1000, bids: [], buyNow: p.buyNow };
    db.setCollectible(rec);
  });
}

function settleAuctions() {
  const now = Date.now();
  for (const c of db.allCollectibles()) {
    if (c.status !== 'auction' || (c.auction && c.auction.endAt > now)) continue;
    const top = topBid(c);
    if (top) {
      const sellerUid = c.seller || null;
      const winner = top.uid;
      settleTransfer(c, winner);
      if (sellerUid && sellerUid !== winner) {
        db.addBalance(sellerUid, Math.round(top.amount * (100 - items.SELL_FEE_PERCENT) / 100));
        broadcastTo(sellerUid, { t: 'nft_sold_out', slug: c.slug, proceeds: Math.round(top.amount * (100 - items.SELL_FEE_PERCENT) / 100) });
      }
      broadcastTo(winner, { t: 'nft_won', slug: c.slug });
    } else if (c.seller) {
      c.status = 'owned';
      delete c.auction;
      db.setCollectible(c);
    } else {
      c.status = 'pool';
      delete c.auction;
      db.setCollectible(c);
    }
  }
  ensurePoolAuctions();
}

function bootstrapCollectibles() {
  for (const p of items.COLLECTIBLE_NAMES) {
    if (!db.getCollectible(p.username)) {
      db.setCollectible({ slug: p.username, base: p.base, owner: null, status: 'pool' });
    }
  }
  ensurePoolAuctions();
  setInterval(settleAuctions, 10000);
}

function relayProfile(u) {
  const pub = db.sanitize(u);
  for (const chat of db.myChats(u.uid)) {
    chatBroadcast(chat.id, { t: 'profile_updated', chatId: chat.id, user: pub }, u.uid);
  }
}

function broadcastPresence(uidVal) {
  for (const chat of db.myChats(uidVal)) {
    chatBroadcast(chat.id, { t: 'presence', chatId: chat.id, presence: presence(uidVal) }, uidVal);
  }
}

function joinSession(ws, uidVal) {
  sockets.get(ws._id).uid = uidVal;
  db.updateUser(uidVal, { lastSeen: Date.now() });
  db.updateUser(uidVal, { online: true });
  const set = sessionByUid.get(uidVal) || new Set();
  set.add(ws);
  sessionByUid.set(uidVal, set);

  const chats = db.myChats(uidVal).map((c) => withUnread(c, uidVal));
  sendTo(ws, { t: 'chat_list', chats });

  for (const chat of db.myChats(uidVal)) {
    chatBroadcast(chat.id, { t: 'presence', chatId: chat.id, presence: presence(uidVal) });
  }
}

wss.on('connection', (ws) => {
  const id = '_' + Math.random().toString(36).slice(2);
  sockets.set(id, { ws, uid: null, room: null });
  ws._id = id;
  ws.on('message', (buf) => {
    try { handleMessage(ws, buf.toString()); } catch (e) { console.error('ws err:', e); }
  });
  ws.on('close', () => {
    const rec = sockets.get(id);
    if (rec && rec.uid) {
      const set = sessionByUid.get(rec.uid);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          sessionByUid.delete(rec.uid);
          db.updateUser(rec.uid, { online: false, lastSeen: Date.now() });
          broadcastPresence(rec.uid);
        }
      }
    }
    sockets.delete(id);
  });
  ws.on('error', () => {});
});

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'DUROV MSG' }));

// ---------------- file uploads ----------------
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/svg+xml': 'svg',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'video/mp4': 'mp4', 'video/webm': 'webm',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'application/json': 'json',
  'application/zip': 'zip', 'application/x-7z-compressed': '7z', 'application/x-rar-compressed': 'rar',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
function extForMime(mime) {
  return MIME_EXT[mime] || 'bin';
}

app.use('/uploads', express.static(db.UPLOADS_DIR, { maxAge: '30d' }));

app.post('/api/upload', express.raw({ limit: '64mb', type: () => true }), (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const uidVal = uidFromToken(token);
  if (!uidVal || !db.getUser(uidVal)) return res.status(401).json({ error: 'bad_token' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty' });
  const mime = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  const id = db.uid() + '.' + extForMime(mime);
  try {
    fs.writeFileSync(path.join(db.UPLOADS_DIR, id), req.body);
  } catch {
    return res.status(500).json({ error: 'write_failed' });
  }
  res.json({ url: '/uploads/' + id, size: req.body.length });
});

restoreGhostTimers();
bootstrapCollectibles();

function startServer(port) {
  const p = port || PORT;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, () => {
      console.log(`
  ██████╗ ██╗   ██╗██████╗  ██████╗ ██╗   ██╗
  ██   ██║██║   ██║██╔══██╗██╔═══██╗██║   ██║
  ██   ██║██║   ██║██████╔╝██║   ██║██║   ██║
  ██   ██║██║   ██║██████╔╝██║   ██║╚██╗ ██╔╝
  ██████╔╝╚██████╔╝██║  ██║╚██████╔╝ ╚████╔╝
  ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝   ╚═══╝
  DUROV MSG server running  →  http://localhost:${p}
`);
      resolve({ port: p, server, wss, app });
    });
  });
}

module.exports = { startServer };

if (require.main === module) {
  startServer();
}