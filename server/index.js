const path = require('path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const db = require('./db');

const PORT = process.env.PORT || 9173;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

db.init();

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 * 1024 });

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

// ---------- auth via tokens ----------
function tokenFor(uidVal) {
  // reversible token: uid.payload.signature
  const payload = uidVal;
  const sig = Buffer.from(payload).toString('base64url');
  return sig;
}

function uidFromToken(token) {
  try {
    return Buffer.from(String(token), 'base64url').toString('utf8');
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
      if (db.usernamesTaken(msg.username)) {
        return sendTo(ws, { t: 'error', code: 'username_taken', msg: 'Этот ник уже занят. Выбери другой.' });
      }
      const user = db.createUser(msg.username, msg.nickname, msg.pubkey);
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
      return sendTo(ws, { t: 'dm_created', chat: withUnread(dm, uidVal, 0), other: db.sanitize(other) });
    }
    case 'group_create': {
      if (!uidVal) return;
      const g = db.createChat({ type: 'group', owner: uidVal, title: msg.title, about: msg.about, members: [uidVal] });
      return sendTo(ws, { t: 'chat_created', chat: g });
    }
    case 'channel_create': {
      if (!uidVal) return;
      const c = db.createChat({ type: 'channel', owner: uidVal, title: msg.title, about: msg.about, members: [uidVal] });
      return sendTo(ws, { t: 'chat_created', chat: c });
    }
    case 'chat_open': {
      if (!uidVal) return;
      const chat = canAccess(uidVal, msg.chatId);
      if (!chat) return sendTo(ws, { t: 'error', code: 'no_access', msg: 'Нет доступа к чату.' });
      sockets.get(ws._id).room = msg.chatId;
      const messages = db.getMessages(msg.chatId, 120);
      const members = chat.members.map((m) => {
        const u = db.getUser(m);
        return u ? db.sanitize(u) : null;
      }).filter(Boolean);
      sendTo(ws, {
        t: 'chat_opened',
        chat: withUnread(chat, uidVal, 0),
        members,
        messages: messages.map((m) => decodeMsg(m, uidVal)),
      });
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
      const m = db.addMessage(chatId, {
        id: msg.clientId || db.uid(),
        chatId,
        sender: uidVal,
        kind: msg.kind || 'text',
        ts,
        ...(chat.type === 'dm' ? (msg.cipher ? { cipher: msg.cipher } : { payload: msg.payload }) : { payload: msg.payload }),
        meta: msg.meta || {},
        edited: false,
        deleted: false,
        seenBy: [uidVal],
      });

      if (m.meta && m.meta.ghost_timer) {
        setTimeout(() => autoDeleteGhost(m), Math.min(m.meta.ghost_timer, 3600 * 1000) + 500);
      }

      chatBroadcast(chatId, { t: 'msg_new', chatId, message: decodeMsg(m, uidVal) }, uidVal);
      // echo back to sender (all their devices)
      broadcastTo(uidVal, { t: 'msg_new', chatId, message: decodeMsg(m, uidVal), self: true });
      return;
    }
    case 'msg_edit': {
      if (!uidVal || !chatId) return;
      const chat = db.getChat(chatId);
      const m = db.getMessage(chatId, msg.id);
      if (!m || m.sender !== uidVal || m.deleted) return;
      const patch = { edited: true };
      if (chat.type === 'dm') {
        if (msg.cipher) patch.cipher = msg.cipher; else patch.payload = msg.payload;
      } else patch.payload = msg.payload;
      if (msg.meta) patch.meta = msg.meta;
      const updated = db.updateMessage(chatId, msg.id, patch);
      chatBroadcast(chatId, { t: 'msg_updated', chatId, message: decodeMsg(updated, uidVal) });
      return;
    }
    case 'msg_delete': {
      if (!uidVal || !chatId) return;
      const m = db.getMessage(chatId, msg.id);
      if (!m || m.deleted) return;
      if (m.sender !== uidVal) return sendTo(ws, { t: 'error', code: 'no_permission', msg: 'Можно удалять только свои сообщения.' });
      const updated = db.updateMessage(chatId, msg.id, { deleted: true });
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
    default:
      return;
  }
}

function decodeMsg(m, uidVal) {
  if (m.deleted) return { ...m, deleted: true, payload: null, cipher: null };
  return { ...m };
}

function withUnread(chat, uidVal, unread) {
  return { ...chat, unread };
}

function autoDeleteGhost(m) {
  const chat = db.getChat(m.chatId);
  if (!chat) return;
  const fresh = db.getMessage(m.chatId, m.id);
  if (!fresh || fresh.deleted) return;
  db.updateMessage(m.chatId, m.id, { deleted: true });
  chatBroadcast(m.chatId, { t: 'msg_deleted', chatId: m.chatId, id: m.id, ghost: true });
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

  const chats = db.myChats(uidVal).map((c) => withUnread(c, uidVal, 0));
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