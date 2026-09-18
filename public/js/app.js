(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };

  const state = {
    me: null,
    token: localStorage.getItem('durov_token'),
    ws: null,
    chats: new Map(),
    members: new Map(),   // chatId -> Map<uid, user>
    currentChatId: null,
    messages: [],
    settings: loadSettings(),
    typing: new Map(),
    replyTo: null,
    ghost: { timer: 300000, views: 5 },
    hasMore: false,
    myUsers: new Map(),   // uid -> user (global profile cache)
    balance: 0,
    walletGifts: [],
    walletNft: [],
    nftCache: new Map(),  // slug -> public collectible
    catalog: [],
    switching: false,
  };

  // ---------------- мультиаккаунт ----------------
  const ACC_KEY = 'durov_accounts';
  function accountsList() {
    try { const a = JSON.parse(localStorage.getItem(ACC_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  function accountsPersist(list) { try { localStorage.setItem(ACC_KEY, JSON.stringify(list)); } catch {} }
  function accountsUpsert(me, token) {
    const jwks = Crypto.getJwks() || {};
    const list = accountsList().filter((x) => x.publicKeyPem !== me.pubkey);
    list.forEach((x) => (x.active = false));
    list.push({
      username: me.username,
      nickname: me.nickname,
      publicKeyPem: me.pubkey,
      publicJwk: jwks.publicJwk || null,
      privateJwk: jwks.privateJwk || null,
      token,
      active: true,
      ts: Date.now(),
    });
    accountsPersist(list);
  }
  function accountByToken(token) { return accountsList().find((a) => a.token === token) || null; }
  function forgotAccount(x) { accountsPersist(accountsList().filter((a) => !(a.username === x.username && a.publicKeyPem === x.publicKeyPem))); }

  function resetAppUi() {
    state.me = null;
    state.chats.clear();
    state.members.clear();
    state.messages = [];
    state.currentChatId = null;
    state.balance = 0;
    state.walletGifts = [];
    state.walletNft = [];
    state.nftCache.clear();
    state.catalog = [];
    $('chat-view').classList.add('hidden');
    $('empty-state').classList.remove('hidden');
    renderChatList();
    renderMyChip();
    refreshWalletChip();
  }

  async function executeAccount(acc) {
    state.token = acc.token;
    localStorage.setItem('durov_token', acc.token);
    if (acc.privateJwk && acc.publicJwk) {
      try { await Crypto.setFromJwk(acc.publicKeyPem, acc.publicJwk, acc.privateJwk); } catch {}
    }
    const list = accountsList();
    list.forEach((x) => (x.active = x.username === acc.username && x.publicKeyPem === acc.publicKeyPem));
    accountsPersist(list);
    resetAppUi();
    if (state.ws) { state.switching = true; state.ws.close(); }
    connect();
  }

  const EMOJI_LIST = ['😀','😁','😂','🤣','😅','😊','😉','😍','🥰','😘','😎','🤓','🥳','😔','😢','😭','😤','😡','🤯','😱','🤠','👻','💀','👽','🤖','👾','🦄','🐱','🐶','🦊','🐼','🦁','🐸','🦅','🐸','🐵','🐷','🐙','🦋','🌹','🌻','🔥','⚡','💎','💥','✨','🎯','🎁','🏆','🚀','✈️','🎮','🎧','🎸','🍕','🍔','🍩','🍺','☕','💊','💉','🧠','👑','💍','🏴‍☠️','🔫','🧨','🔑','🧩','🎲','🎭','🌙','⭐','🌈','❄️','💧','🫥','✅','❌'];

  const STICKERS = [
    { e: '🔥', n: 'Огонь', anim: 'bounce' }, { e: '😂', n: 'Смех', anim: 'shake' },
    { e: '❤️', n: 'Любовь', anim: 'heart' }, { e: '😂', n: 'Ржач', anim: 'flip' },
    { e: '👍', n: 'ОК', anim: 'pop' }, { e: '👎', n: 'Фу', anim: 'flop' },
    { e: '😎', n: 'Красавчик', anim: 'cool' }, { e: '🤯', n: 'Взрыв', anim: 'bang' },
    { e: '😭', n: 'Плак', anim: 'rain' }, { e: '🤑', n: 'Баблишко', anim: 'money' },
    { e: '👊', n: 'Кулак', anim: 'punch' }, { e: '🤝', n: 'Договор', anim: 'shake' },
    { e: '🙏', n: 'Спасибо', anim: 'pray' }, { e: '🕊️', n: 'Мир', anim: 'fly' },
    { e: '🚀', n: 'В космос', anim: 'fly' }, { e: '💯', n: 'Топ', anim: 'bang' },
    { e: '🎉', n: 'Праздник', anim: 'party' }, { e: '🌚', n: 'Луна', anim: 'slow' },
    { e: '👀', n: 'Наблюдаю', anim: 'peek' }, { e: '🍕', n: 'Пицца', anim: 'spin' },
    { e: '🧠', n: 'Мозг', anim: 'brain' }, { e: '☕', n: 'Кофе', anim: 'steam' },
  ];

  const GIFS = [
    { e: '🎉', n: 'Салют', anim: 'confetti' }, { e: '✨', n: 'Искры', anim: 'confetti' },
    { e: '💥', n: 'Бум', anim: 'bang' }, { e: '🌈', n: 'Радуга', anim: 'rainbow' },
    { e: '💫', n: 'Комета', anim: 'fly' }, { e: '🪩', n: 'Диско', anim: 'spin' },
    { e: '🌀', n: 'Вихрь', anim: 'spin' }, { e: '☄️', n: 'Метеор', anim: 'fly' },
    { e: '⚡', n: 'Молния', anim: 'bang' }, { e: '🌊', n: 'Волна', anim: 'wave' },
    { e: '🫧', n: 'Пузыри', anim: 'bubble' }, { e: '🎆', n: 'Фейерверк', anim: 'confetti' },
  ];

  // ---------------- websocket ----------------
  function scheme() { return location.protocol === 'https:' ? 'wss' : 'ws'; }
  function connect() {
    const ws = new WebSocket(`${scheme()}://${location.host}`);
    state.ws = ws;
    ws.onopen = () => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default' && state.me) {
        try { Notification.requestPermission(); } catch {}
      }
      if (state.token && Crypto.hasIdentity()) {
        send({ t: 'login', token: state.token, pubkey: Crypto.getPublic() });
      } else if (state.token) {
        send({ t: 'login', token: state.token });
      }
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      handle(m);
    };
    ws.onclose = () => {
      if (state.switching) { state.switching = false; return; }
      if (!state.me) $('onboarding')?.classList.remove('hidden');
      showToast('⚠️ Потеряно соединение. Переподключение…');
      setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
  }

  function send(obj) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj)); }

  // ---------------- server handlers ----------------
  function handle(m) {
    switch (m.t) {
      case 'registered':
      case 'logged_in': {
        state.me = m.me;
        state.token = m.token;
        localStorage.setItem('durov_token', m.token);
        state.myUsers.set(m.me.uid, m.me);
        accountsUpsert(m.me, m.token);
        hideOnboarding();
        renderMyChip();
        send({ t: 'wallet_get' });
        return;
      }
      case 'profile_updated':
        if (m.me) {
          state.me = m.me;
          if (state.myUsers.has(m.me.uid)) state.myUsers.set(m.me.uid, m.me);
          renderMyChip();
        } else if (m.user) {
          state.myUsers.set(m.user.uid, m.user);
        }
        renderChatList();
        if (state.currentChatId && getChat(state.currentChatId)) renderOpenChat(getChat(state.currentChatId));
        rerenderMessages();
        if ($('modal-view-profile')) refreshProfileModal();
        return;
      case 'chat_list':
        m.chats.forEach((c) => upsertChat(c));
        renderChatList();
        return;
      case 'unread_update': {
        const c = getChat(m.chatId);
        if (c) { c.unread = m.unread; renderChatList(); updateTitle(); }
        return;
      }
      case 'dm_created':
        upsertChat(m.chat);
        state.myUsers.set(m.other.uid, m.other);
        renderChatList();
        openChat(m.chat.id);
        return;
      case 'chat_created':
        upsertChat(m.chat);
        renderChatList();
        openChat(m.chat.id);
        return;
      case 'chat_invited':
        upsertChat(m.chat);
        renderChatList();
        showToast(`👋 Тебя добавили в «${m.chat.title}»`);
        return;
      case 'chat_opened': {
        upsertChat(m.chat);
        const mm = new Map();
        m.members.forEach((u) => { mm.set(u.uid, u); state.myUsers.set(u.uid, u); });
        state.members.set(m.chat.id, mm);
        state.messages = m.messages;
        state.hasMore = !!m.more;
        jumpPendingId = null;
        renderChatList();
        renderOpenChat(m.chat);
        markSeen();
        return;
      }
      case 'chat_more': {
        if (state.currentChatId !== m.chatId) return;
        const box = $('messages');
        const prevHeight = box.scrollHeight;
        const prevScrollTop = box.scrollTop;
        Promise.all(m.messages.map((x) => promiseMsg(x))).then((decoded) => {
          const known = new Set(state.messages.map((x) => x.id));
          state.messages = [...decoded.filter((x) => !known.has(x.id)), ...state.messages];
          state.messages.sort((a, b) => a.ts - b.ts);
          state.hasMore = !!m.more;
          rerenderMessages(true);
          const nbox = $('messages');
          nbox.scrollTop = prevScrollTop + (nbox.scrollHeight - prevHeight);
          if (jumpPendingId) { const jid = jumpPendingId; jumpPendingId = null; jumpToMessage(jid); }
        });
        return;
      }
      case 'msg_search_results': {
        mergeSearchResults(m.messages);
        if (chatSearchActive) recomputeChatSearch();
        rerenderMessages();
        return;
      }
      case 'chat_forced_close':
      case 'chat_force_close': {
        if (state.currentChatId === m.chatId) closeToEmpty();
        return;
      }
      case 'chat_updated':
        upsertChat(m.chat);
        if (state.members.has(m.chat.id)) state.members.get(m.chat.id).set(m.chat.owner, state.myUsers.get(m.chat.owner) || { uid: m.chat.owner });
        renderChatList();
        if (state.currentChatId === m.chat.id) renderOpenChat(getChat(m.chat.id));
        return;
      case 'members_updated': {
        const mm = state.members.get(m.chatId) || new Map();
        m.ids.forEach((uid) => { if (!mm.has(uid) && state.myUsers.has(uid)) mm.set(uid, state.myUsers.get(uid)); });
        renderMembersInfo();
        refreshSubtitle();
        return;
      }
      case 'member_left':
        if ($('modal-members') && state.currentChatId === m.chatId) showToast('👋 Участник покинул чат');
        return;
      case 'presence': {
        const uid = m.presence.uid;
        if (state.myUsers.has(uid)) state.myUsers.get(uid).online = m.presence.online;
        const mm = state.members.get(m.chatId);
        if (mm && mm.has(uid)) { mm.get(uid).online = m.presence.online; }
        renderPresence(m.chatId, uid, m.presence.online);
        if (state.currentChatId === m.chatId) refreshSubtitle();
        renderChatList();
        return;
      }
      case 'search_results':
        renderSearch(m.users);
        if (window._dmSearchCb) window._dmSearchCb(m.users);
        return;
      case 'msg_new': handleNewMessage(m, !!m.self); return;
      case 'msg_updated': handleUpdatedMessage(m); return;
      case 'msg_deleted': handleDeletedMessage(m); return;
      case 'msg_seen': handleSeen(m); return;
      case 'typing': handleTyping(m); return;
      case 'error':
        showToast('⛔ ' + m.msg);
        if (m.code === 'bad_token') {
          state.token = '';
          localStorage.removeItem('durov_token');
          $('onboarding')?.classList.remove('hidden');
        }
        return;
      case 'wallet': {
        state.balance = m.balance || 0;
        state.walletGifts = m.gifts || [];
        state.walletNft = m.nft || [];
        refreshWalletChip();
        if ($('modal-wallet')) renderWalletModal();
        return;
      }
      case 'wallet_update':
        state.balance = m.balance || 0;
        refreshWalletChip();
        if ($('modal-wallet')) renderWalletModal();
        return;
      case 'gifts_catalog': {
        state.catalog = m.gifts || [];
        state.balance = m.balance || 0;
        refreshWalletChip();
        if ($('modal-wallet')) renderWalletModal();
        return;
      }
      case 'gift_bought':
        showToast('🎁 Подарок добавлен в коллекцию');
        state.balance = m.balance != null ? m.balance : state.balance;
        refreshWalletChip();
        send({ t: 'wallet_get' });
        if ($('modal-wallet')) renderWalletModal();
        return;
      case 'gift_sent':
        showToast('🎁 Ты подарил «' + (m.gift ? m.gift.name : '') + '»');
        state.balance = m.balance != null ? m.balance : state.balance;
        refreshWalletChip();
        send({ t: 'wallet_get' });
        if ($('modal-wallet')) renderWalletModal();
        return;
      case 'gift_received':
        showToast('🎁 Тебе подарили «' + (m.gift ? m.gift.name : '') + '» (+' + (m.bonus || 0) + ' ⭐)');
        state.balance = m.balance != null ? m.balance : state.balance;
        refreshWalletChip();
        if (state.me) send({ t: 'wallet_get' });
        return;
      case 'gift_upgraded':
        showToast('💎 Подарок стал уникальным NFT!');
        state.balance = m.balance != null ? m.balance : state.balance;
        refreshWalletChip();
        send({ t: 'wallet_get' });
        if ($('modal-wallet')) renderWalletModal();
        return;
      case 'gift_withdrawn':
        showToast('💸 Подарок обменен на звёзды');
        state.balance = m.balance != null ? m.balance : state.balance;
        refreshWalletChip();
        send({ t: 'wallet_get' });
        if ($('modal-wallet')) renderWalletModal();
        return;
      case 'nft_list':
        m.auctions.forEach((c) => state.nftCache.set(c.slug, c));
        m.mine.forEach((c) => state.nftCache.set(c.slug, c));
        if ($('modal-wallet')) renderWalletModal();
        return;
      case 'nft_update':
        state.nftCache.set(m.c.slug, m.c);
        if ($('modal-wallet')) renderWalletModal();
        return;
      case 'nft_bid_ok':
        showToast('✅ Ставка ' + m.amount + ' ⭐ принята');
        state.balance = m.balance != null ? m.balance : state.balance;
        refreshWalletChip();
        if (m.c) state.nftCache.set(m.c.slug, m.c);
        if ($('modal-wallet')) renderWalletModal();
        return;
      case 'nft_bought':
        showToast('💎 NFT @' + m.slug + ' теперь твой');
        state.balance = m.balance != null ? m.balance : state.balance;
        refreshWalletChip();
        send({ t: 'wallet_get' });
        if ($('modal-wallet')) renderWalletModal();
        return;
      case 'nft_won':
        showToast('🏆 Ты выиграл аукцион @' + m.slug + '!');
        if (state.me) send({ t: 'wallet_get' });
        if ($('modal-wallet')) renderWalletModal();
        return;
      case 'nft_sold':
        showToast('📢 Аукцион @' + m.slug + ' запущен');
        if ($('modal-wallet')) renderWalletModal();
        return;
      case 'nft_cancelled':
        showToast('↩️ Аукцион @' + m.slug + ' снят');
        if ($('modal-wallet')) renderWalletModal();
        return;
      case 'nft_sold_out':
        showToast('💰 @' + m.slug + ' продан! +' + (m.proceeds || 0) + ' ⭐ (минус комиссия)');
        if (state.me) send({ t: 'wallet_get' });
        if ($('modal-wallet')) renderWalletModal();
        return;
      case 'nft_claimed': {
        if (m.me) {
          state.me = m.me;
          state.myUsers.set(m.me.uid, m.me);
        }
        showToast('👑 Юзернейм теперь @' + m.username + ' (NFT)');
        renderMyChip();
        if (state.currentChatId && getChat(state.currentChatId)) renderOpenChat(getChat(state.currentChatId));
        if (state.me) send({ t: 'wallet_get' });
        if ($('modal-wallet')) renderWalletModal();
        return;
      }
    }
  }

  // ---------------- chat list state ----------------
  function upsertChat(c) {
    state.chats.set(c.id, c);
    if (!state.members.has(c.id)) state.members.set(c.id, new Map());
  }
  function getChat(id) { return state.chats.get(id); }

  function chatTitle(c) {
    if (c.type === 'dm') {
      const other = dmOther(c);
      return other ? (other.nickname || other.username) : '…';
    }
    return c.title;
  }
  function chatSubtitle(c) {
    if (c.type === 'dm') { const o = dmOther(c); return o ? '@' + o.username : ''; }
    if (c.type === 'channel') return `📢 ${c.members.length} подписчиков`;
    return `👥 ${c.members.length} участников`;
  }
  function dmOther(c) {
    if (!state.me) return null;
    const uid = (c.members || []).find((x) => x !== state.me.uid);
    return uid ? state.myUsers.get(uid) || null : null;
  }
  function chatAvatarStyle(c) {
    const name = chatTitle(c) || '?';
    let img = c.avatar || null;
    if (!img && c.type === 'dm') {
      const o = dmOther(c);
      if (o && o.avatar) img = o.avatar;
    }
    return { text: name.replace(/^\p{Extended_Pictographic}/u, '').trim().slice(0, 2) || (c.type === 'channel' ? '📢' : '💬'), pal: paletteFor(name), img };
  }

  function avatarHtml(av, cls) {
    cls = cls || 'avatar';
    const bg = `background:linear-gradient(135deg,${av.pal[0]},${av.pal[1]})`;
    return av.img
      ? `<div class="${cls}" style="${bg}"><img src="${esc(av.img)}" alt=""></div>`
      : `<div class="${cls}" style="${bg}">${esc(av.text)}</div>`;
  }

  function paletteFor(name) {
    const pals = [
      ['#7c3aed', '#d946ef'], ['#2563eb', '#06b6d4'], ['#059669', '#34d399'],
      ['#d97706', '#fbbf24'], ['#dc2626', '#f97316'], ['#0d9488', '#2dd4bf'],
      ['#4f46e5', '#a855f7'], ['#db2777', '#ec4899'], ['#4338ca', '#6366f1'],
    ];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return pals[h % pals.length];
  }

  // ---------------- rendering: sidebar ----------------
  function renderChatList() {
    const list = $('chat-list');
    list.innerHTML = '';
    const sorted = [...state.chats.values()].sort((a, b) => {
      const la = lastMsgTs(a.id), lb = lastMsgTs(b.id);
      return (lb || a.created || 0) - (la || b.created || 0);
    });
    for (const c of sorted) {
      const item = el('div', 'chat-item' + (c.id === state.currentChatId ? ' active' : ''));
      const av = chatAvatarStyle(c);
      const unread = c.unread || 0;
      const dm = c.type === 'dm';
      let statusDot = '';
      if (dm) { const o = dmOther(c); if (o && o.online) statusDot = '<i class="online-dot"></i>'; }
      item.innerHTML = `
        ${avatarHtml(av)}
        <div class="chat-item-main">
          <div class="chat-item-title">${esc(chatTitle(c))}</div>
          <div class="chat-item-last">${preview(c.id)}</div>
        </div>
        <div class="chat-item-right">
          <div class="chat-item-time">${fmtTime(lastMsgTs(c.id))}</div>
          ${unread ? `<div class="badge">${unread}</div>` : ''}${statusDot}
        </div>`;
      item.onclick = () => openChat(c.id);
      list.appendChild(item);
    }
    if (!sorted.length) list.appendChild(el('div', 'chat-list-empty', 'Пока пусто.<br/>Найди пользователя или создай группу.'));
    attachPresenceDots();
  }

  function preview(chatId) {
    const arr = state.chats.get(chatId)?.last || null;
    return esc(arr ? msgPreview(arr) : entityHint(getChat(chatId)));
  }
  function entityHint(c) {
    if (!c) return '';
    return c.type === 'dm' ? '💬 Напиши первым…' : (c.type === 'channel' ? '📢 Канал' : '👥 Группа создана');
  }
  function lastMsgTs(chatId) {
    const c = state.chats.get(chatId);
    if (c && c.lastTs) return c.lastTs;
    return c ? c.created : 0;
  }

  // ---------------- messages state ----------------
  function openChat(chatId) {
    state.currentChatId = chatId;
    send({ t: 'chat_open', chatId });
    $('chat-view').classList.remove('hidden');
    $('empty-state').classList.add('hidden');
    renderChatList();
    document.title = 'DUROV MSG — ' + (chatTitle(getChat(chatId)) || '');
  }
  function closeToEmpty() {
    state.currentChatId = null;
    $('chat-view').classList.add('hidden');
    $('empty-state').classList.remove('hidden');
    renderChatList();
  }

  function renderOpenChat(chat) {
    const c = getChat(chat.id) || chat;
    const av = chatAvatarStyle(c);
    const avEl = $('chat-avatar');
    avEl.style.background = `linear-gradient(135deg,${av.pal[0]},${av.pal[1]})`;
    avEl.textContent = '';
    if (av.img) avEl.innerHTML = `<img src="${esc(av.img)}" alt="">`;
    else avEl.textContent = av.text;
    $('chat-title').textContent = chatTitle(c);
    refreshSubtitle();
    const mm = state.members.get(c.id) || new Map();
    if (mm.size) {
      updateChatMembersFromMessages();
      addSystemMessages();
    }
    rerenderMessages();
    applyAtmosphere();
  }

  function refreshSubtitle() {
    const c = getChat(state.currentChatId);
    if (!c) return;
    const typingUsers = [...state.typing.entries()].filter(([cid]) => cid === state.currentChatId).map(([,]) => 1).length;
    if (typingUsers) {
      $('chat-subtitle').textContent = 'печатает…';
      $('chat-subtitle').classList.add('typing-col');
    } else {
      $('chat-subtitle').textContent = chatSubtitle(c);
      $('chat-subtitle').classList.remove('typing-col');
    }
  }

  function updateChatMembersFromMessages() {
    const mm = state.members.get(state.currentChatId);
    if (!mm) return;
    for (const m of state.messages) {
      if (m.sender && !mm.has(m.sender)) {
        const u = state.myUsers.get(m.sender);
        if (u) mm.set(m.sender, u);
      }
    }
  }

  function msgPreview(m) {
    if (m.deleted) return '🗑 удалено';
    if (m.meta?.ghost) return '🫥 Призрачное сообщение';
    if (m.kind === 'ghost') return '🫥 Призрачное сообщение';
    if (m.kind === 'voice') return '🎤 Голосовое · ' + fmtDur(m.payload?.duration);
    if (m.kind === 'card') return '📇 Ник-карточка';
    if (m.kind === 'gif') return '🎬 Гифка';
    if (m.kind === 'sticker') return '🟨 Стикер';
    if (m.kind === 'image') return '🖼 Картинка';
    if (m.kind === 'file') return '📎 Файл';
    const t = (m.payload || m.localPayload || '');
    const txt = typeof t === 'object' ? JSON.stringify(t) : String(t).replace(/\n/g, ' ');
    return txt.length > 40 ? txt.slice(0, 40) + '…' : txt;
  }

  function handleNewMessage(m, self) {
    const chat = getChat(m.chatId);
    if (chat) {
        chat.lastTs = m.message.ts;
        chat.last = m.message;
        if (!self && state.currentChatId !== m.chatId) {
          chat.unread = (chat.unread || 0) + 1;
        } else if (self) {
          chat.unread = 0;
        }
      }
    const isCurrent = state.currentChatId === m.chatId;
    if (!self && chat && state.currentChatId !== m.chatId) {
      if (state.settings.sound) playPop();
      if (document.hidden) {
        try {
          const nm = new Notification('DUROV MSG — ' + chatTitle(chat), { body: msgPreview(m.message), icon: 'img/icon.png' });
          setTimeout(() => nm.close(), 5000);
        } catch {}
      }
    }
    const canDecrypt = isCurrent || (chat && chat.type !== 'dm');
    promiseMsg(m.message).then((decoded) => {
      decoded._self = !!self;
      decoded._decrypted = true;
      if (chat) chat.last = decoded;
      if (isCurrent) {
        state.messages.push(decoded);
        rerenderMessages();
        markSeen();
        maybeFx(decoded);
      } else {
        renderChatList();
      }
    }).catch(() => {
      renderChatList();
    });
    if (!isCurrent) renderChatList();
    updateTitle();
  }

  function playPop() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(520, ctx.currentTime + 0.12);
      g.gain.setValueAtTime(0.12, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.15);
    } catch {}
  }

  function updateTitle() {
    let total = 0;
    for (const c of state.chats.values()) total += c.unread || 0;
    document.title = total > 0 ? `(${total}) DUROV MSG` : (state.currentChatId ? 'DUROV MSG — ' + (chatTitle(getChat(state.currentChatId)) || '') : 'DUROV MSG');
  }

  function handleUpdatedMessage(m) {
    const chat = getChat(m.chatId);
    if (chat) { chat.lastTs = m.message.ts; chat.last = m.message; }
    if (state.currentChatId === m.chatId) {
      promiseMsg(m.message).then((decoded) => {
        const i = state.messages.findIndex((x) => x.id === decoded.id);
        if (i >= 0) {
          state.messages[i] = Object.assign(state.messages[i], decoded);
          rerenderMessages();
        }
      });
    } else renderChatList();
  }

  function handleDeletedMessage(m) {
    if (m.ghost && state.currentChatId === m.chatId) {
      const i = state.messages.findIndex((x) => x.id === m.id);
      if (i >= 0) {
        state.messages[i]._gone = true;
        rerenderMessages();
      }
    } else if (state.currentChatId !== m.chatId) {
      const chat = getChat(m.chatId);
      if (chat && chat.last && chat.last.id === m.id) { chat.last.deleted = true; renderChatList(); }
    } else {
      const i = state.messages.findIndex((x) => x.id === m.id);
      if (i >= 0) { state.messages[i].deleted = true; rerenderMessages(); }
    }
  }

  function handleSeen(m) {
    if (state.currentChatId !== m.chatId || (m.uid === state.me?.uid)) return;
    const msg = state.messages.find((x) => x.id === m.id);
    if (msg) {
      if (!msg.seenBy) msg.seenBy = [msg.sender];
      if (!msg.seenBy.includes(m.uid)) msg.seenBy.push(m.uid);
      updateTicks();
    }
  }

  function handleTyping(m) {
    if (m.uid === state.me?.uid || !m.typing) {
      if (!m.typing) state.typing.delete(m.chatId + ':' + m.uid);
      if (state.currentChatId === m.chatId) refreshSubtitle();
      return;
    }
    if (m.typing) {
      state.typing.set(m.chatId + ':' + m.uid, Date.now());
      if (state.currentChatId === m.chatId) refreshSubtitle();
      if (state.currentChatId === m.chatId) $('typing-indicator').classList.remove('hidden');
      setTimeout(() => { state.typing.delete(m.chatId + ':' + m.uid); refreshSubtitle(); }, 3000);
    }
  }

  // decrypt async
  function promiseMsg(m) {
    return Promise.resolve().then(() => {
      if (m.deleted) return { ...m };
      const chat = getChat(m.chatId);
      if (chat && chat.type === 'dm' && !m.payload) {
        const peer = dmOther(chat);
        if (!peer || !Crypto.hasIdentity()) return m;
        return Crypto.decryptFrom(peer.pubkey, m.cipher).then((plain) => {
          let payload = plain;
          if (typeof plain === 'string') payload = plain;
          else if (plain && typeof plain === 'object' && plain.text !== undefined && plain.payload === undefined) payload = plain.text;
          return { ...m, payload, meta: Object.assign(m.meta || {}, (plain && plain.meta) || {}) };
        });
      }
      return m;
    });
  }

// ---------------- rendering messages ----------------
function rerenderMessages(preserveScroll) {
    const box = $('messages');
    box.innerHTML = '';
    const frag = document.createDocumentFragment();
    const c = getChat(state.currentChatId);
    let lastSender = null;
    let lastDayKey = null;

    if (state.hasMore && !chatSearchActive) {
      const moreBtn = el('button', 'load-more', '⬆ Загрузить старые сообщения');
      moreBtn.onclick = loadOlder;
      frag.appendChild(moreBtn);
    }

    let msgs = state.messages;

    if (chatSearchActive && chatSearchQuery) {
      const matchedIds = new Set(chatSearchMatches.map((x) => x.id));
      msgs = state.messages.filter((m) => matchedIds.has(m.id));
    }

    for (const m of msgs) {
      const dayKey = m.ts ? new Date(m.ts).toDateString() : null;
      if (dayKey && dayKey !== lastDayKey && msgs.length > 1) {
        frag.appendChild(renderDayDivider(m.ts));
        lastDayKey = dayKey;
      }
      const mine = m._self || (state.me && m.sender === state.me.uid);
      const md = isGhostActive(m) ? Object.assign({}, m, { deleted: true, kind: 'ghost' }) : m;
      if (md.deleted && md.id) {
        frag.appendChild(renderDeletedLine(md));
        continue;
      }
      if (m.kind === 'system') {
        frag.appendChild(renderSystemLine(m));
        continue;
      }
      if (m._gone) {
        frag.appendChild(renderGhostGone(m));
        continue;
      }
      frag.appendChild(renderBubble(m, mine, c));
      lastSender = mine ? 'me' : m.sender;
    }
    box.appendChild(frag);
    if (!preserveScroll) scrollToBottom();
    updateTicks();
  }

  function renderBubble(m, mine, chat) {
    const sender = state.myUsers.get(m.sender) || (chat && chat.type === 'dm' ? dmOther(chat) : null);
    const name = sender ? (sender.nickname || sender.username) : 'неизвестно';
    const av = chatAvatarStyle({ ...(chat || {}), title: name });
    const wrap = el('div', 'msg-row ' + (mine ? 'mine' : 'theirs'));

    const needsAuthor = !mine && (chat && chat.type !== 'dm');
    const rows = [];
    const bubble = el('div', 'bubble' + (mine ? ' mine' : '') + (m.meta?.ghost || m.kind === 'ghost' ? ' ghost' : ''));
    bubble.dataset.mid = m.id;

    if (m.meta?.forwarded) {
      bubble.appendChild(el('div', 'forwarded-chip', '↪️ переслано от ' + esc(m.meta.forwarded.name)));
    }

    if (m.kind === 'voice') {
      bubble.classList.add('media');
      bubble.appendChild(renderVoice(m));
    } else if (m.kind === 'card') {
      bubble.appendChild(renderUserCard(m.payload, m));
    } else if (m.kind === 'gif' || m.kind === 'sticker') {
      bubble.classList.add('media');
      const anim = m.payload?.anim || (m.payload?.kind === 'img' ? '' : '');
      if (m.kind === 'gif' && m.payload?.kind === 'img') {
        bubble.appendChild(el('img', 'gif-img', ''));
        bubble.querySelector('img').src = m.payload.url;
      } else {
        bubble.appendChild(el('div', 'gif-emoji ' + (anim || 'bounce'), esc(m.payload?.e || '🎬')));
        bubble.appendChild(el('div', 'gif-cap', esc(m.payload?.n || '')));
      }
    } else if (m.kind === 'image') {
      bubble.classList.add('media');
      const img = el('img', 'chat-img', '');
      img.src = m.payload?.url || m.payload?.src || m.payload || '';
      img.onclick = () => openImageModal(img.src);
      bubble.appendChild(img);
    } else if (m.kind === 'file') {
      bubble.appendChild(el('div', 'file-cell', esc(m.payload?.name || 'Файл')));
      const link = el('a', 'file-dl', '⬇️ Скачать');
      link.href = m.payload?.url || m.payload?.src || '#';
      link.download = m.payload?.name || 'file';
      bubble.appendChild(link);
    } else {
      const quote = m.meta?.reply || m.quote;
      if (quote && (quote.text || quote.id)) {
        const q = el('div', 'quoted pointer');
        q.textContent = '↪️ ' + replyLabel(quote);
        q.onclick = () => jumpToMessage(quote.id);
        bubble.appendChild(q);
      }
      const p = el('div', 'bubble-text', linkify(esc(textOf(m))));
      bubble.appendChild(p);
      if (m.meta?.ghost || m.kind === 'ghost') {
        const meta = ghostMetaInfo(m);
        bubble.appendChild(el('div', 'ghost-badge', '🫥 ' + meta));
      }
    }

    const foot = el('div', 'bubble-foot');
    foot.appendChild(el('span', 'msg-time', fmtTime(m.ts)));
    if (mine) {
      foot.appendChild(el('span', 'ticks ' + (m.seenBy && m.seenBy.length > 1 ? 'seen' : ''), m.seenBy && m.seenBy.length > 1 ? '✓✓' : '✓'));
    }
    if (m.edited) foot.appendChild(el('span', 'edited', 'изменено'));
    bubble.appendChild(foot);

    if (!m.meta?.ghost && m.kind !== 'ghost') {
      const rp = el('button', 'react-plus', '🙂');
      rp.title = 'Реакция';
      rp.onclick = (e) => { e.stopPropagation(); openReactionPicker(m); };
      bubble.appendChild(rp);
    }

    if (needsAuthor) {
      const head = el('div', 'msg-author');
      head.innerHTML = `<span class="mini-ava" style="background:linear-gradient(135deg,${av.pal[0]},${av.pal[1]})">${esc(av.text)}</span><b style="color:${av.pal[0]}">${esc(name)}</b><span class="msg-ts">${fmtTime(m.ts)}</span>`;
      bubble.prepend(head);
    }

    // actions
    bubble.oncontextmenu = (e) => { e.preventDefault(); bubbleMenu(e, m, mine); };

    rows.push(bubble);
    const reacts = el('div', 'reaction-row');
    (m.meta?.reactions || []).forEach((r) => {
      const chip = el('span', 'reaction-chip', esc(r.e));
      chip.title = r.uids.join(', ');
      chip.onclick = () => toggleReaction(m, r.e);
      reacts.appendChild(chip);
    });
    if (reacts.children.length) rows.push(reacts);

    const out = el('div', 'msg-stack', '');
    rows.forEach((r) => out.appendChild(r));
    wrap.appendChild(out);

    if (mine && m.kind === 'ghost') mightRefundGhost(m);
    return wrap;
  }

  function renderSystemLine(m) {
    const row = el('div', 'system-line', '📌 ' + esc(m.payload && m.payload.text ? m.payload.text : ''));
    return row;
  }

  function renderDayDivider(ts) {
    const d = new Date(ts);
    const now = new Date();
    const label = d.toDateString() === now.toDateString() ? 'Сегодня'
      : new Date(now.getTime() - 864e5).toDateString() === d.toDateString() ? 'Вчера'
      : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
    return el('div', 'day-divider', label);
  }

  function renderDeletedLine(m) {
    return el('div', 'deleted-line', mineCheck(m) ? 'Вы удалили сообщение' : 'Сообщение удалено');
  }
  function mineCheck(m) { return state.me && m.sender === state.me.uid; }

  function renderGhostGone(m) {
    return el('div', 'deleted-line ghost-gone', '🫥 Призрачное сообщение растаяло');
  }

  function renderVoice(m) {
    const dur = m.payload?.duration || 0;
    const wrap = el('div', 'voice-cell', '');
    const play = el('button', 'voice-play', '▶');
    const bar = el('div', 'voice-bar', '');
    const time = el('span', 'voice-time', fmtDur(dur));
    wrap.append(play, bar, time);
    const audioURL = m.payload?.audio || m.payload?.url;
    let audio = null;
    play.onclick = () => {
      if (!audio) {
        audio = new Audio(audioURL);
        audio.onended = () => { play.textContent = '▶'; play.classList.remove('playing'); };
        audio.onplay = () => { play.textContent = '❚❚'; play.classList.add('playing'); };
        audio.onpause = () => { play.textContent = '▶'; play.classList.remove('playing'); };
        audio.ontimeupdate = () => { bar.style.setProperty('--p', (audio.currentTime / Math.max(audio.duration, 0.01)) * 100 + '%'); };
      }
      if (audio.paused) audio.play(); else audio.pause();
    };
    return wrap;
  }

  function fmtDur(s) {
    s = Math.round(s || 0);
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function renderUserCard(payload) {
    const card = el('div', 'usercard', '');
    const p = payload || {};
    const av = chatAvatarStyle(p);
    card.innerHTML = `
      <div class="usercard-ava" style="background:linear-gradient(135deg,${av.pal[0]},${av.pal[1]})">${esc(av.text)}</div>
      <div class="usercard-main">
        <div class="usercard-name">${esc(p.nickname || p.username || 'Пользователь')}</div>
        <div class="usercard-username">@${esc(p.username || '')}</div>
        <div class="usercard-bio">${esc((p.bio || '').slice(0, 80))}</div>
      </div>
      <button class="usercard-btn">Открыть</button>`;
    card.querySelector('.usercard-btn').onclick = () => {
      openProfileFromCard(p);
    };
    return card;
  }

  function openProfileFromCard(p) {
    if (p.uid && state.myUsers.has(p.uid)) return openProfileModal(p.uid);
    const fake = { uid: p.uid, username: p.username, nickname: p.nickname, avatar: p.avatar, bio: p.bio };
    const av = chatAvatarStyle(fake);
    openModal(modalShell('Ник-карточка', `
      <div class="profile-card">
        <div class="big-ava" style="background:linear-gradient(135deg,${av.pal[0]},${av.pal[1]})">${esc(av.text)}</div>
        <div class="p-name">${esc(p.nickname || p.username)}</div>
        <div class="p-username">@${esc(p.username)}</div>
        <div class="p-bio">${esc(p.bio || 'Без описания')}</div>
        <button class="btn primary" id="btn-card-dm">💬 Написать</button>
      </div>`));
    $('btn-card-dm').onclick = () => {
      if (p.uid) { send({ t: 'dm_create', username: p.username }); modalRoot().innerHTML = ''; }
      else showToast('Нельзя написать: пользователь не найден.');
    };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function linkify(s) {
    return s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')
            .replace(/@([a-zA-Z0-9_]{2,})/g, function (m, u) { return m; });
  }
  function textOf(m) {
    const p = m.payload;
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object') return (p.text || '');
    return m.localPayload ?? '';
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    return d.toLocaleDateString('ru-RU');
  }

  function sameDay(ts) {
    const a = new Date(ts), b = new Date();
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { const m = $('messages'); m.scrollTop = m.scrollHeight; });
  }

  function addSystemMessages() {
    const c = getChat(state.currentChatId);
    if (!c) return;
    state.messages.sort((a, b) => a.ts - b.ts);
  }

  function markSeen() {
    if (!state.messages.length) return;
    const last = state.messages[state.messages.length - 1];
    if (last.sender && last.sender !== state.me?.uid) {
      send({ t: 'msg_seen', chatId: state.currentChatId, id: last.id });
    }
    const c = getChat(state.currentChatId);
    if (c) { c.unread = 0; renderChatList(); updateTitle(); }
  }

  function updateTicks() {
    if (!state.currentChatId) return;
    document.querySelectorAll('#messages .bubble').forEach((b) => {
      const id = b.dataset.mid;
      const m = state.messages.find((x) => x.id === id);
      if (!m || !m.seenBy) return;
      const seen = m.seenBy.length > 1;
      const tick = b.querySelector('.ticks');
      if (tick) {
        tick.textContent = seen ? '✓✓' : '✓';
        tick.classList.toggle('seen', seen);
      }
    });
  }

  function loadOlder() {
    if (!state.hasMore || !state.messages.length) return;
    const before = state.messages[0].ts;
    send({ t: 'chat_more', chatId: state.currentChatId, before });
  }

  function mergeSearchResults(msgs) {
    if (!msgs || !msgs.length) return;
    const known = new Set(state.messages.map((m) => m.id));
    for (const m of msgs) { if (!known.has(m.id)) state.messages.push(m); }
    state.messages.sort((a, b) => a.ts - b.ts);
  }

  // ---------------- upload helper ----------------
  async function uploadBlob(blob) {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream', 'Authorization': 'Bearer ' + (state.token || '') },
      body: blob,
    });
    if (!res.ok) throw new Error('upload failed');
    const j = await res.json();
    return j.url;
  }

  // ---------------- composing ----------------
  function ensureDecryptableText() {
    const c = getChat(state.currentChatId);
    if (c && c.type === 'dm') {
      const peer = dmOther(c);
      if (peer && !peer.pubkey) {
        showToast('Собеседник не подключился с крипто-ключом — E2E недоступно.');
      }
    }
  }

  async function sendMessage(kind, payload, extraMeta, targetChatId) {
    const chatId = targetChatId || state.currentChatId;
    const input = $('msg-input');
    if (!chatId) return;
    const isTextMedia = kind === 'text' && typeof payload === 'string';
    const text = (typeof payload === 'string' ? payload : (!payload && input ? input.value : '')).trim();
    if (kind === 'text' && !text && !payload) return;

    const c = getChat(chatId);
    const meta = Object.assign({}, extraMeta || {});
    if (kind === 'ghost') {
      meta.ghost = true;
      meta.ghost_timer = state.ghost.timer || 0;
      meta.ghost_views = state.ghost.views || 0;
    }
    if (state.replyTo && chatId === state.currentChatId) meta.reply = state.replyTo;

    const msgValue = typeof payload === 'object' ? payload : text;

    let msgSend = {};
    if (c.type === 'dm' && Crypto.hasIdentity()) {
      const peer = dmOther(c);
      let cipher = null;
      if (peer && peer.pubkey) {
        try {
          cipher = await Crypto.encryptFor(peer.pubkey, msgValue);
        } catch (e) { console.error('encrypt failed, send plaintext', e); }
      }
      msgSend = cipher ? { cipher } : { payload: msgValue };
    } else {
      msgSend = { payload: msgValue };
    }
    const clientId = 'm' + Date.now() + Math.random().toString(36).slice(2, 8);
    send({ t: 'msg_send', chatId, kind: (kind === 'ghost' ? 'text' : kind), clientId, ...msgSend, meta });

    const local = {
      id: clientId,
      chatId,
      sender: state.me.uid,
      kind,
      ts: Date.now(),
      payload: msgValue,
      meta,
      _self: true,
      _decrypted: true,
    };
    if (['image', 'file', 'gif', 'sticker', 'voice', 'card'].includes(kind)) {
      local.kind = kind;
    }
    if (kind === 'gif' && payload && payload.kind === 'emoji') local.kind = 'gif';
    if (targetChatId && targetChatId !== state.currentChatId) {
      const tc = getChat(targetChatId);
      if (tc) { tc.last = local; tc.lastTs = local.ts; }
      renderChatList();
      return;
    }
    state.messages.push(local);
    state.messages.sort((a, b) => a.ts - b.ts);
    const chat = getChat(chatId);
    if (chat) { chat.last = local; chat.lastTs = local.ts; chat.unread = 0; }
    rerenderMessages();
    renderChatList();
    maybeFx(local);
    if (input) input.value = '';
    if (state.replyTo) { state.replyTo = null; hideReplyBar(); }
    sendTyping(false);
  }

  function sendTyping(typing) {
    send({ t: 'typing', chatId: state.currentChatId, typing });
  }

  // ---------------- reactions + fx ----------------
  function toggleReaction(m, e) {
    const my = state.me.uid;
    if (!m.meta) m.meta = {};
    const existing = (m.meta.reactions || []).find((r) => r.e === e);
    if (existing) {
      if (existing.uids.includes(my)) {
        existing.uids = existing.uids.filter((x) => x !== my);
        if (!existing.uids.length) m.meta.reactions = m.meta.reactions.filter((r) => r !== existing);
      } else existing.uids.push(my);
    } else {
      if (!m.meta.reactions) m.meta.reactions = [];
      m.meta.reactions.push({ e, uids: [my] });
    }
    const chat = getChat(state.currentChatId);
    if (chat && chat.type === 'dm' && state.me) {
      send({ t: 'msg_edit', chatId: state.currentChatId, id: m.id, meta: m.meta });
      rerenderMessages();
    } else {
      send({ t: 'msg_edit', chatId: state.currentChatId, id: m.id, meta: m.meta });
      rerenderMessages();
    }
    maybeFx({ payload: e });
  }

  function openReactionPicker(m) {
    const cells = EMOJI_LIST.map((e, i) =>
      `<button class="reaction-pick" data-e="${i}">${e}</button>`
    ).join('');
    openModal(modalShell('Реакция', `<div class="reaction-grid">${cells}</div>`));
    modalRoot().querySelectorAll('.reaction-pick').forEach((b) => {
      b.onclick = () => { toggleReaction(m, EMOJI_LIST[Number(b.dataset.e)]); modalRoot().innerHTML = ''; };
    });
  }

  function maybeFx(m) {
    if (!m || m._fx) return;
    const e = (m.payload && m.payload.e) || m.meta?.fx || m.payload;
    if (typeof e === 'string' && /^[\p{Extended_Pictographic}]$/u.test(e)) {
      burstEmoji(e);
    }
  }

  function burstEmoji(e) {
    const canvas = $('fx-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = innerWidth; canvas.height = innerHeight;
    const n = 26;
    const parts = [];
    for (let i = 0; i < n; i++) {
      parts.push({
        x: innerWidth / 2, y: innerHeight / 2,
        vx: (Math.random() - 0.5) * 14, vy: (Math.random() - 0.5) * 14 - 4,
        s: 18 + Math.random() * 26, e, r: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.3,
        life: 1,
      });
    }
    let frame = 0;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = '28px sans-serif';
      parts.forEach((p) => {
        p.x += p.vx; p.y += p.vy; p.vy += 0.25; p.r += p.vr; p.life -= 0.02;
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.max(0, p.life);
        ctx.font = p.s + 'px sans-serif';
        ctx.fillText(p.e, -p.s / 2, p.s / 2);
        ctx.restore();
      });
      if (++frame < 70) requestAnimationFrame(draw);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    draw();
  }

  // ---------------- ghost ----------------
  function ghostMetaInfo(m) {
    const parts = [];
    if (m.meta?.ghost_timer) parts.push(`⏱ ${Math.round(m.meta.ghost_timer / 1000)} сек`);
    if (m.meta?.ghost_views) parts.push(`👁 ${m.meta.ghost_views}`);
    return parts.join(' · ');
  }

  function isGhostActive(m) {
    if (!m.meta?.ghost) return false;
    const maxV = m.meta.ghost_views || 0;
    const reads = m.seenBy ? m.seenBy.filter((u) => u !== m.sender).length : 0;
    if (maxV && reads >= maxV) return true;
    return false;
  }

  function mightRefundGhost() {}

  // ---------------- presence dots ----------------
  function attachPresenceDots() {
    if (!state.me) return;
    document.querySelectorAll('.chat-item').forEach((item) => {
      const id = item.dataset.chat;
      const c = state.chats.get(id);
      if (!c || c.type !== 'dm') return;
      const o = dmOther(c);
      const dot = item.querySelector('.online-dot');
      if (dot) dot.classList.toggle('on', !!(o && o.online));
    });
  }
  function renderPresence(chatId, uid, online) {
    const mm = state.members.get(chatId);
    if (mm && mm.has(uid)) mm.get(uid).online = online;
    if (state.currentChatId === chatId) refreshSubtitle();
  }

  // ---------------- my chip / profile ----------------
  function renderMyChip() {
    const chip = $('my-chip');
    const wchip = $('wallet-chip');
    if (!state.me) {
      $('btn-switch-acc').classList.add('hidden');
      if (wchip) wchip.classList.add('hidden');
      return;
    }
    const av = chatAvatarStyle({ ...state.me, type: 'dm', id: 0 });
    const nick = state.me.nickname || state.me.username;
    chip.innerHTML = `${avatarHtml(av, 'mini-ava')}<span class="myname">${esc(nick)}</span>`;
    chip.onclick = () => openProfileModal(state.me.uid);
    if (wchip) {
      wchip.classList.remove('hidden');
      wchip.firstElementChild.textContent = fmtStars(state.balance);
    }
    $('btn-switch-acc').classList.remove('hidden');
  }
  function refreshWalletChip() {
    const wchip = $('wallet-chip');
    if (wchip) wchip.firstElementChild.textContent = fmtStars(state.balance);
  }
  function fmtStars(n) { return (n | 0) + '⭐'; }
  function updateChatHeaders() {
    if (!state.currentChatId) return;
    const c = getChat(state.currentChatId);
    if (c && c.type === 'dm') {
      const o = dmOther(c);
      if (o && o.uid === state.me.uid) return;
    }
  }

  // ---------------- onboarding ----------------
  function hideOnboarding() {
    $('onboarding').classList.add('hidden');
    $('register').classList.add('hidden');
    $('app').classList.remove('hidden');
    renderMyChip();
    if (!state.chats.size) closeToEmpty(); else renderChatList();
  }

  // ---------------- settings ----------------
  function defaultSettings() {
    return {
      theme: 'auto', accent: '#7c3aed', bubble: 'round', fontScale: 1, dimBg: false,
      showTicks: true, enterSend: true, sound: false, atmosphere: true, atmosPattern: 'aurora',
      emojiNick: '', font: 'Inter, system-ui',
    };
  }
  function loadSettings() {
    try { return Object.assign(defaultSettings(), JSON.parse(localStorage.getItem('durov_settings') || '{}')); }
    catch { return defaultSettings(); }
  }
  function saveSettings() {
    localStorage.setItem('durov_settings', JSON.stringify(state.settings));
    applySettings();
  }
  function applySettings() {
    const r = document.documentElement;
    r.style.setProperty('--accent', state.settings.accent);
    r.style.setProperty('--bubble-radius', state.settings.bubble === 'square' ? '6px' : state.settings.bubble === 'sharp' ? '2px' : '18px');
    r.style.setProperty('--font-scale', state.settings.fontScale);
    document.body.style.fontFamily = `'${state.settings.font}', system-ui, sans-serif`;
    r.classList.toggle('dim-bg', state.settings.dimBg);
    applyTheme();
    applyAtmosphere();
  }
  function applyTheme() {
    const theme = state.settings.theme;
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else {
      document.documentElement.setAttribute('data-theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    }
  }

  // ---------------- atmosphere ----------------
  function applyAtmosphere() {
    const layer = $('atmosphere-layer');
    layer.className = '';
    if (!state.settings.atmosphere) { layer.style.display = 'none'; return; }
    layer.style.display = '';
    if (!state.currentChatId) return;
    const c = getChat(state.currentChatId);
    const pattern = (c && c.atmos) || state.settings.atmosPattern;
    layer.classList.add('atmos-' + pattern);
  }

  function startAmbientBubbles() {
    const c = $('bubbles');
    if (!c) return;
    const ctx = c.getContext('2d');
    const resize = () => { c.width = c.clientWidth; c.height = c.clientHeight; };
    resize(); addEventListener('resize', resize);
    const dots = Array.from({ length: 24 }, () => ({
      x: Math.random() * c.width, y: Math.random() * c.height,
      r: 3 + Math.random() * 9, vx: (Math.random() - 0.5) * 0.6, vy: -0.3 - Math.random() * 0.7,
      a: 0.2 + Math.random() * 0.4,
    }));
    const tick = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      dots.forEach((d) => {
        d.x += d.vx; d.y += d.vy;
        if (d.y < -20) { d.y = c.height + 20; d.x = Math.random() * c.width; }
        ctx.beginPath();
        ctx.globalAlpha = d.a;
        ctx.fillStyle = '#ffffff';
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      });
      requestAnimationFrame(tick);
    };
    tick();
  }

  // ---------------- modals ----------------
  const modalRoot = () => $('modal-root');
  function openModal(html, closeBtn = true) {
    const root = modalRoot();
    root.innerHTML = html;
    const overlay = root.firstElementChild;
    overlay.classList.add('show');
    if (!closeBtn) return;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    const x = overlay.querySelector('.modal-close');
    if (x) x.onclick = () => overlay.remove();
  }

  function modalShell(title, body, footer = '') {
    return `<div class="modal-overlay"><div class="modal glass">
      <div class="modal-head"><h3>${title}</h3><button class="modal-close">✕</button></div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div></div>`;
  }

  function openProfileModal(uid) {
    if (uid === state.me?.uid) return openSettingsProfile();
    const u = state.myUsers.get(uid) || { uid, nickname: '…', username: '' };
    const av = chatAvatarStyle(u);
    const online = u.online;
    openModal(modalShell('Профиль', `
      <div class="profile-card" id="modal-view-profile">
        <div class="big-ava" style="background:linear-gradient(135deg,${av.pal[0]},${av.pal[1]})">${esc(av.text)}</div>
        <div class="p-name">${esc(u.nickname || u.username)}</div>
        <div class="p-username">@${esc(u.username)} <span class="presence ${online ? 'on' : ''}">${online ? 'в сети' : 'не в сети'}</span></div>
        <div class="p-bio">${esc(u.bio || 'Без описания')}</div>
        <button class="btn primary" id="btn-to-dm" data-uid="${uid}">💬 Написать</button>
      </div>`));
    $('btn-to-dm').onclick = (e) => {
      const u2 = state.myUsers.get(e.target.dataset.uid) || u;
      send({ t: 'dm_create', username: u2.username });
      modalRoot().innerHTML = '';
    };
  }

  function refreshProfileModal() {
    const root = modalRoot().querySelector('#modal-view-profile');
    if (!root) return;
    const u = state.me;
    const av = chatAvatarStyle(u);
    root.querySelector('.big-ava').style.background = `linear-gradient(135deg,${av.pal[0]},${av.pal[1]})`;
    root.querySelector('.big-ava').textContent = av.text;
    root.querySelector('.p-name').textContent = u.nickname || u.username;
    root.querySelector('.p-username').textContent = '@' + u.username;
  }

  // ---------------- кошелёк: звёзды / подарки / NFT ----------------
  function openWalletModal() {
    send({ t: 'wallet_get' });
    send({ t: 'gifts_catalog' });
    send({ t: 'nft_list' });
    renderWalletModal();
  }

  function renderWalletModal() {
    document.querySelectorAll('.modal-overlay').forEach((o) => { if (o.querySelector('#modal-wallet')) o.remove(); });
    openModal(modalShell('🪙 Кошелёк', `
      <div id="modal-wallet">
        <div class="wallet-balance">${fmtStars(state.balance)}</div>
        <div class="wallet-tabs">
          <button class="wtab active" data-wtab="gifts">🎁 Подарки</button>
          <button class="wtab" data-wtab="mine">🎒 Моё</button>
          <button class="wtab" data-wtab="nft">💎 NFT-юзернеймы</button>
        </div>
        <div class="wallet-page" id="wpage-gifts">${catalogHtml()}</div>
        <div class="wallet-page hidden" id="wpage-mine">${mineHtml()}</div>
        <div class="wallet-page hidden" id="wpage-nft">${nftHtml()}</div>
        <div class="hint">⭐ Звёзды стартуют с 500. Они капают за полученные подарки и продажу NFT — и тратятся на каталог и аукционы. Продажа идёт с комиссией 10%.</div>
      </div>`));

    document.querySelectorAll('.wtab').forEach((t) => {
      t.onclick = () => {
        document.querySelectorAll('.wtab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        ['gifts', 'mine', 'nft'].forEach((p) => {
          $('wpage-' + p).classList.toggle('hidden', t.dataset.wtab !== p);
        });
      };
    });

    document.querySelectorAll('[data-buy]').forEach((b) => {
      b.onclick = () => send({ t: 'gift_buy', giftId: b.dataset.buy });
    });
    document.querySelectorAll('[data-send]').forEach((b) => {
      b.onclick = () => {
        const to = prompt('Кому подарить? Введи юзернейм @…');
        if (to) send({ t: 'gift_send', giftId: b.dataset.send, toUsername: to.toLowerCase().replace(/^@/, '').trim() });
      };
    });
    document.querySelectorAll('[data-sendcopy]').forEach((b) => {
      b.onclick = () => {
        const c = state.walletGifts[+b.dataset.sendcopy];
        if (!c) return;
        const to = prompt('Кому подарить «' + c.name + '»? Введи юзернейм @…');
        if (to) send({ t: 'gift_send', giftId: c.giftId, toUsername: to.toLowerCase().replace(/^@/, '').trim() });
      };
    });
    document.querySelectorAll('[data-upgrade]').forEach((b) => {
      b.onclick = () => {
        const c = state.walletGifts[+b.dataset.upgrade];
        if (!c) return;
        if (confirm('Апгрейд «' + c.name + '» в уникальный NFT-подарок?')) send({ t: 'gift_upgrade', copy: c.copy });
      };
    });
    document.querySelectorAll('[data-withdraw]').forEach((b) => {
      b.onclick = () => {
        const c = state.walletGifts[+b.dataset.withdraw];
        if (!c) return;
        if (confirm('Вывести «' + c.name + '» и получить звёзды обратно?')) send({ t: 'gift_withdraw', copy: c.copy });
      };
    });
    document.querySelectorAll('[data-bid]').forEach((b) => {
      b.onclick = () => {
        const inp = b.parentElement.querySelector('input');
        send({ t: 'nft_bid', slug: b.dataset.bid, amount: inp ? inp.value : '' });
      };
    });
    document.querySelectorAll('[data-buynow]').forEach((b) => {
      b.onclick = () => send({ t: 'nft_buy_now', slug: b.dataset.buynow });
    });
    document.querySelectorAll('[data-sell]').forEach((b) => {
      b.onclick = () => {
        const inp = b.parentElement.querySelector('input');
        const minBid = inp ? parseInt(inp.value, 10) : 0;
        if (!minBid || minBid <= 0) return showToast('Укажи минимальную ставку');
        send({ t: 'nft_sell', slug: b.dataset.sell, minBid });
      };
    });
    document.querySelectorAll('[data-cancel]').forEach((b) => {
      b.onclick = () => send({ t: 'nft_cancel', slug: b.dataset.cancel });
    });
    document.querySelectorAll('[data-claim]').forEach((b) => {
      b.onclick = () => send({ t: 'nft_claim', slug: b.dataset.claim });
    });
  }

  function catalogHtml() {
    if (!state.catalog.length) return '<div class="hint">Каталог загружается…</div>';
    return '<div class="gift-grid">' + state.catalog.map((g) => `
      <div class="gift-card">
        <div class="gift-emoji">${g.emoji}</div>
        <div class="gift-name">${esc(g.name)}</div>
        <div class="gift-price">${g.price}⭐</div>
        ${g.remains != null ? `<div class="gift-remains">осталось ${g.remains}/${g.total}</div>` : ''}
        ${g.per_user_deal ? `<div class="gift-remains">лимит ${g.per_user_deal}/чел</div>` : ''}
        ${g.upgrade ? `<div class="gift-remains">апгрейд ${g.upgrade}⭐</div>` : ''}
        <div class="gift-row"><button class="btn small" data-buy="${g.id}">Купить</button><button class="btn small alt" data-send="${g.id}">Дарить</button></div>
      </div>`).join('') + '</div>';
  }

  function mineHtml() {
    if (!state.walletGifts.length) return '<div class="hint">Пока пусто. Купи или получи подарок в «Подарках».</div>';
    return '<div class="gift-grid">' + state.walletGifts.map((c, i) => {
      const cfg = state.catalog.find((x) => x.id === c.giftId);
      return `
      <div class="gift-card mine">
        <div class="gift-emoji">${c.emoji}${c.unique ? '<div class="nft-badge">NFT</div>' : ''}</div>
        <div class="gift-name">${esc(c.name)}</div>
        <div class="gift-sub">${c.from ? 'от ' + esc(c.fromName || 'кого-то') : 'купил(а) себе'}</div>
        ${c.token ? `<div class="gift-sub">🔑 token ${esc(c.token)}</div>` : ''}
        <div class="gift-row">
          <button class="btn small alt" data-sendcopy="${i}">Дарить</button>
          ${cfg && cfg.upgrade && !c.unique ? `<button class="btn small" data-upgrade="${i}">💎 Апгрейд</button>` : ''}
          ${!c.unique ? `<button class="btn small danger" data-withdraw="${i}">💸</button>` : ''}
        </div>
      </div>`;
    }).join('') + '</div>';
  }

  function nftHtml() {
    const auctions = [...state.nftCache.values()].filter((c) => c.status === 'auction');
    const mine = state.me ? [...state.nftCache.values()].filter((c) => c.owner === state.me.uid) : [];
    let html = '<div class="hint">Коллекционные юзернеймы (фрагмент-стиль) продаются на аукционах. Заняв такой — меняешь свой юзернейм на NFT.</div>';
    html += '<h4>Аукционы</h4>';
    if (!auctions.length) html += '<div class="hint">Сейчас лотов нет…</div>';
    html += auctions.map((c) => `
      <div class="nft-card">
        <div class="nft-slug">@${esc(c.slug)}</div>
        <div class="nft-cur">текущая ставка: ${c.cur || c.base || 0}⭐${c.buyNow ? ' · выкуп ' + c.buyNow + '⭐' : ''}</div>
        <div class="nft-end">${c.endAt ? 'до ' + new Date(c.endAt).toLocaleString('ru-RU') : ''}</div>
        <div class="nft-row">
          <input class="nft-bid" type="number" min="1" placeholder="шаг +50"> <button class="btn small" data-bid="${esc(c.slug)}">Ставка</button>
          ${c.buyNow ? `<button class="btn small alt" data-buynow="${esc(c.slug)}">Купить сейчас</button>` : ''}
        </div>
      </div>`).join('');
    html += '<h4>Мои NFT</h4>';
    if (!mine.length) html += '<div class="hint">У тебя пока нет коллекционных юзернеймов.</div>';
    html += mine.map((c) => `
      <div class="nft-card mine">
        <div class="nft-slug">@${esc(c.slug)} <span class="nft-badge mine">NFT</span></div>
        <div class="nft-cur">статус: ${c.status === 'owned' ? 'у тебя' : 'на аукционе'}</div>
        ${c.status === 'owned' ? `
          <div class="nft-row">
            <input class="nft-list-min" type="number" min="1" placeholder="мин. ставка"> <button class="btn small" data-sell="${esc(c.slug)}">На аукцион</button>
            <button class="btn small danger" data-claim="${esc(c.slug)}">Сделать юзернеймом</button>
          </div>` : `
          <button class="btn small danger" data-cancel="${esc(c.slug)}">Снять аукцион</button>`}
      </div>`).join('');
    return html;
  }

  function openSettingsProfile() {
    const u = state.me;
    if (!u) return;
    const av = chatAvatarStyle(u);
    openModal(modalShell('Твой профиль', `
      <div class="profile-card">
        <div class="big-ava edit" id="avatar-view" style="background:linear-gradient(135deg,${av.pal[0]},${av.pal[1]})">
          <img id="avatar-img" src="${u.avatar || ''}" alt="">
          <div class="ava-edit-hint">📷</div>
        </div>
        <input type="file" id="avatar-file" accept="image/*" hidden>
        <div class="form-row"><label>Ник с эмодзи</label>
          <div class="nick-row"><button class="icon-btn" id="p-nick-emoji">😎</button><input id="p-nick" value="${esc(u.nickname)}"></div>
          <div id="p-nick-panel" class="emoji-panel hidden"></div>
        </div>
        <div class="form-row"><label>Описание</label><textarea id="p-bio" maxlength="200">${esc(u.bio || '')}</textarea></div>
        <div class="form-row small">🔐 Твой крипто-ключ живёт на этом устройстве и нигде больше.</div>
        <div class="form-row danger"><button class="btn danger" id="btn-logout">🚪 Выйти (уничтожить ключ)</button></div>
      </div>
      <button class="btn primary full" id="btn-save-profile">Сохранить</button>
    `));

    const pick = (btn, panel, target) => {
      $(btn).onclick = (e) => {
        e.stopPropagation();
        const p = $(panel);
        if (!p.classList.contains('hidden')) { p.classList.add('hidden'); return; }
        p.innerHTML = '';
        EMOJI_LIST.forEach((e) => {
          const b = el('span', 'emoji-cell', e);
          b.onclick = () => { $(target).value = e + ' ' + $(target).value.replace(/^(?:\p{Extended_Pictographic}|\uFE0F|\u200D)+\s*/u, ''); p.classList.add('hidden'); };
          p.appendChild(b);
        });
        p.classList.remove('hidden');
      };
    };
    pick('p-nick-emoji', 'p-nick-panel', 'p-nick');

    $('avatar-view').onclick = () => $('avatar-file').click();
    $('avatar-file').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const src = await readResizeImage(f, 256);
      $('avatar-img').src = src;
      $('avatar-img').classList.add('show');
      u._avatar = src;
    };

    $('btn-logout').onclick = () => {
      modalRoot().innerHTML = '';
      localStorage.removeItem('durov_token');
      localStorage.removeItem('durov_priv');
      location.reload();
    };
    $('btn-save-profile').onclick = () => {
      const patch = { nickname: $('p-nick').value.trim() || u.username, bio: $('p-bio').value.trim() };
      if (u._avatar) patch.avatar = u._avatar;
      send({ t: 'profile_update', ...patch });
      modalRoot().innerHTML = '';
    };
  }

  // ---------------- аккаунты ----------------
  function openAccountsModal() {
    const list = accountsList();
    const rows = list.length ? list.map((a) => `
      <div class="acc-row ${a.active ? 'sel' : ''}">
        <button class="btn ${a.active ? 'primary' : ''}" data-acc="${esc(a.username)}|${esc(a.publicKeyPem)}">${a.active ? '✓ ' : ''}${esc(a.nickname || a.username)} <span class="subtitle">@${esc(a.username)}</span></button>
        <button class="icon-btn danger" data-forget="${esc(a.username)}" title="Забыть аккаунт">🗑</button>
      </div>`).join('') : '<div class="hint">Аккаунтов пока нет.</div>';
    openModal(modalShell('📱 Аккаунты', `
      <div class="acc-list">${rows}</div>
      <button class="btn primary full" id="btn-new-acc">➕ Новый аккаунт</button>
    `));
    document.querySelectorAll('[data-acc]').forEach((b) => {
      b.onclick = () => {
        const [u, key] = b.dataset.acc.split('|');
        const a = accountsList().find((x) => x.username === u && x.publicKeyPem === key);
        if (a) { executeAccount(a); modalRoot().innerHTML = ''; }
      };
    });
    document.querySelectorAll('[data-forget]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const u = b.dataset.forget;
        const list = accountsList().filter((x) => x.username !== u);
        if (state.me && state.me.username === u) {
          accountsPersist(list);
          logoutClean();
        } else {
          accountsPersist(list);
          openAccountsModal();
        }
      };
    });
    $('btn-new-acc').onclick = () => {
      modalRoot().innerHTML = '';
      $('onboarding').classList.remove('hidden');
      $('app').classList.add('hidden');
      $('register').classList.remove('hidden');
    };
  }

  function logoutClean() {
    state.token = '';
    localStorage.removeItem('durov_token');
    Crypto.clearStored();
    resetAppUi();
    $('onboarding').classList.remove('hidden');
    $('app').classList.add('hidden');
    if (state.ws) { state.switching = true; state.ws.close(); }
    connect();
  }

  function openSettings() {
    const s = state.settings;
    const themes = ['auto', 'dark', 'light'].map((t) => `<button class="opt-chip ${s.theme === t ? 'sel' : ''}" data-k="theme" data-v="${t}">${t === 'auto' ? '🌗 авто' : t === 'dark' ? '🌙 тёмная' : '☀️ светлая'}</button>`).join('');
    const bubbles = [{ v: 'round', l: '🫧 круглые' }, { v: 'square', l: '🔲 квадратные' }, { v: 'sharp', l: '🔳 острые' }].map((o) => `<button class="opt-chip ${s.bubble === o.v ? 'sel' : ''}" data-k="bubble" data-v="${o.v}">${o.l}</button>`).join('');
    const patterns = [
      { v: 'off', l: '🚫 нет' }, { v: 'aurora', l: '🌌 аврора' }, { v: 'rain', l: '🌧 дождь' },
      { v: 'stars', l: '🌠 звёзды' }, { v: 'hearts', l: '💗 сердечки' }, { v: 'matrix', l: '💚 матрица' },
    ].map((o) => `<button class="opt-chip ${(state.settings.atmosPattern === o.v) ? 'sel' : ''}" data-k="atmosPattern" data-v="${o.v}">${o.l}</button>`).join('');

    openModal(modalShell('Настройки', `
      <div class="settings-tabs">
        <button class="stab active" data-tab="appearance">🎨 Оформление</button>
        <button class="stab" data-tab="behavior">⚡ Поведение</button>
        <button class="stab" data-tab="profile">👤 Профиль</button>
        <button class="stab" data-tab="privacy">🕶 Приватность</button>
      </div>
      <div class="tab-page" id="tab-appearance">
        <div class="form-row"><label>Тема</label><div class="opt-row">${themes}</div></div>
        <div class="form-row"><label>Акцентный цвет</label>
          <input type="color" id="accent-pick" value="${s.accent}" style="width:100%;height:38px;background:none;border:none">
        </div>
        <div class="form-row"><label>Форма пузырей</label><div class="opt-row">${bubbles}</div></div>
        <div class="form-row"><label>Масштаб текста</label><input type="range" id="font-scale" min="80" max="135" value="${Math.round(s.fontScale * 100)}"></div>
        <div class="form-row"><label>Фоновая атмосфера</label><div class="opt-row">${patterns}</div></div>
        <label class="switch"><input type="checkbox" id="opt-dim" ${s.dimBg ? 'checked' : ''}><span>Приглушить фон</span></label>
      </div>
      <div class="tab-page hidden" id="tab-behavior">
        <label class="switch"><input type="checkbox" id="opt-enter" ${s.enterSend ? 'checked' : ''}><span>Отправка по Enter</span></label>
        <label class="switch"><input type="checkbox" id="opt-ticks" ${s.showTicks ? 'checked' : ''}><span>Показывать галочки прочтения</span></label>
        <label class="switch"><input type="checkbox" id="opt-sound" ${s.sound ? 'checked' : ''}><span>Звук сообщений</span></label>
        <div class="form-row"><label>Анимации</label><div class="opt-row">
          <button class="opt-chip sel" data-k="na" data-v="on">Настроение: включены</button>
        </div></div>
        <button class="btn" id="btn-download-chat">💾 Экспорт текущего чата (.json)</button>
      </div>
      <div class="tab-page hidden" id="tab-profile"><div id="settings-profile-slug"></div></div>
      <div class="tab-page hidden" id="tab-privacy">
        <div class="info-box">🔐 DUROV MSG не хранит номера, e-mail и IP связанные с личностью.
          Личные сообщения шифруются на устройстве (E2E). В группах и каналах текст живёт на сервере открытым — это оговорено.</div>
        <div class="info-box">🫥 Призрачные сообщения полностью исчезают после просмотров или по таймеру (даже если сервер перезапущен).</div>
        <div class="info-box">⚡ Для максимальной анонимности используй DUROV MSG через Tor или свой VPN.</div>
        <label class="switch"><input type="checkbox" id="opt-ghost-default" ${state.settings.ghostDefault ? 'checked' : ''}><span>Помечать все сообщения как призрачные</span></label>
        <div class="form-row bk-row"><label>Резервная копия ключа 🔑</label>
          <input type="password" id="bk-pass" placeholder="Пароль для ключа (мин. 8 символов)" autocomplete="new-password">
          <div class="nick-row">
            <button class="btn" id="btn-bk-export">⬇️ Скачать копию</button>
            <button class="btn" id="btn-bk-import">⬆️ Восстановить</button>
            <input type="file" id="bk-file" hidden accept=".dupvk,application/json,text/plain">
          </div>
          <div class="hint">Копия = твой секретный ключ + токен аккаунта, зашифрованные паролем. Без неё потеря устройства = потеря доступа к старым ЛС.</div>
        </div>
      </div>
    `, `<button class="btn primary" id="btn-close-settings">Готово ✨</button>`));

    document.querySelectorAll('.stab').forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll('.stab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.tab-page').forEach((p) => p.classList.add('hidden'));
        $('tab-' + tab.dataset.tab).classList.remove('hidden');
        if (tab.dataset.tab === 'profile') $('settings-profile-slug').innerHTML = '';
        if (tab.dataset.tab === 'profile') { modalRoot().querySelector('.modal-close') && openProfileSlug(); }
      };
    });

    const bindOpts = () => {
      document.querySelectorAll('.opt-chip').forEach((ch) => {
        ch.onclick = () => {
          document.querySelectorAll(`.opt-chip[data-k="${ch.dataset.k}"]`).forEach((x) => x.classList.remove('sel'));
          ch.classList.add('sel');
          if (ch.dataset.k === 'theme') { state.settings.theme = ch.dataset.v; }
          if (ch.dataset.k === 'bubble') { state.settings.bubble = ch.dataset.v; }
          if (ch.dataset.k === 'atmosPattern') {
            state.settings.atmosPattern = ch.dataset.v;
            if (ch.dataset.v === 'off') state.settings.atmosphere = false;
            else state.settings.atmosphere = true;
          }
          saveSettings();
        };
      });
    };
    bindOpts();

    $('accent-pick').oninput = (e) => { state.settings.accent = e.target.value; saveSettings(); };
    $('font-scale').oninput = (e) => { state.settings.fontScale = e.target.value / 100; saveSettings(); };
    $('opt-dim').onchange = (e) => { state.settings.dimBg = e.target.checked; saveSettings(); };
    $('opt-enter').onchange = (e) => { state.settings.enterSend = e.target.checked; saveSettings(); };
    $('opt-ticks').onchange = (e) => { state.settings.showTicks = e.target.checked; saveSettings(); };
    $('opt-sound').onchange = (e) => { state.settings.sound = e.target.checked; saveSettings(); };
    $('opt-ghost-default').onchange = (e) => { state.settings.ghostDefault = e.target.checked; saveSettings(); };
    $('btn-download-chat').onclick = downloadChatExport;
    $('btn-close-settings').onclick = () => { modalRoot().innerHTML = ''; };

    $('btn-bk-export').onclick = async () => {
      const pass = $('bk-pass').value;
      if (pass.length < 8) return showToast('Пароль минимум 8 символов');
      if (!Crypto.hasIdentity()) return showToast('Ключ ещё не создан');
      try {
        const key = await Crypto.exportBackup(pass);
        const blob = new Blob([JSON.stringify({ app: 'DUROV-MSG', token: state.token, key }, null, 2)], { type: 'application/json' });
        const a = el('a', '', '');
        a.href = URL.createObjectURL(blob);
        a.download = 'durov-backup.dupvk';
        document.body.appendChild(a); a.click(); a.remove();
        $('bk-pass').value = '';
        showToast('🔑 Резервная копия сохранена');
      } catch (e) { showToast('⛔ Не удалось сохранить копию'); }
    };
    $('btn-bk-import').onclick = () => $('bk-file').click();
    $('bk-file').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const pass = $('bk-pass').value;
      if (!pass) return showToast('Введи пароль от копии');
      try {
        const data = JSON.parse(await f.text());
        if (!data || data.app !== 'DUROV-MSG' || !data.key) throw new Error('bad file');
        await Crypto.importBackup(data.key, pass);
        if (data.token) localStorage.setItem('durov_token', data.token);
        showToast('🔑 Ключ восстановлен. Перезапуск…');
        setTimeout(() => location.reload(), 700);
      } catch (err) {
        showToast('⛔ Неверный пароль или повреждённый файл');
      }
      e.target.value = '';
    };
    $('tab-profile') && openProfileSlug();

    function openProfileSlug() {
      const slug = $('settings-profile-slug');
      if (!slug) return;
      const u = state.me;
      const av = chatAvatarStyle(u);
      slug.innerHTML = `
        <div class="profile-slug">
          <div class="big-ava" style="background:linear-gradient(135deg,${av.pal[0]},${av.pal[1]})">${esc(av.text)}</div>
          <div class="p-name">${esc(u.nickname)}</div>
          <div class="p-username">@${esc(u.username)}</div>
          <button class="btn" id="btn-edit-profile">✏️ Редактировать</button>
        </div>`;
      $('btn-edit-profile').onclick = () => { modalRoot().innerHTML = ''; openSettingsProfile(); };
    }
  }

  function downloadChatExport() {
    const c = getChat(state.currentChatId);
    if (!c) return;
    const blob = new Blob([JSON.stringify({ chat: c, messages: state.messages }, null, 2)], { type: 'application/json' });
    const a = el('a', '', '');
    a.href = URL.createObjectURL(blob);
    a.download = 'durov_' + chatTitle(c).replace(/[^\wа-яА-ЯёЁ]/g, '_') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
  }

  function openNewDm() {
    openModal(modalShell('Новое личное сообщение', `
      <div class="form-row"><label>Найди пользователя</label><input id="dm-search" placeholder="@ники" autocomplete="off"></div>
      <div id="dm-results" class="search-list"></div>
    `, `<button class="btn primary hidden" id="btn-close-dm">Готово</button>`));
    const inp = $('dm-search');
    const onIn = () => { const q = inp.value.trim(); if (q.length > 1) send({ t: 'search', q }); };
    inp.addEventListener('input', debounce(onIn, 300));
    window._dmSearchCb = (users) => {
      const box = $('dm-results');
      if (!box) return;
      box.innerHTML = '';
      users.forEach((u) => {
        const av = chatAvatarStyle(u);
        const row = el('div', 'user-row', `
          <span class="mini-ava" style="background:linear-gradient(135deg,${av.pal[0]},${av.pal[1]})">${esc(av.text)}</span>
          <span class="uname">${esc(u.nickname || u.username)}</span>
          <span class="uhandle">@${esc(u.username)}</span>
        `);
        row.onclick = () => { send({ t: 'dm_create', username: u.username }); modalRoot().innerHTML = ''; };
        box.appendChild(row);
      });
      if (!users.length) box.innerHTML = '<div class="hint">Никого не нашли. Проверь ник.</div>';
    };
    $('btn-close-dm').onclick = () => modalRoot().innerHTML = '';
  }

  function openNewGroup(isChannel) {
    const kind = isChannel ? 'channel' : 'group';
    openModal(modalShell(isChannel ? 'Новый канал' : 'Новая группа', `
      <div class="form-row"><label>Название</label><input id="g-title" maxlength="80" placeholder="${isChannel ? 'Название канала' : 'Название группы'}"></div>
      <div class="form-row"><label>Описание</label><textarea id="g-about" maxlength="300" placeholder="Коротко о сути…"></textarea></div>
      <div class="form-row"><label>Аватар</label><div class="avatar-pick" id="g-avatar-pick">🎨</div><input type="file" id="g-avatar-file" hidden accept="image/*"></div>
    `, `<button class="btn primary" id="btn-create">${isChannel ? 'Создать канал 📢' : 'Создать группу 👥'}</button>`));
    let avatar = null;
    $('g-avatar-pick').onclick = () => $('g-avatar-file').click();
    $('g-avatar-file').onchange = async (e) => { const f = e.target.files[0]; if (f) avatar = await readResizeImage(f, 256); };
    $('btn-create').onclick = () => {
      const title = $('g-title').value.trim();
      if (!title) return showToast('Нужно название');
      send({ t: isChannel ? 'channel_create' : 'group_create', title, about: $('g-about').value.trim(), avatar });
      modalRoot().innerHTML = '';
    };
  }

  function openMembersModal() {
    const c = getChat(state.currentChatId);
    if (!c || c.type === 'dm') return;
    const mm = state.members.get(c.id) || new Map();
    const isOwner = c.owner === state.me.uid;
    openModal(modalShell('Участники · ' + esc(chatTitle(c)), `
      <div id="member-list" class="search-list"></div>
      ${isOwner ? `<div class="form-row"><label>Добавить по нику</label><div class="nick-row"><input id="m-search" placeholder="@ник" autocomplete="off"><button class="btn" id="m-add">+</button></div></div>` : ''}
    `));
    const renderMembers = () => {
      const box = $('member-list');
      box.innerHTML = '';
      mm.forEach((u, uid) => {
        const av = chatAvatarStyle(u);
        const row = el('div', 'user-row', `
          <span class="mini-ava" style="background:linear-gradient(135deg,${av.pal[0]},${av.pal[1]})">${esc(av.text)}</span>
          <span class="uname">${esc(u.nickname || u.username)}</span>
          <span class="uhandle">@${esc(u.username)}</span>
          ${(u.online ? '<span class="presence on">в сети</span>' : '')}
        `);
        row.onclick = () => openProfileModal(uid);
        box.appendChild(row);
      });
    };
    renderMembers();
    if (isOwner) {
      $('m-add').onclick = () => {
        const q = $('m-search').value.trim();
        if (!q) return;
        send({ t: 'search', q });
        setTimeout(() => {
          const found = [...state.myUsers.values()].filter((u) => u.username.includes(q.toLowerCase()));
          const b = found[0];
          if (b) { send({ t: 'chat_add_members', chatId: c.id, ids: [b.uid] }); showToast('Добавлен @' + b.username); }
          else showToast('Не найден');
        }, 350);
      };
    }
  }

  function openImageModal(src) {
    openModal(`<div class="modal-overlay"><div class="image-view glass"><img src="${esc(src)}"><button class="modal-close">✕</button></div></div>`, false);
  }

  // ---------------- search ----------------
  function renderSearch(users) {
    window._lastUsers = users || [];
    refreshSearchBox();
  }

  function refreshSearchBox() {
    const box = $('search-results');
    if (!box) return;
    const q = $('search-input').value.trim();
    if (q.length < 1) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '';
    const ql = q.replace(/^@/, '').toLowerCase();
    const chats = [...state.chats.values()].filter((c) => {
      if (chatTitle(c).toLowerCase().includes(ql)) return true;
      if (c.type === 'dm') {
        const o = dmOther(c);
        return !!(o && (o.username.toLowerCase().includes(ql) || (o.nickname || '').toLowerCase().includes(ql)));
      }
      return false;
    });
    const users = (window._lastUsers || []).filter((u) =>
      (u.nickname || '').toLowerCase().includes(ql) || u.username.toLowerCase().includes(ql));
    if (chats.length) {
      box.appendChild(el('div', 'sr-label', 'Чаты'));
      chats.forEach((c) => {
        const av = chatAvatarStyle(c);
        const row = el('div', 'user-row');
        row.innerHTML = `${avatarHtml(av, 'mini-ava')}<span class="uname">${esc(chatTitle(c))}</span><span class="uhandle">${c.type === 'dm' ? '💬 личные сообщения' : (c.type === 'channel' ? '📢 канал' : '👥 группа')}</span>`;
        row.onclick = () => { openChat(c.id); $('search-input').value = ''; $('search-results').classList.add('hidden'); };
        box.appendChild(row);
      });
    }
    if (users.length) {
      box.appendChild(el('div', 'sr-label', 'Пользователи'));
      users.forEach((u) => {
        const av = chatAvatarStyle(u);
        const row = el('div', 'user-row');
        row.innerHTML = `${avatarHtml(av, 'mini-ava')}<span class="uname">${esc(u.nickname || u.username)}</span><span class="uhandle">@${esc(u.username)}</span>`;
        row.onclick = () => { send({ t: 'dm_create', username: u.username }); $('search-input').value = ''; $('search-results').classList.add('hidden'); };
        box.appendChild(row);
      });
    }
    if (!box.children.length) {
      box.innerHTML = ql.length < 2 ? '<div class="hint">Продолжай печатать…</div>' : '<div class="hint">Никого не нашли</div>';
    }
  }

  // ---------------- pickers ----------------
  function openEmojiPicker() {
    const panel = $('emoji-picker');
    if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
    panel.innerHTML = '';
    EMOJI_LIST.forEach((e) => {
      const b = el('span', 'emoji-cell', e);
      b.onclick = () => { $('msg-input').value += e; $('msg-input').focus(); };
      panel.appendChild(b);
    });
    panel.classList.remove('hidden');
    $('sticker-picker').classList.add('hidden');
  }

  function openStickerPicker() {
    const panel = $('sticker-picker');
    if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
    $('emoji-picker').classList.add('hidden');
    setStickerTab('st');
    panel.classList.remove('hidden');
  }

  function setStickerTab(cat) {
    const body = $('picker-body');
    body.innerHTML = '';
    document.querySelectorAll('.picker-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.cat === cat));
    if (cat === 'url') {
      body.innerHTML = `
        <div class="url-gif">
          <input id="gif-url" placeholder="Вставь ссылку на GIF или картинку…" autocomplete="off">
          <button class="btn primary" id="gif-url-send">Отправить ➤</button>
        </div>`;
      $('gif-url-send').onclick = () => { sendUrlGif(); };
      $('gif-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendUrlGif(); });
      return;
    }
    const items = cat === 'st' ? STICKERS : GIFS;
    items.forEach((g) => {
      const cell = el('div', 'gif-cell', `<span class="gif-emoji ${g.anim}">${esc(g.e)}</span><span class="gif-cap">${esc(g.n)}</span>`);
      cell.onclick = () => sendStickerOrGif(cat, g);
      body.appendChild(cell);
    });
  }

  function sendStickerOrGif(cat, g) {
    const kind = cat === 'st' ? 'sticker' : 'gif';
    sendMessage(kind, { e: g.e, n: g.n, anim: g.anim, kind: 'emoji' });
    $('sticker-picker').classList.add('hidden');
  }

  function sendUrlGif() {
    const url = $('gif-url').value.trim();
    if (!url) return;
    sendMessage('gif', { url, kind: 'img', n: 'Гифка' });
    $('sticker-picker').classList.add('hidden');
  }

  // ---------------- ghost panel ----------------
  function toggleGhostPanel() {
    const p = $('ghost-panel');
    p.classList.toggle('hidden');
    $('btn-ghost').classList.toggle('on', !p.classList.contains('hidden'));
  }

  // ---------------- reply ----------------
  function replyIcon(kind) {
    return { image: '🖼', file: '📎', voice: '🎙', gif: '😀', sticker: '🦄', card: '👤', text: '', ghost: '' }[kind] || '';
  }
  function replyLabel(quote) {
    const prefix = replyIcon(quote.kind);
    const head = quote.name ? (quote.name + ': ') : '';
    const body = quote.text || '';
    return prefix + ' ' + head + body;
  }
  function setReply(m) {
    const sender = m.sender && state.myUsers.get(m.sender);
    const nick = sender ? (sender.nickname || sender.username) : '';
    const kind = m.kind || 'text';
    const text = (textOf(m) || '').slice(0, 80);
    state.replyTo = { id: m.id, text, name: nick, kind };
    const bar = $('reply-bar');
    bar.innerHTML = '';
    bar.appendChild(el('span', '', '↪️ ' + replyIcon(kind) + ' ' + esc((nick ? nick + ': ' : '') + text)));
    const x = el('button', 'modal-close', '✕');
    x.onclick = () => { state.replyTo = null; hideReplyBar(); };
    bar.appendChild(x);
    bar.classList.remove('hidden');
  }
  function hideReplyBar() { $('reply-bar').classList.add('hidden'); }

  function jumpToMessage(id) {
    if (id == null) return;
    const sel = '[data-mid="' + String(id).replace(/"/g, '\\"') + '"]';
    const tryScroll = () => {
      const box = $('messages');
      const el0 = box.querySelector(sel);
      if (el0) {
        const top = el0.getBoundingClientRect().top + box.scrollTop - box.getBoundingClientRect().top - 110;
        box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        el0.classList.add('flash-target');
        setTimeout(() => el0.classList.remove('flash-target'), 900);
        return true;
      }
      return false;
    };
    if (tryScroll()) return;
    if (!state.hasMore || chatSearchActive) return showToast('Сообщение не загружено');
    jumpPendingId = id;
    loadOlder();
  }

  // ---------------- message menu ----------------
  function bubbleMenu(e, m, mine) {
    const mm = state.members.get(state.currentChatId);
    const isOwner = getChat(state.currentChatId)?.owner === state.me.uid;
    const items = [];
    const chat = getChat(state.currentChatId);
    const canEdit = chat.type !== 'dm' && (mine || isOwner);
    if (m.kind === 'text' || m.kind === 'ghost') {
      if (canEdit) items.push({ l: '✏️ Редактировать', fn: () => promptEdit(m) });
      else items.push({ l: '✏️', fn: null, disabled: true });
    }
    items.push({ l: '↪️ Ответить', fn: () => setReply(m) });
    if (['text', 'ghost', 'image', 'gif', 'sticker', 'voice', 'card'].includes(m.kind)) {
      items.push({ l: '↪️ Переслать', fn: () => openForwardModal(m) });
    }
    EMOJI_LIST.slice(0, 8).forEach((r) => items.push({ l: r, fn: () => toggleReaction(m, r) }));
    if (mine) items.push({ l: '🗑 Удалить', fn: () => send({ t: 'msg_delete', chatId: state.currentChatId, id: m.id }), danger: true });
    const menu = el('div', 'ctx-menu', '');
    items.forEach((it) => {
      if (it.disabled) return;
      const b = el('button', 'ctx-item' + (it.danger ? ' danger' : ''), it.l);
      b.onclick = () => { menu.remove(); it.fn(); };
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    menu.style.left = Math.min(e.clientX, innerWidth - 190) + 'px';
    menu.style.top = Math.min(e.clientY, innerHeight - 60) + 'px';
    const rm = () => menu.remove();
    setTimeout(() => document.addEventListener('click', rm, { once: true }), 0);
  }

  function promptEdit(m) {
    const txt = textOf(m) || '';
    openModal(modalShell('Редактирование', `<textarea id="edit-input" rows="4">${esc(txt)}</textarea>`, `<button class="btn primary" id="btn-save-edit">Сохранить</button>`));
    $('btn-save-edit').onclick = () => {
      const newText = $('edit-input').value.trim();
      if (!newText) return;
      const chat = getChat(state.currentChatId);
      if (chat.type === 'dm') {
        showToast('В личных сообщениях редактирование не поддерживается (E2E).');
      } else {
        send({ t: 'msg_edit', chatId: state.currentChatId, id: m.id, payload: newText });
      }
      modalRoot().innerHTML = '';
    };
  }

  // ---------------- forward ----------------
  function openForwardModal(msg) {
    const chats = [...state.chats.values()].filter((c) => c.id !== state.currentChatId);
    openModal(modalShell('Переслать', `
      <div class="form-row"><label>Куда переслать</label></div>
      <div class="search-list" id="fwd-chats"></div>
    `));
    const box = $('fwd-chats');
    if (!chats.length) { box.innerHTML = '<div class="hint">Нет других чатов</div>'; return; }
    chats.forEach((c) => {
      const av = chatAvatarStyle(c);
      const row = el('div', 'user-row', `
        <span class="mini-ava" style="background:linear-gradient(135deg,${av.pal[0]},${av.pal[1]})">${esc(av.text)}</span>
        <span class="uname">${esc(chatTitle(c))}</span>
        <span class="uhandle">${esc(chatSubtitle(c))}</span>`);
      row.onclick = () => {
        const fwd = { name: chatTitle(getChat(state.currentChatId) || {}, true) || 'chat' };
        let fwdPayload = msg.payload;
        if (typeof fwdPayload === 'object' && fwdPayload.src !== undefined) fwdPayload = { ...fwdPayload };
        sendMessage(msg.kind, fwdPayload, { forwarded: fwd }, c.id);
        modalRoot().innerHTML = '';
        showToast('↪️ Переслано в «' + chatTitle(c) + '»');
      };
      box.appendChild(row);
    });
  }

  // ---------------- user card picker ----------------
  function openUserCardPicker() {
    openModal(modalShell('Ник-карточка', `
      <div class="form-row"><label>Выбери контакт</label></div>
      <div class="search-list" id="card-list"></div>
    `));
    const box = $('card-list');
    const shown = new Set();
    if (state.me) {
      const av = chatAvatarStyle(state.me);
      const row = el('div', 'user-row', `
        <span class="mini-ava" style="background:linear-gradient(135deg,${av.pal[0]},${av.pal[1]})">${esc(av.text)}</span>
        <span class="uname">${esc(state.me.nickname || state.me.username)}</span>
        <span class="uhandle">@${esc(state.me.username)} · Ты</span>`);
      row.onclick = () => sendCard(state.me);
      box.appendChild(row);
      shown.add(state.me.uid);
    }
    for (const c of state.chats.values()) {
      if (c.type !== 'dm') continue;
      const u = dmOther(c);
      if (u && !shown.has(u.uid)) {
        shown.add(u.uid);
        const av = chatAvatarStyle(u);
        const row = el('div', 'user-row', `
          <span class="mini-ava" style="background:linear-gradient(135deg,${av.pal[0]},${av.pal[1]})">${esc(av.text)}</span>
          <span class="uname">${esc(u.nickname || u.username)}</span>
          <span class="uhandle">@${esc(u.username)}</span>`);
        row.onclick = () => sendCard(u);
        box.appendChild(row);
      }
    }
    if (box.children.length < 2) box.appendChild(el('div', 'hint', 'Ещё нет контактов — начни диалог.'));
  }
  function sendCard(u) {
    const card = { uid: u.uid, username: u.username, nickname: u.nickname, avatar: u.avatar, bio: u.bio };
    sendMessage('card', card);
    modalRoot().innerHTML = '';
  }

  // ---------------- voice recording ----------------
  let mediaRecorder = null;
  let audioChunks = [];
  let recStartTime = 0;
  let recTimerInterval = null;

  function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') { stopRecording(); return; }
    startRecording();
  }
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      const mime = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || '';
      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      audioChunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size) audioChunks.push(e.data); };
      mediaRecorder.onstop = () => finishRecording(stream);
      mediaRecorder.start();
      recStartTime = Date.now();
      $('rec-bar').classList.remove('hidden');
      $('composer').classList.add('hidden');
      $('rec-timer').textContent = '0:00';
      recTimerInterval = setInterval(() => {
        const s = Math.floor((Date.now() - recStartTime) / 1000);
        $('rec-timer').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      }, 250);
    } catch (e) {
      showToast('🎤 Нет доступа к микрофону или пользователь отклонил запрос.');
    }
  }
  function finishRecording(stream) {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(recTimerInterval);
    if (!audioChunks.length) return;
    const blob = new Blob(audioChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
    const duration = (Date.now() - recStartTime) / 1000;
    uploadBlob(blob).then((url) => {
      sendMessage('voice', { url, duration, kind: 'voice' });
    }).catch(() => {
      showToast('⛔ Не удалось загрузить голосовое. Попробуй ещё раз.');
    });
  }
  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    $('rec-bar').classList.add('hidden');
    $('composer').classList.remove('hidden');
  }

  // ---------------- chat search ----------------
  let chatSearchActive = false;
  let chatSearchQuery = '';
  let chatSearchMatches = [];
  let jumpPendingId = null;
  function toggleChatSearch() {
    chatSearchActive = !chatSearchActive;
    $('chat-search-bar').classList.toggle('hidden', !chatSearchActive);
    if (chatSearchActive) { $('chat-search-input').value = ''; $('chat-search-input').focus(); updateChatSearch(); }
    else { chatSearchQuery = ''; rerenderMessages(); }
  }
  function updateChatSearch() {
    chatSearchQuery = ($('chat-search-input')?.value || '').trim().toLowerCase();
    const countEl = $('chat-search-count');
    if (!chatSearchQuery) {
      if (countEl) countEl.textContent = '';
      chatSearchMatches = [];
      rerenderMessages();
      return;
    }
    if (state.currentChatId && chatSearchQuery.length >= 2) {
      send({ t: 'msg_search', chatId: state.currentChatId, q: chatSearchQuery });
    }
    recomputeChatSearch();
    if (countEl) countEl.textContent = chatSearchMatches.length ? `${chatSearchMatches.length} совпадений` : 'Ничего';
    rerenderMessages();
  }
  function recomputeChatSearch() {
    chatSearchMatches = state.messages.filter((m) => {
      if (m.deleted) return false;
      const txt = typeof m.payload === 'string' ? m.payload : (m.payload?.text || '');
      return txt.toLowerCase().includes(chatSearchQuery);
    });
  }
  // ---------------- atmosphere per chat ----------------
  function openAtmosphereModal() {
    const c = getChat(state.currentChatId);
    const pats = ['aurora', 'rain', 'stars', 'hearts', 'matrix'];
    openModal(modalShell('Атмосфера чата', `
      <div class="opt-row">${pats.map((p) => `<button class="opt-chip ${c.atmos === p ? 'sel' : ''}" data-p="${p}">${atmosLabel(p)}</button>`).join('')}
      <button class="opt-chip ${!c.atmos ? 'sel' : ''}" data-p="default">🌐 глобальная</button></div>
      <div class="info-box">Каждый чат может иметь свою живую обстановку — это нигде так не делают.</div>
    `));
    document.querySelectorAll('[data-p]').forEach((b) => {
      b.onclick = () => {
        const p = b.dataset.p === 'default' ? null : b.dataset.p;
        if (p) send({ t: 'chat_update', chatId: c.id, atmos: null }); // noop
        if (p) {
          const cp = { ...c, atmos: p };
          state.chats.set(c.id, cp);
        } else {
          const cp = { ...c, atmos: null };
          state.chats.set(c.id, cp);
        }
        modalRoot().innerHTML = '';
        applyAtmosphere();
        showToast('Атмосфера обновлена 🎆');
      };
    });
  }
  function atmosLabel(p) {
    return { aurora: '🌌 аврора', rain: '🌧 дождь', stars: '🌠 звёзды', hearts: '💗 сердца', matrix: '💚 матрица' }[p];
  }

  // ---------------- image util ----------------
  function readResizeImage(file, max) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL(file.type.startsWith('image/png') ? 'image/png' : 'image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  // ---------------- toast ----------------
  let toastTimer = null;
  function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  function debounce(fn, ms) {
    let id;
    return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); };
  }

  // ---------------- init ----------------
  function init() {
    if (!state.token) $('onboarding').classList.remove('hidden');
    else $('onboarding').classList.add('hidden');

    applySettings();
    startAmbientBubbles();

    $('btn-start').onclick = () => { $('onboarding').classList.add('hidden'); $('register').classList.remove('hidden'); };
    $('btn-back-accounts').onclick = () => openAccountsModal();
    if (accountsList().length) $('btn-back-accounts').classList.remove('hidden');

    // nickname emoji strip on register
    const buildStrip = (panelId, targetId) => {
      const panel = $(panelId);
      EMOJI_LIST.slice(0, 18).forEach((e) => {
        const b = el('span', 'emoji-cell', e);
        b.onclick = () => {
          const inp = $(targetId);
          inp.value = e + ' ' + inp.value.replace(/^(?:\p{Extended_Pictographic}|\uFE0F|\u200D)+\s*/u, '');
          panel.classList.add('hidden');
        };
        panel.appendChild(b);
      });
      $(panelId.replace('panel', 'btn') || panelId).onclick = () => panel.classList.toggle('hidden');
    };
    buildStrip('nick-emoji-panel', 'nick-input');
    $('nick-emoji-btn').onclick = () => $('nick-emoji-panel').classList.toggle('hidden');

    $('btn-register').onclick = async () => {
      const nick = $('nick-input').value.trim();
      const username = $('reg-user').value.trim().toLowerCase();
      if (!nick) return $('reg-error').textContent = 'Придумай ник 😉';
      if (!/^[a-z0-9_]{3,32}$/.test(username)) return $('reg-error').textContent = 'Юзернейм: 3–32 символа, только латиница/цифры/_.';
      $('reg-error').classList.remove('hidden');
      $('reg-error').textContent = 'Генерирую крипто-ключи…';
      const kp = await Crypto.generateIdentity();
      Crypto.setIdentity(kp);
      send({ t: 'register', username, nickname: nick, pubkey: Crypto.getPublic(), ownerCode: $('owner-code').value.trim() });
      $('reg-error').textContent = '';
      $('reg-error').classList.add('hidden');
    };

    // try restore identity / token
    (async () => {
      if (state.token) {
        const acc = accountByToken(state.token);
        try {
          if (acc && acc.privateJwk) await Crypto.setFromJwk(acc.publicKeyPem, acc.publicJwk, acc.privateJwk);
          else await Crypto.restoreFromStorage();
        } catch { await Crypto.restoreFromStorage(); }
      } else {
        await Crypto.restoreFromStorage();
      }
      connect();
    })();

    // events
    $('btn-settings').onclick = openSettings;
    $('btn-offline').onclick = () => showToast('🕶️ Ты анонимен: нет ни номера, ни email, ни следа.');
    $('wallet-chip').onclick = openWalletModal;
    $('btn-switch-acc').onclick = openAccountsModal;
    $('btn-new-dm').onclick = openNewDm;
    $('btn-new-group').onclick = () => openNewGroup(false);
    $('btn-new-channel').onclick = () => openNewGroup(true);
    $('btn-emoji').onclick = openEmojiPicker;
    $('btn-sticker').onclick = openStickerPicker;
    $('btn-ghost').onclick = toggleGhostPanel;
    $('btn-atmos').onclick = openAtmosphereModal;
    $('btn-info').onclick = () => { const c = getChat(state.currentChatId); if (!c) return; if (c.type === 'dm') openProfileModal(dmOther(c)?.uid); else openMembersModal(); };
    $('btn-mic').onclick = toggleRecording;
    $('btn-card').onclick = openUserCardPicker;
    $('btn-search').onclick = toggleChatSearch;
    $('chat-search-close').onclick = toggleChatSearch;
    $('chat-search-input')?.addEventListener('input', debounce(updateChatSearch, 300));
    $('rec-cancel').onclick = () => {
      mediaRecorder && mediaRecorder.stop();
      $('rec-bar').classList.add('hidden');
      $('composer').classList.remove('hidden');
      audioChunks = [];
    };
    $('rec-done').onclick = () => stopRecording();
    $('btn-image').onclick = () => $('file-input').click();
    $('file-input').onchange = async (e) => {
      for (const f of [...e.target.files]) {
        try {
          const url = await uploadBlob(f);
          if (f.type.startsWith('image/')) {
            sendMessage('image', { url, name: f.name, size: f.size });
          } else {
            sendMessage('file', { url, name: f.name, size: f.size, kind: 'file' });
          }
        } catch {
          showToast('⛔ Не удалось загрузить «' + (f.name || 'файл') + '».');
        }
      }
      e.target.value = '';
    };
    $('btn-send').onclick = () => { const t = $('msg-input').value; if (t.trim()) sendMessage('text'); };

    const inp = $('msg-input');
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (state.settings.enterSend) {
          e.preventDefault();
          if (inp.value.trim() || ghostActive()) sendMessage(ghostActive() ? 'ghost' : 'text');
        }
      }
    });
    inp.addEventListener('input', () => { sendTyping(true); });

    $('ghost-timer').onchange = (e) => state.ghost.timer = +e.target.value;
    $('ghost-views').onchange = (e) => state.ghost.views = +e.target.value;

    document.querySelectorAll('.picker-tabs .tab').forEach((t) => t.onclick = () => setStickerTab(t.dataset.cat));

    $('search-input').addEventListener('input', debounce(() => {
      const q = $('search-input').value.trim().replace(/^@/, '');
      if (q.length >= 2) send({ t: 'search', q });
      refreshSearchBox();
    }, 200));
    $('search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = $('search-results').querySelector('.user-row');
        if (first) { e.preventDefault(); first.click(); }
      }
    });
    document.addEventListener('click', (e) => {
      if (!$('search-results').contains(e.target) && !$('search-input').contains(e.target)) {
        $('search-results').classList.add('hidden');
      }
    });
    window._searchCb = renderSearch;
    window._dmSearchCb = window._dmSearchCb || (() => {});

    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
  }

  function ghostActive() {
    return state.settings.ghostDefault || !$('ghost-panel').classList.contains('hidden');
  }

  function renderMembersInfo() {
    if (state.currentChatId) refreshSubtitle();
  }

  document.addEventListener('DOMContentLoaded', init);
})();