const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_IS_PACKAGED = !!(process.env.APPIMAGE || process.env.PORTABLE_EXECUTABLE_DIR || process.env.DUROV_PORTABLE);

function resolveDataDir() {
  if (APP_IS_PACKAGED) {
    const home = process.env.HOME || process.cwd();
    const base = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    return path.join(base, 'durov-msg', 'data');
  }
  return path.join(__dirname, '..', 'data');
}

const DATA_DIR = resolveDataDir();
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const UNREAD_FILE = path.join(DATA_DIR, 'unread.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const GIFTS_FILE = path.join(DATA_DIR, 'gifts.json');
const COLLECT_FILE = path.join(DATA_DIR, 'collectibles.json');

// Юзернеймы, которые нельзя занять никому, кроме владельца (проверка в index.js).
const RESERVED_USERNAMES = ['strangerezz'];
const START_BALANCE = 700;

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function load(file, fallback) {
  ensure();
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('corrupt db, resetting:', file, e.message);
  }
  return fallback;
}

function save(file, data) {
  ensure();
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

const users = new Map();
const chats = new Map();
const messages = new Map(); // chatId -> [ {id, sender, kind, ts, ...} ]
const unread = new Map();   // "uid:chatId" -> int
const giftsBy = new Map();  // uid -> [ { copy, giftId, emoji, name, price, unique, token, fromUid, ts } ]
const collectibles = new Map(); // slug -> { slug, owner|null, status:'pool'|'auction'|'owned', auction:{...} }

function init() {
  const u = load(USERS_FILE, {});
  for (const k of Object.keys(u)) users.set(k, u[k]);

  const c = load(CHATS_FILE, {});
  for (const k of Object.keys(c)) chats.set(k, c[k]);

  const m = load(MESSAGES_FILE, {});
  for (const k of Object.keys(m)) {
    messages.set(k, Array.isArray(m[k]) ? m[k] : []);
  }

  const un = load(UNREAD_FILE, {});
  for (const k of Object.keys(un)) unread.set(k, un[k] || 0);

  const gf = load(GIFTS_FILE, {});
  for (const k of Object.keys(gf)) giftsBy.set(k, Array.isArray(gf[k]) ? gf[k] : []);

  const cl = load(COLLECT_FILE, {});
  for (const k of Object.keys(cl)) collectibles.set(k, cl[k]);
}

let saveTimer = null;
function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const u = {}; users.forEach((v, k) => (u[k] = v));
    const c = {}; chats.forEach((v, k) => (c[k] = v));
    const m = {}; messages.forEach((v, k) => (m[k] = v));
    const un = {}; unread.forEach((v, k) => (un[k] = v));
    const gf = {}; giftsBy.forEach((v, k) => (gf[k] = v));
    const cl = {}; collectibles.forEach((v, k) => (cl[k] = v));
    save(USERS_FILE, u);
    save(CHATS_FILE, c);
    save(MESSAGES_FILE, m);
    save(UNREAD_FILE, un);
    save(GIFTS_FILE, gf);
    save(COLLECT_FILE, cl);
    saveTimer = null;
  }, 300);
}

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

// ---------------- users ----------------
function createUser(username, nickname, pubkey, opts = {}) {
  const rec = {
    uid: uid(),
    username: username.toLowerCase(),
    nickname: nickname || username,
    pubkey,
    avatar: null,
    bio: '',
    created: Date.now(),
    lastSeen: Date.now(),
    balance: opts.balance != null ? opts.balance : START_BALANCE,
    owner: !!opts.owner,
  };
  users.set(rec.uid, rec);
  persist();
  return rec;
}

function getUser(uidOrUsername, byUsername) {
  if (byUsername) {
    const u = uidOrUsername.toLowerCase();
    for (const x of users.values()) if (x.username === u) return x;
    return null;
  }
  return users.get(uidOrUsername) || null;
}

function findByTokenKey(pubkey) {
  for (const x of users.values()) if (x.pubkey === pubkey) return x;
  return null;
}

function updateUser(uidVal, patch) {
  const u = users.get(uidVal);
  if (!u) return null;
  Object.assign(u, patch);
  persist();
  return u;
}

function isReservedName(username) {
  return RESERVED_USERNAMES.includes(String(username || '').toLowerCase());
}

// ---------------- экономика (звёзды) ----------------
function getBalance(uidVal) {
  return (users.get(uidVal) || {}).balance || 0;
}

function addBalance(uidVal, n) {
  const u = users.get(uidVal);
  if (!u) return getBalance(uidVal);
  u.balance = Math.max(0, (u.balance || 0) + (n | 0));
  persist();
  return u.balance;
}

function spendBalance(uidVal, n) {
  const u = users.get(uidVal);
  if (!u || (u.balance || 0) < n) return false;
  u.balance -= n;
  persist();
  return true;
}

// ---------------- подарки ----------------
function getGifts(uidVal) {
  return giftsBy.get(uidVal) || [];
}

function addGift(uidVal, gift) {
  const a = getGifts(uidVal);
  a.push(gift);
  giftsBy.set(uidVal, a);
  persist();
  return gift;
}

function removeGift(uidVal, copy) {
  const a = getGifts(uidVal);
  const i = a.findIndex((g) => g.copy === copy || g.token === copy);
  if (i >= 0) {
    a.splice(i, 1);
    giftsBy.set(uidVal, a);
    persist();
    return true;
  }
  return false;
}

function countGiftCopies(giftId) {
  let n = 0;
  for (const a of giftsBy.values()) {
    for (const g of a) if (g.giftId === giftId) n++;
  }
  return n;
}

function countUserGift(giftId, uidVal) {
  return getGifts(uidVal).filter((g) => g.giftId === giftId).length;
}

// ---------------- коллекционные (NFT) юзернеймы ----------------
function getCollectible(slug) {
  return collectibles.get(String(slug || '').toLowerCase()) || null;
}

function setCollectible(rec) {
  collectibles.set(String(rec.slug).toLowerCase(), rec);
  persist();
  return rec;
}

function removeCollectible(slug) {
  collectibles.delete(String(slug || '').toLowerCase());
  persist();
}

function allCollectibles() {
  return [...collectibles.values()];
}

function usernamesTaken(username) {
  const u = username.toLowerCase();
  for (const x of users.values()) if (x.username === u) return true;
  return false;
}

function searchUsers(q, excludeUid) {
  const ql = q.replace(/^@/, '').toLowerCase();
  const ranked = [];
  for (const x of users.values()) {
    if (x.uid === excludeUid) continue;
    const un = x.username.toLowerCase();
    const nn = (x.nickname || '').toLowerCase();
    let score = -1;
    if (un.startsWith(ql)) score = 0;
    else if (nn.startsWith(ql)) score = 1;
    else if (un.includes(ql)) score = 2;
    else if (nn.includes(ql)) score = 3;
    if (score >= 0) ranked.push([score, sanitize(x)]);
  }
  ranked.sort((a, b) => a[0] - b[0]);
  return ranked.slice(0, 15).map(([, u]) => u);
}

function sanitize(u) {
  return {
    uid: u.uid,
    username: u.username,
    nickname: u.nickname,
    avatar: u.avatar,
    bio: u.bio,
    pubkey: u.pubkey,
    online: !!u.online,
    lastSeen: u.lastSeen,
    created: u.created,
    balance: u.balance != null ? u.balance : 0,
    owner: !!u.owner,
  };
}

// ---------------- chats ----------------
function createChat({ type, owner, title, about, avatar, members }) {
  const id = 'chat_' + uid();
  const rec = {
    id,
    type,
    owner,
    title: title || (type === 'dm' ? '' : 'Новая группа'),
    about: about || '',
    avatar: avatar || null,
    members: members || [],
    created: Date.now(),
  };
  if (type === 'dm') {
    const pair = members.slice().sort().join(':');
    for (const c of chats.values()) {
      if (c.type === 'dm' && c.members.slice().sort().join(':') === pair) return c;
    }
  }
  chats.set(id, rec);
  messages.set(id, []);
  persist();
  return rec;
}

function getChat(id) {
  const c = chats.get(id);
  if (!c) return null;
  return { ...c };
}

function updateChat(id, patch) {
  const c = chats.get(id);
  if (!c) return null;
  Object.assign(c, patch);
  persist();
  return c;
}

function deleteChat(id) {
  chats.delete(id);
  messages.delete(id);
  persist();
}

function myChats(uidVal) {
  const out = [];
  for (const c of chats.values()) {
    if (c.members.includes(uidVal)) out.push({ ...c });
  }
  return out;
}

// ---------------- messages ----------------
function addMessage(chatId, msg) {
  if (!messages.has(chatId)) messages.set(chatId, []);
  messages.get(chatId).push(msg);
  persist();
  return msg;
}

function getMessages(chatId, limit = 0) {
  const arr = messages.get(chatId) || [];
  return limit ? arr.slice(-limit) : arr;
}

function getMessage(chatId, id) {
  const arr = messages.get(chatId) || [];
  return arr.find((m) => m.id === id);
}

function forEachMessage(fn) {
  for (const [chatId, arr] of messages) {
    for (const m of arr) fn(chatId, m);
  }
}

// ---------------- unread ----------------
function unreadKey(uidVal, chatId) { return uidVal + ':' + chatId; }

function getUnread(uidVal, chatId) {
  return unread.get(unreadKey(uidVal, chatId)) || 0;
}

function setUnread(uidVal, chatId, n) {
  unread.set(unreadKey(uidVal, chatId), Math.max(0, n | 0));
  persist();
  return getUnread(uidVal, chatId);
}

function bumpUnread(uidVal, chatId, d) {
  return setUnread(uidVal, chatId, getUnread(uidVal, chatId) + (d | 0));
}

function updateMessage(chatId, id, patch) {
  const arr = messages.get(chatId) || [];
  const m = arr.find((x) => x.id === id);
  if (!m) return null;
  Object.assign(m, patch);
  persist();
  return m;
}

function removeMessage(chatId, id) {
  const arr = messages.get(chatId) || [];
  const i = arr.findIndex((x) => x.id === id);
  if (i >= 0) {
    arr.splice(i, 1);
    persist();
    return true;
  }
  return false;
}

function everyone() {
  if (typeof performance !== 'undefined') return;
  return users.size;
}

module.exports = {
  init, persist, uid,
  DATA_DIR, UPLOADS_DIR,
  createUser, getUser, findByTokenKey, updateUser, usernamesTaken, searchUsers, sanitize,
  isReservedName,
  getBalance, addBalance, spendBalance,
  getGifts, addGift, removeGift, countGiftCopies, countUserGift,
  getCollectible, setCollectible, removeCollectible, allCollectibles,
  createChat, getChat, updateChat, deleteChat, myChats,
  addMessage, getMessages, getMessage, updateMessage, removeMessage, everyone, forEachMessage,
  getUnread, setUnread, bumpUnread,
};