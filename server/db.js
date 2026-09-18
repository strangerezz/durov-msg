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

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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

function init() {
  const u = load(USERS_FILE, {});
  for (const k of Object.keys(u)) users.set(k, u[k]);

  const c = load(CHATS_FILE, {});
  for (const k of Object.keys(c)) chats.set(k, c[k]);

  const m = load(MESSAGES_FILE, {});
  for (const k of Object.keys(m)) {
    messages.set(k, Array.isArray(m[k]) ? m[k] : []);
  }
}

let saveTimer = null;
function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const u = {}; users.forEach((v, k) => (u[k] = v));
    const c = {}; chats.forEach((v, k) => (c[k] = v));
    const m = {}; messages.forEach((v, k) => (m[k] = v));
    save(USERS_FILE, u);
    save(CHATS_FILE, c);
    save(MESSAGES_FILE, m);
    saveTimer = null;
  }, 300);
}

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

// ---------------- users ----------------
function createUser(username, nickname, pubkey) {
  const rec = {
    uid: uid(),
    username: username.toLowerCase(),
    nickname: nickname || username,
    pubkey,
    avatar: null,
    bio: '',
    created: Date.now(),
    lastSeen: Date.now(),
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

function usernamesTaken(username) {
  const u = username.toLowerCase();
  for (const x of users.values()) if (x.username === u) return true;
  return false;
}

function searchUsers(q, excludeUid) {
  const ql = q.toLowerCase();
  const out = [];
  for (const x of users.values()) {
    if (x.uid === excludeUid) continue;
    if (x.username.includes(ql) || x.nickname.toLowerCase().includes(ql)) {
      out.push(sanitize(x));
    }
    if (out.length >= 12) break;
  }
  return out;
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

function getMessages(chatId, limit = 100) {
  const arr = messages.get(chatId) || [];
  return arr.slice(-limit);
}

function getMessage(chatId, id) {
  const arr = messages.get(chatId) || [];
  return arr.find((m) => m.id === id);
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
  createUser, getUser, findByTokenKey, updateUser, usernamesTaken, searchUsers, sanitize,
  createChat, getChat, updateChat, deleteChat, myChats,
  addMessage, getMessages, getMessage, updateMessage, removeMessage, everyone,
};