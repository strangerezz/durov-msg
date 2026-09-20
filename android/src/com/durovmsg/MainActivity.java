package com.durovmsg;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.AbsListView;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ScrollView;
import android.widget.Space;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {

    static final String DEFAULT_HOST = "ws://127.0.0.1:9173";
    static final String PREFS = "durov_prefs";

    final Handler ui = new Handler(Looper.getMainLooper());
    final Crypto crypto = new Crypto();
    WsClient ws;
    String serverHost = DEFAULT_HOST;
    String token;
    String meUid;
    JSONObject me;
    boolean switching;
    boolean reconnectPending;

    final Map<String, JSONObject> chats = new LinkedHashMap<>();
    final Map<String, Map<String, JSONObject>> members = new HashMap<>();
    final Map<String, JSONObject> myUsers = new HashMap<>();
    final List<JSONObject> messages = new ArrayList<>();
    final Map<String, Integer> typing = new HashMap<>();
    final Map<String, JSONObject> nftCache = new HashMap<>();
    final Map<String, JSONObject> catalog = new HashMap<>();
    int balance;
    List<JSONObject> walletGifts = new ArrayList<>();
    List<JSONObject> walletNft = new ArrayList<>();
    int ghostTimer = 300000;
    int ghostViews = 5;
    String currentChatId;
    boolean ghostMode;
    JSONObject replyTo;

    accountsStore accounts;

    LinearLayout root;
    TextView walletChip;
    ListView chatList;
    ChatListAdapter chatListAdapter;
    ListView msgList;
    MsgAdapter msgAdapter;
    EditText msgInput;
    TextView chatTitleView, chatSubView;
    FrameLayout overlay;

    static final Comparator<JSONObject> BY_TS = (a, b) -> Long.compare(a.optLong("ts"), b.optLong("ts"));
    static final List<String> EMOJI = java.util.Arrays.asList(
        "😀","😁","😂","🤣","😅","😊","😉","😍","🥰","😘","😎","🤓","🥳","😔","😢","😭",
        "😤","😡","🤯","😱","🤠","👻","💀","👽","🤖","👾","🦄","🐱","🐶","🦊","🐼","🦁",
        "🐸","🐵","🐷","🐙","🦋","🌹","🌻","🔥","⚡","💎","💥","✨","🎯","🎁","🏆","🚀",
        "✈️","🎮","🎧","🎸","🍕","🍔","🍩","🍺","☕","💊","💉","🧠","👑","💍","🏴☠️","🧨",
        "🔑","🧩","🎲","🎭","🌙","⭐","🌈","❄️","💧","🫥","✅","❌","❤️","👍","👎","🙏");

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setStatusBarColor(Color.parseColor("#0f1117"));
        getWindow().setNavigationBarColor(Color.parseColor("#0f1117"));
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0f1117"));
        setContentView(root);
        loadPrefs();
        showConnectScreen();
        connect();
    }

    // ===================== предпочтения / аккаунты =====================
    void loadPrefs() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        serverHost = p.getString("host", DEFAULT_HOST);
        accounts = new accountsStore();
        try {
            JSONArray arr = new JSONArray(p.getString("accounts", "[]"));
            for (int i = 0; i < arr.length(); i++) accounts.list.add(arr.getJSONObject(i));
        } catch (Exception ignored) {}
    }

    void saveHost() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("host", serverHost).apply();
    }

    void persistAccounts() {
        JSONArray arr = new JSONArray();
        for (JSONObject a : accounts.list) arr.put(a);
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("accounts", arr.toString()).apply();
    }

    JSONObject findAccountByUid(String uid) {
        for (JSONObject a : accounts.list) {
            try { if (uid.equals(a.optString("uid"))) return a; } catch (Exception ignored) {}
        }
        return null;
    }

    void upsertAccount(String uid, String tokenStr) {
        JSONObject existing = findAccountByUid(uid);
        JSONObject a = new JSONObject();
        try {
            if (me != null) {
                a.put("username", me.optString("username"));
                a.put("nickname", me.optString("nickname"));
                a.put("pubkey", me.optString("pubkey"));
            }
            a.put("uid", uid);
            a.put("token", tokenStr);
            a.put("host", serverHost);
            a.put("publicJwk", crypto.getPublicJwk());
            a.put("privateJwk", crypto.getPrivateJwk());
            a.put("active", true);
        } catch (JSONException ignored) {}
        if (existing != null) accounts.list.remove(existing);
        accounts.list.add(0, a);
        persistAccounts();
    }

    class accountsStore {
        final List<JSONObject> list = new ArrayList<>();
    }

    // ===================== websocket =====================
    void connect() {
        if (ws != null && ws.isOpen()) return;
        String url = serverHost;
        if (!url.startsWith("ws")) url = "ws://" + url;
        final String finUrl = url;
        ws = new WsClient(finUrl, new WsClient.Listener() {
            @Override public void onOpen(WsClient w) {
                ui.post(() -> {
                    updatingConnStatus("соединено ✓");
                    if (token != null && !token.isEmpty()) {
                        try {
                            JSONObject o = new JSONObject();
                            o.put("t", "login");
                            o.put("token", token);
                            if (crypto.hasIdentity()) o.put("pubkey", crypto.getPublic());
                            w.sendText(o.toString());
                        } catch (JSONException ignored) {}
                    }
                    flushPending();
                });
            }
            @Override public void onMessage(String text) {
                ui.post(() -> {
                    try { handle(new JSONObject(text)); } catch (Exception ignored) {}
                });
            }
            @Override public void onClose(int code, String reason) {
                ui.post(() -> {
                    if (switching) { switching = false; return; }
                    updatingConnStatus("соединение разорвано");
                    if (!reconnectPending) {
                        reconnectPending = true;
                        ui.postDelayed(() -> { reconnectPending = false; connect(); }, 2000);
                    }
                });
            }
            @Override public void onError(Exception e) {
                ui.post(() -> {
                    updatingConnStatus("не удалось подключиться к серверу");
                    if (ws != null) ws.close(1001, "err");
                });
            }
        });
        ws.connect();
    }

    final List<JSONObject> pendingCommands = new ArrayList<>();

    void send(JSONObject o) {
        if (ws != null && ws.isOpen()) {
            ws.sendText(o.toString());
        } else {
            pendingCommands.add(o);
            if (connectedStatus != null) updatingConnStatus("подключаюсь…");
            connect();
        }
    }

    void flushPending() {
        if (pendingCommands.isEmpty() || ws == null || !ws.isOpen()) return;
        List<JSONObject> flush = new ArrayList<>(pendingCommands);
        pendingCommands.clear();
        for (JSONObject o : flush) ws.sendText(o.toString());
    }

    TextView connectedStatus;

    void updatingConnStatus(String s) {
        if (connectedStatus != null) {
            connectedStatus.setText("🛜 " + s);
        }
    }

    JSONObject o(String t) {
        JSONObject j = new JSONObject();
        try { j.put("t", t); } catch (JSONException ignored) {}
        return j;
    }

    // ===================== handlers =====================
    void handle(JSONObject m) {
        String t = m.optString("t");
        try {
            switch (t) {
                case "registered":
                case "logged_in": {
                    me = m.getJSONObject("me");
                    meUid = me.getString("uid");
                    token = m.getString("token");
                    myUsers.put(meUid, me);
                    if (!crypto.hasIdentity()) {
                        JSONObject acc = findAccountByUid(meUid);
                        if (acc != null) {
                            try { crypto.setIdentity(acc.optString("publicJwk"), acc.optString("privateJwk")); } catch (Exception ignored) {}
                        }
                    }
                    upsertAccount(meUid, token);
                    send(o("wallet_get"));
                    showChatsScreen();
                    break;
                }
                case "error": {
                    toast("⛔ " + m.optString("msg", "ошибка"));
                    if ("bad_token".equals(m.optString("code"))) {
                        token = null;
                        showConnectScreen();
                    }
                    break;
                }
                case "chat_list": {
                    JSONArray arr = m.optJSONArray("chats");
                    for (int i = 0; i < len(arr); i++) {
                        JSONObject c = arr.getJSONObject(i);
                        chats.put(c.optString("id"), c);
                    }
                    renderChatList();
                    break;
                }
                case "unread_update": {
                    JSONObject c = chats.get(m.optString("chatId"));
                    if (c != null) {
                        c.put("unread", m.optInt("unread"));
                        renderChatList();
                    }
                    break;
                }
                case "dm_created": case "chat_created": {
                    JSONObject c = m.getJSONObject("chat");
                    chats.put(c.optString("id"), c);
                    if (m.has("other")) {
                        JSONObject other = m.getJSONObject("other");
                        myUsers.put(other.optString("uid"), other);
                    }
                    renderChatList();
                    openChat(c.optString("id"));
                    break;
                }
                case "chat_invited": {
                    JSONObject c = m.getJSONObject("chat");
                    chats.put(c.optString("id"), c);
                    renderChatList();
                    toast("👋 Тебя добавили в «" + c.optString("title") + "»");
                    break;
                }
                case "chat_opened": {
                    JSONObject c = m.getJSONObject("chat");
                    chats.put(c.optString("id"), c);
                    Map<String, JSONObject> mm = new LinkedHashMap<>();
                    JSONArray mems = m.optJSONArray("members");
                    for (int i = 0; i < len(mems); i++) {
                        JSONObject u = mems.getJSONObject(i);
                        mm.put(u.optString("uid"), u);
                        myUsers.put(u.optString("uid"), u);
                    }
                    members.put(c.optString("id"), mm);
                    messages.clear();
                    JSONArray msgs = m.optJSONArray("messages");
                    for (int i = 0; i < len(msgs); i++) {
                        JSONObject mm2 = msgs.getJSONObject(i);
                        cacheDecrypt(mm2);
                        messages.add(mm2);
                    }
                    messages.sort(BY_TS);
                    if (msgList != null) {
                        msgAdapter = new MsgAdapter();
                        msgList.setAdapter(msgAdapter);
                    }
                    renderOpenChat();
                    markSeen();
                    break;
                }
                case "chat_more": {
                    if (!m.optString("chatId").equals(currentChatId)) break;
                    JSONArray arr = m.optJSONArray("messages");
                    List<JSONObject> add = new ArrayList<>();
                    for (int i = 0; i < len(arr); i++) {
                        JSONObject mm = arr.getJSONObject(i);
                        boolean known = false;
                        for (JSONObject x : messages) if (x.optString("id").equals(mm.optString("id"))) { known = true; break; }
                        if (!known) add.add(mm);
                    }
                    messages.addAll(add);
                    messages.sort(BY_TS);
                    if (msgAdapter != null) msgAdapter.notifyDataSetChanged();
                    break;
                }
                case "chat_force_close":
                case "chat_forced_close": {
                    if (m.optString("chatId").equals(currentChatId)) closeChatView();
                    break;
                }
                case "chat_updated": {
                    JSONObject c = m.getJSONObject("chat");
                    chats.put(c.optString("id"), c);
                    renderChatList();
                    if (c.optString("id").equals(currentChatId)) renderOpenChat();
                    break;
                }
                case "presence": {
                    JSONObject pr = m.optJSONObject("presence");
                    if (pr != null) {
                        JSONObject u = myUsers.get(pr.optString("uid"));
                        if (u != null) u.put("online", pr.optBoolean("online"));
                        renderChatList();
                        if (m.optString("chatId").equals(currentChatId)) renderChatHeader();
                    }
                    break;
                }
                case "msg_new": {
                    handleNewMessage(m);
                    break;
                }
                case "msg_updated": {
                    JSONObject mm = m.getJSONObject("message");
                    for (int i = 0; i < messages.size(); i++) {
                        if (messages.get(i).optString("id").equals(mm.optString("id"))) {
                            // реакция могла придти на удалённое — обновляем целиком
                            messages.set(i, mm);
                            break;
                        }
                    }
                    if (msgAdapter != null) { msgAdapter.notifyDataSetChanged(); renderChatList(); }
                    break;
                }
                case "msg_deleted": {
                    for (int i = 0; i < messages.size(); i++) {
                        if (messages.get(i).optString("id").equals(m.optString("id"))) { messages.remove(i); break; }
                    }
                    if (msgAdapter != null) msgAdapter.notifyDataSetChanged();
                    break;
                }
                case "msg_seen": {
                    String id = m.optString("id");
                    for (JSONObject x : messages) {
                        if (x.optString("id").equals(id)) {
                            JSONArray sb = x.optJSONArray("seenBy");
                            if (sb == null) sb = new JSONArray();
                            boolean has = false;
                            for (int i = 0; i < sb.length(); i++) if (sb.optString(i).equals(m.optString("uid"))) has = true;
                            if (!has) sb.put(m.optString("uid"));
                            x.remove("seenBy");
                            x.put("seenBy", sb);
                        }
                    }
                    if (msgAdapter != null) msgAdapter.notifyDataSetChanged();
                    break;
                }
                case "typing": {
                    String cid = m.optString("chatId");
                    int n = typing.getOrDefault(cid, 0);
                    typing.put(cid, m.optBoolean("typing") ? n + 1 : Math.max(0, n - 1));
                    if (cid.equals(currentChatId)) renderChatHeader();
                    break;
                }
                case "profile_updated": {
                    if (m.has("me")) {
                        me = m.getJSONObject("me");
                        if (meUid != null) myUsers.put(meUid, me);
                    } else if (m.has("user")) {
                        JSONObject u = m.getJSONObject("user");
                        myUsers.put(u.optString("uid"), u);
                    }
                    renderChatList();
                    if (currentChatId != null) renderOpenChat();
                    if (msgAdapter != null) msgAdapter.notifyDataSetChanged();
                    break;
                }
                case "wallet":
                case "wallet_update": {
                    balance = m.optInt("balance");
                    if (m.has("gifts")) {
                        walletGifts = new ArrayList<>();
                        JSONArray a = m.optJSONArray("gifts");
                        for (int i = 0; i < len(a); i++) walletGifts.add(a.getJSONObject(i));
                    }
                    if (m.has("nft")) {
                        walletNft = new ArrayList<>();
                        JSONArray a = m.optJSONArray("nft");
                        for (int i = 0; i < len(a); i++) {
                            JSONObject n = new JSONObject();
                            n.put("slug", a.getString(i));
                            n.put("status", "owned");
                            walletNft.add(n);
                        }
                    }
                    updateWalletChip();
                    if (walletScreen != null) renderWallet();
                    break;
                }
                case "gifts_catalog": {
                    JSONArray a = m.optJSONArray("gifts");
                    catalog.clear();
                    for (int i = 0; i < len(a); i++) {
                        JSONObject g = a.getJSONObject(i);
                        catalog.put(g.optString("id"), g);
                    }
                    balance = m.optInt("balance");
                    updateWalletChip();
                    if (walletScreen != null) renderWallet();
                    break;
                }
                case "gift_bought": case "gift_sent": case "gift_upgraded": case "gift_withdrawn": case "nft_bought": {
                    if (m.has("balance")) balance = m.optInt("balance");
                    String msg = "OK";
                    if (t.equals("gift_bought")) msg = "🎁 Подарок добавлен в коллекцию";
                    if (t.equals("gift_sent")) msg = "🎁 Ты подарил «" + (m.has("gift") ? m.optJSONObject("gift").optString("name") : "«") + "»";
                    if (t.equals("gift_upgraded")) msg = "💎 Подарок стал уникальным NFT!";
                    if (t.equals("gift_withdrawn")) msg = "💸 Подарок обменян на звёзды";
                    if (t.equals("nft_bought")) msg = "💎 NFT @" + m.optString("slug") + " теперь твой";
                    toast(msg);
                    updateWalletChip();
                    send(o("wallet_get"));
                    break;
                }
                case "gift_received": {
                    toast("🎁 Тебе подарили «" + (m.has("gift") ? m.optJSONObject("gift").optString("name") : "«") + "» (+" + m.optInt("bonus", 0) + " ⭐)");
                    if (m.has("balance")) balance = m.optInt("balance");
                    updateWalletChip();
                    send(o("wallet_get"));
                    break;
                }
                case "nft_list": {
                    JSONArray a = m.optJSONArray("auctions");
                    for (int i = 0; i < len(a); i++) nftCache.put(a.getJSONObject(i).optString("slug"), a.getJSONObject(i));
                    JSONArray b = m.optJSONArray("mine");
                    for (int i = 0; i < len(b); i++) nftCache.put(b.getJSONObject(i).optString("slug"), b.getJSONObject(i));
                    if (walletScreen != null) renderWallet();
                    break;
                }
                case "nft_update": {
                    JSONObject c = m.getJSONObject("c");
                    nftCache.put(c.optString("slug"), c);
                    if (walletScreen != null) renderWallet();
                    break;
                }
                case "nft_bid_ok": {
                    toast("✅ Ставка " + m.optInt("amount") + " ⭐ принята");
                    if (m.has("balance")) balance = m.optInt("balance");
                    if (m.has("c")) nftCache.put(m.optJSONObject("c").optString("slug"), m.optJSONObject("c"));
                    updateWalletChip();
                    if (walletScreen != null) renderWallet();
                    break;
                }
                case "nft_won": {
                    toast("🏆 Ты выиграл аукцион @" + m.optString("slug") + "!");
                    send(o("wallet_get"));
                    break;
                }
                case "nft_sold": {
                    toast("📢 Аукцион @" + m.optString("slug") + " запущен");
                    break;
                }
                case "nft_cancelled": {
                    toast("↩️ Аукцион @" + m.optString("slug") + " снят");
                    break;
                }
                case "nft_sold_out": {
                    toast("💰 @" + m.optString("slug") + " продан! +" + m.optInt("proceeds", 0) + " ⭐ (минус комиссия)");
                    send(o("wallet_get"));
                    break;
                }
                case "nft_claimed": {
                    toast("👑 Юзернейм теперь @" + m.optString("username") + " (NFT)");
                    if (m.has("me")) {
                        me = m.getJSONObject("me");
                        if (meUid != null) myUsers.put(meUid, me);
                    }
                    send(o("wallet_get"));
                    break;
                }
            case "search_results": {
                    JSONArray a = m.optJSONArray("users");
                    List<String> lines = new ArrayList<>();
                    final List<JSONObject> us = new ArrayList<>();
                    for (int i = 0; i < len(a); i++) {
                        JSONObject u = a.getJSONObject(i);
                        myUsers.put(u.optString("uid"), u);
                        us.add(u);
                        lines.add("👤 @" + u.optString("username") + " — " + u.optString("nickname"));
                    }
                    if (us.isEmpty()) { toast("Никого не нашли"); break; }
                    showChoice("Результаты", lines, idx -> {
                        JSONObject u = us.get(idx);
                        JSONObject o = o("dm_create");
                        try { o.put("username", u.optString("username")); } catch (JSONException ignored) {}
                        send(o);
                        showChatsScreen();
                    });
                    break;
                }
                case "msg_search_results": {
                    JSONArray results = m.optJSONArray("messages");
                    List<String> lines = new ArrayList<>();
                    for (int i = 0; i < len(results); i++) {
                        JSONObject r = results.getJSONObject(i);
                        String who = r.optString("sender", "").equals(meUid) ? "Я" :
                                myUsers.containsKey(r.optString("sender")) ? myUsers.get(r.optString("sender")).optString("nickname") : "?";
                        lines.add(who + ": " + shortText(firstLineOf(r)));
                    }
                    if (lines.isEmpty()) { toast("Ничего не найдено"); break; }
                    showChoice("Найдено: " + lines.size(), lines, idx -> {
                        try {
                            JSONObject r = results.getJSONObject(idx);
                            if (currentChatId != null) {
                                boolean known = false;
                                for (JSONObject x : messages) if (x.optString("id").equals(r.optString("id"))) { known = true; break; }
                                if (!known) { messages.add(r); messages.sort(BY_TS); if (msgAdapter != null) msgAdapter.notifyDataSetChanged(); }
                            }
                        } catch (JSONException ignored) {}
                    });
                    break;
                }
            }
        } catch (JSONException e) {
            // ignore malformed
        }
    }

    static int len(JSONArray a) { return a == null ? 0 : a.length(); }

    void handleNewMessage(JSONObject m) throws JSONException {
        JSONObject mm = m.getJSONObject("message");
        boolean self = m.optBoolean("self");
        String cid = m.optString("chatId");
        JSONObject c = chats.get(cid);
        cacheDecrypt(mm);
        if (self) {
            for (int i = 0; i < messages.size(); i++) {
                if (messages.get(i).optString("id").equals(mm.optString("id"))) { messages.set(i, mm); break; }
            }
        }
        if (cid.equals(currentChatId)) {
            boolean known = false;
            for (JSONObject x : messages) if (x.optString("id").equals(mm.optString("id"))) { known = true; break; }
            if (!known) {
                messages.add(mm);
                messages.sort(BY_TS);
                if (msgAdapter != null) {
                    msgAdapter.notifyDataSetChanged();
                    if (msgList != null) msgList.setSelection(messages.size() - 1);
                }
            }
            markSeen();
        }
        if (c != null) {
            try {
                c.put("last", mm);
                c.put("lastTs", mm.optLong("ts"));
                if (!self) c.put("unread", c.optInt("unread") + 1);
            } catch (Exception ignored) {}
        }
        if (msgAdapter != null) renderChatList();
    }

    void cacheDecrypt(JSONObject m) {
        if (m == null || !m.has("cipher") || !crypto.hasIdentity()) return;
        String id = m.optString("id");
        if (id.isEmpty() || decrypted.containsKey(id)) return;
        String cid = m.optString("chatId");
        JSONObject chat = chats.get(cid);
        JSONObject peer = chat != null ? dmOther(chat) : null;
        if (peer == null) return;
        String pub = peer.optString("pubkey");
        if (pub.isEmpty()) return;
        try {
            String plain = crypto.decryptFrom(pub, m.getJSONObject("cipher"));
            try {
                JSONObject p = new JSONObject(plain);
                if (p.has("text")) plain = p.optString("text");
            } catch (JSONException ignored) {}
            decrypted.put(id, plain);
        } catch (Exception ignored) {}
    }

    void markSeen() {
        if (currentChatId == null || messages.isEmpty() || me == null) return;
        JSONObject last = messages.get(messages.size() - 1);
        try {
            JSONArray sb = last.optJSONArray("seenBy");
            boolean seen = false;
            if (sb != null) {
                for (int i = 0; i < sb.length(); i++) if (sb.optString(i).equals(me.optString("uid"))) { seen = true; break; }
            }
            if (!seen) {
                JSONObject o = o("msg_seen");
                o.put("chatId", currentChatId);
                o.put("id", last.optString("id"));
                send(o);
            }
        } catch (JSONException ignored) {}
    }

    // ===================== helpers UI =====================
    void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }

    void setScreen(ViewGroup v) {
        root.removeAllViews();
        root.addView(v, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    LinearLayout.LayoutParams ff() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    LinearLayout.LayoutParams f1() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
    }

    Space sp(int px) {
        Space s = new Space(this);
        s.setLayoutParams(new LinearLayout.LayoutParams(1, px));
        return s;
    }

    TextView txt(String s, float size, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextColor(color);
        t.setTextSize(size);
        return t;
    }

    Button btn(String label, Runnable act) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setBackgroundColor(Color.parseColor("#2b356b"));
        b.setTextColor(Color.WHITE);
        b.setOnClickListener(v -> act.run());
        return b;
    }

    TextView chip(String label, Runnable act) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextSize(20);
        t.setGravity(Gravity.CENTER);
        t.setTextColor(Color.WHITE);
        t.setPadding(12, 4, 12, 4);
        t.setBackgroundColor(Color.parseColor("#262a38"));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(48, 48);
        lp.setMargins(6, 0, 0, 0);
        t.setLayoutParams(lp);
        t.setOnClickListener(v -> act.run());
        return t;
    }

    void showOverlay(View v) {
        hideOverlay();
        overlay = new FrameLayout(this);
        overlay.setBackgroundColor(0xAA000000);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.CENTER;
        lp.setMargins(40, 0, 40, 0);
        overlay.addView(v, lp);
        root.addView(overlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    void hideOverlay() {
        if (overlay != null) {
            root.removeView(overlay);
            overlay = null;
        }
    }

    void inputDialog(String title, String init, boolean numeric, EditTextCb cb) {
        LinearLayout l = col();
        l.setPadding(24, 24, 24, 24);
        l.setBackgroundColor(Color.parseColor("#1b1e2a"));
        l.addView(txt(title, 18, Color.WHITE), ff());
        EditText e = new EditText(this);
        e.setText(init);
        if (numeric) e.setInputType(InputType.TYPE_CLASS_NUMBER);
        e.setTextColor(Color.WHITE);
        e.setBackgroundColor(Color.parseColor("#262a38"));
        l.addView(e, ff());
        l.addView(sp(12));
        Button ok = new Button(this);
        ok.setText("Готово");
        ok.setAllCaps(false);
        ok.setOnClickListener(v -> { hideOverlay(); cb.run(e.getText().toString()); });
        l.addView(ok, ff());
        showOverlay(l);
    }

    interface EditTextCb { void run(String text); }
    interface ChoiceCb { void run(int index); }
    interface EmojiCb { void run(String emoji); }

    LinearLayout col() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    LinearLayout row() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    // ===================== экран: онбординг (как в мессенджере) =====================
    void showConnectScreen() {
        LinearLayout l = col();
        l.setPadding(32, 72, 32, 32);
        l.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView logo = txt("✈️", 72, Color.WHITE);
        logo.setGravity(Gravity.CENTER);
        l.addView(logo, ff());

        TextView title = txt("DUROV MSG", 34, Color.WHITE);
        title.setGravity(Gravity.CENTER);
        l.addView(title, ff());
        l.addView(sp(6));
        TextView sub = txt("Приватный мессенджер с E2E.\nЧат, группа, канал, кошелёк и NFT — начиная с себя.", 14, Color.parseColor("#8a90a8"));
        sub.setGravity(Gravity.CENTER);
        sub.setTextSize(15);
        l.addView(sub, ff());
        l.addView(sp(40));

        if (accounts.list.isEmpty()) {
            Button start = btn("Начать общение", this::showRegisterScreen);
            start.setBackgroundColor(Color.parseColor("#1f8fff"));
            start.setTextColor(Color.WHITE);
            start.setTextSize(18);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, 56);
            l.addView(start, lp);
            l.addView(sp(10));
            Button tar = btn("Войти в аккаунт", this::showLoginScreen);
            tar.setBackgroundColor(Color.parseColor("#232838"));
            l.addView(tar, ff());
        } else {
            l.addView(txt("Мой аккаунт:", 14, Color.parseColor("#8a90a8")), ff());
            l.addView(sp(8));
            for (JSONObject a : accounts.list) {
                LinearLayout card = row();
                card.setPadding(18, 16, 18, 16);
                card.setBackgroundColor(Color.parseColor("#1b1e2a"));
                TextView nm = txt(a.optString("nickname", "@" + a.optString("username")) + "  " + "(@" + a.optString("username") + ")", 17, Color.WHITE);
                if (a.optBoolean("active")) nm.setTextColor(Color.parseColor("#1f8fff"));
                card.addView(nm, ff());
                card.setOnClickListener(v -> {
                    serverHost = a.optString("host", serverHost);
                    saveHost();
                    token = a.optString("token");
                    try { if (!a.optString("publicJwk").isEmpty()) crypto.setIdentity(a.optString("publicJwk"), a.optString("privateJwk")); } catch (Exception ignored) {}
                    meUid = a.optString("uid");
                    showChatsScreen();
                    connect();
                });
                l.addView(card, ff());
                l.addView(sp(10));
            }
            l.addView(sp(8));
            Button add = btn("＋ Добавить аккаунт", this::showRegisterScreen);
            add.setBackgroundColor(Color.parseColor("#232838"));
            l.addView(add, ff());
            l.addView(sp(10));
            Button log = btn("Войти по ключу", this::showLoginScreen);
            log.setBackgroundColor(Color.parseColor("#232838"));
            l.addView(log, ff());
        }

        l.addView(sp(28));
        TextView hostLbl = txt("Сервер: " + serverHost, 13, Color.parseColor("#5a6070"));
        hostLbl.setGravity(Gravity.CENTER);
        l.addView(hostLbl, ff());
        l.addView(sp(4));
        TextView chg = txt("изменить адрес сервера", 14, Color.parseColor("#1f8fff"));
        chg.setGravity(Gravity.CENTER);
        chg.setOnClickListener(v -> inputDialog("Адрес сервера", serverHost, false, h -> {
            updateHost(h.trim());
            showConnectScreen();
        }));
        l.addView(chg, ff());

        connectedStatus = null;
        setScreen(l);
        connectedStatus = new TextView(this);
        connectedStatus.setText("🛜 подключаюсь…");
        connectedStatus.setTextSize(13);
        connectedStatus.setTextColor(Color.parseColor("#8a90a8"));
        connectedStatus.setGravity(Gravity.CENTER);
        l.addView(connectedStatus, ff());
        connect();
    }

    void showRegisterScreen() {
        LinearLayout l = col();
        l.setPadding(32, 64, 32, 32);

        TextView title = txt("Создать аккаунт", 26, Color.WHITE);
        l.addView(title, ff());
        l.addView(sp(8));
        l.addView(txt("Ник виден всем в чате. Юзернейм — твой адрес: @ник.", 14, Color.parseColor("#8a90a8")), ff());
        l.addView(sp(28));

        final EditText nick = input("", "Например: Павел");
        nick.setHintTextColor(Color.parseColor("#5a6070"));
        l.addView(nick, ff());
        l.addView(sp(12));
        final EditText user = input("", "Придумай юзернейм: pavel_d");
        user.setHintTextColor(Color.parseColor("#5a6070"));
        l.addView(user, ff());
        l.addView(sp(28));

        Button reg = btn("Зарегистрироваться", () -> {
            String u = user.getText().toString().trim().toLowerCase().replaceAll("^@", "");
            String n = nick.getText().toString().trim();
            if (n.isEmpty()) { toast("Придумай ник 😉"); return; }
            if (u.length() < 3) { toast("Юзернейм — минимум 3 символа"); return; }
            toast("🛰 Создаю аккаунт и ключи…");
            new Thread(() -> {
                try {
                    crypto.generateIdentity();
                    ui.post(() -> {
                        try {
                            JSONObject o = o("register");
                            o.put("username", u);
                            o.put("nickname", n);
                            o.put("pubkey", crypto.getPublic());
                            send(o);
                        } catch (JSONException ignored) {}
                    });
                } catch (Exception e) {
                    ui.post(() -> toast("Не удалось сгенерировать ключи"));
                }
            }).start();
        });
        reg.setBackgroundColor(Color.parseColor("#1f8fff"));
        reg.setTextSize(17);
        l.addView(reg, ff());
        l.addView(sp(12));
        Button back = btn("← Назад", this::showConnectScreen);
        back.setBackgroundColor(Color.parseColor("#232838"));
        l.addView(back, ff());
        l.addView(sp(24));

        connectedStatus = new TextView(this);
        connectedStatus.setText("🛜 подключаюсь…");
        connectedStatus.setTextSize(13);
        connectedStatus.setTextColor(Color.parseColor("#8a90a8"));
        connectedStatus.setGravity(Gravity.CENTER);
        l.addView(connectedStatus, ff());

        setScreen(l);
        connect();
    }

    void updateHost(String h) {
        if (!h.isEmpty()) { serverHost = h; saveHost(); }
    }

    void showLoginScreen() {
        ScrollView sc = new ScrollView(this);
        LinearLayout l = col();
        l.setPadding(28, 60, 28, 28);
        l.addView(txt("Вход по ключу", 24, Color.WHITE), ff());
        l.addView(sp(12));
        final EditText tok = input("", "Вставь ключ (token)");
        l.addView(tok, ff());
        l.addView(sp(8));
        final EditText pass = input("", "Или импортируй бэкап: пароль");
        l.addView(pass, ff());
        l.addView(sp(8));
        final EditText backup = input("", "Или вставь JSON бэкапа");
        l.addView(backup, ff());
        l.addView(sp(16));
        l.addView(btn("Войти по ключу", () -> {
            String tk = tok.getText().toString().trim();
            if (tk.isEmpty()) { toast("Введи ключ"); return; }
            toast("🛰 Подключаюсь…");
            token = tk;
            JSONObject o = o("login");
            try {
                o.put("token", tk);
                if (crypto.hasIdentity()) o.put("pubkey", crypto.getPublic());
            } catch (JSONException ignored) {}
            send(o);
        }), ff());
        l.addView(sp(8));
        l.addView(btn("Импорт из бэкапа", () -> {
            try {
                JSONObject b = new JSONObject(backup.getText().toString().trim());
                crypto.importBackup(b, pass.getText().toString());
                toast("👑 Ключи восстановлены из бэкапа");
            } catch (Exception e) {
                toast("⛔ Не удалось импортировать бэкап");
            }
        }), ff());
        l.addView(sp(8));
        l.addView(btn("← Назад", this::showConnectScreen), ff());

        connectedStatus = new TextView(this);
        connectedStatus.setText("🛜 подключаюсь…");
        connectedStatus.setTextSize(13);
        connectedStatus.setTextColor(Color.parseColor("#8a90a8"));
        connectedStatus.setGravity(Gravity.CENTER);
        l.addView(connectedStatus, ff());
        sc.addView(l);
        setScreen(sc);
        connect();
    }

    EditText input(String def, String hint) {
        EditText e = new EditText(this);
        e.setText(def);
        e.setHint(hint);
        e.setSingleLine(true);
        e.setTextColor(Color.WHITE);
        e.setHintTextColor(Color.parseColor("#5a6070"));
        e.setBackgroundColor(Color.parseColor("#1b1e2a"));
        return e;
    }

    // ===================== экран: список чатов =====================
    void showChatsScreen() {
        LinearLayout l = col();
        l.setBackgroundColor(Color.parseColor("#0f1117"));

        LinearLayout header = row();
        header.setPadding(14, 14, 14, 10);
        header.setBackgroundColor(Color.parseColor("#141726"));
        header.addView(txt("DUROV MSG", 22, Color.WHITE), ff());
        walletChip = new TextView(this);
        walletChip.setText("⭐ —");
        walletChip.setTextSize(15);
        walletChip.setTextColor(Color.parseColor("#ffd54f"));
        walletChip.setGravity(Gravity.CENTER);
        walletChip.setPadding(10, 6, 10, 6);
        walletChip.setBackgroundColor(Color.parseColor("#262a38"));
        walletChip.setOnClickListener(v -> showWalletScreen());
        header.addView(walletChip);
        l.addView(header, ff());

        LinearLayout actions = row();
        actions.setGravity(Gravity.CENTER);
        actions.addView(btn("🔍 Поиск", this::showSearchScreen), ff());
        actions.addView(btn("➕ Новый чат", this::showNewChatScreen), ff());
        actions.addView(btn("⚙️", this::showSettingsScreen), ff());
        l.addView(actions, ff());

        chatList = new ListView(this);
        chatList.setDivider(null);
        chatList.setBackgroundColor(Color.parseColor("#0f1117"));
        l.addView(chatList, f1());

        setScreen(l);
        renderChatList();
    }

    void renderChatList() {
        if (chatList == null) return;
        List<JSONObject> items = new ArrayList<>(chats.values());
        items.sort((a, b) -> Long.compare(b.optLong("lastTs"), a.optLong("lastTs")));
        chatList.setAdapter(new BaseAdapter() {
            public int getCount() { return items.size(); }
            public Object getItem(int i) { return items.get(i); }
            public long getItemId(int i) { return i; }
            public View getView(int i, View c, ViewGroup p) {
                JSONObject ch = items.get(i);
                LinearLayout rowL = new LinearLayout(MainActivity.this);
                rowL.setOrientation(LinearLayout.HORIZONTAL);
                rowL.setGravity(Gravity.CENTER_VERTICAL);
                rowL.setPadding(18, 14, 18, 14);
                rowL.setBackgroundColor(Color.parseColor("#12151f"));

                TextView avatar = new TextView(MainActivity.this);
                avatar.setText(chatIcon(ch));
                avatar.setTextSize(30);
                avatar.setGravity(Gravity.CENTER);
                avatar.setBackgroundColor(Color.parseColor("#1f8fff"));
                LinearLayout.LayoutParams avlp = new LinearLayout.LayoutParams(56, 56);
                avlp.setMargins(0, 0, 14, 0);
                avatar.setLayoutParams(avlp);
                rowL.addView(avatar);

                LinearLayout mid = new LinearLayout(MainActivity.this);
                mid.setOrientation(LinearLayout.VERTICAL);
                mid.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                TextView name = new TextView(MainActivity.this);
                name.setText(chatTitle(ch));
                name.setTextSize(17);
                name.setTextColor(Color.WHITE);
                mid.addView(name);
                TextView last = new TextView(MainActivity.this);
                last.setText(chatPreview(ch));
                last.setTextSize(13);
                last.setTextColor(Color.parseColor("#8a90a8"));
                last.setMaxLines(1);
                mid.addView(last);
                rowL.addView(mid);

                int unread = ch.optInt("unread");
                LinearLayout right = new LinearLayout(MainActivity.this);
                right.setOrientation(LinearLayout.VERTICAL);
                right.setGravity(Gravity.CENTER_HORIZONTAL);
                TextView time = new TextView(MainActivity.this);
                time.setText(fmtChatTime(ch.optLong("lastTs")));
                time.setTextSize(12);
                time.setTextColor(Color.parseColor("#5a6070"));
                right.addView(time);
                if (unread > 0) {
                    TextView badge = new TextView(MainActivity.this);
                    badge.setText(String.valueOf(unread));
                    badge.setTextSize(13);
                    badge.setTextColor(Color.WHITE);
                    badge.setGravity(Gravity.CENTER);
                    badge.setBackgroundColor(Color.parseColor("#1f8fff"));
                    right.addView(badge);
                }
                rowL.addView(right);

                rowL.setOnClickListener(v -> {
                    JSONObject chatX = chats.get(ch.optString("id"));
                    if (chatX != null) { try { chatX.put("unread", 0); } catch (JSONException ignored) {} }
                    renderChatList();
                    openChat(ch.optString("id"));
                });
                return rowL;
            }
        });
    }

    String chatIcon(JSONObject c) {
        String t = c.optString("type");
        if (t.equals("group")) return "👥";
        if (t.equals("channel")) return "📢";
        return "💬";
    }

    String chatPreview(JSONObject ch) {
        JSONObject last = ch.optJSONObject("last");
        if (last == null) return "";
        if (last.optBoolean("deleted")) return "Сообщение удалено";
        String kind = last.optString("kind", "text");
        String sender = "";
        if (!last.optString("sender", "").equals(meUid)) {
            JSONObject u = myUsers.get(last.optString("sender"));
            if (u != null) sender = u.optString("nickname", u.optString("username", "")) + ": ";
        }
        String body;
        switch (kind) {
            case "image": body = "🖼 Фото"; break;
            case "file": body = "📄 Файл"; break;
            case "voice": body = "🎤 Голосовое"; break;
            case "gif": body = "🎬 GIF"; break;
            case "sticker": body = "🙂 Стикер"; break;
            case "card": body = "🪪 Визитка"; break;
            case "system": return "📌 " + last.optString("payload", "");
            default: {
                JSONObject p = last.optJSONObject("payload");
                if (p != null) {
                    body = (p.has("text") ? p.optString("text") : p.optString("url", ""));
                } else if (last.has("cipher")) {
                    body = decrypted.get(last.optString("id"));
                    if (body == null) body = "🔒 Зашифровано";
                } else {
                    body = last.optString("payload", "");
                }
            }
        }
        return sender + body;
    }

    String fmtChatTime(long ts) {
        if (ts <= 0) return "";
        return fmtTime(ts);
    }

    String fmtTime(long ts) {
        if (ts <= 0) return "";
        java.util.Calendar cal = java.util.Calendar.getInstance();
        cal.setTimeInMillis(ts);
        java.util.Calendar now = java.util.Calendar.getInstance();
        if (cal.get(java.util.Calendar.YEAR) != now.get(java.util.Calendar.YEAR) ||
                cal.get(java.util.Calendar.DAY_OF_YEAR) != now.get(java.util.Calendar.DAY_OF_YEAR)) {
            return new java.text.SimpleDateFormat("dd.MM", java.util.Locale.getDefault()).format(new java.util.Date(ts));
        }
        return new java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(new java.util.Date(ts));
    }

    String chatTitle(JSONObject c) {
        if (c.optString("type").equals("dm")) {
            JSONObject other = dmOther(c);
            if (other != null) return other.optString("nickname", other.optString("username", "?"));
        }
        return c.optString("title", c.optString("id", "?"));
    }

    JSONObject dmOther(JSONObject chat) {
        JSONArray mems = chat.optJSONArray("members");
        if (meUid == null || mems == null) return null;
        for (int i = 0; i < mems.length(); i++) {
            String uid = mems.optString(i);
            if (!uid.equals(meUid)) {
                JSONObject u = myUsers.get(uid);
                if (u == null) {
                    Map<String, JSONObject> mm = members.get(chat.optString("id"));
                    if (mm != null) u = mm.get(uid);
                }
                return u;
            }
        }
        return null;
    }

    // ===================== переписка =====================
    void openChat(String chatId) {
        currentChatId = chatId;
        JSONObject o = o("chat_open");
        try { o.put("chatId", chatId); } catch (JSONException ignored) {}
        send(o);

        LinearLayout l = col();
        l.setBackgroundColor(Color.parseColor("#0f1117"));

        LinearLayout header = row();
        header.setPadding(10, 10, 10, 8);
        header.setBackgroundColor(Color.parseColor("#141726"));
        header.addView(btn("←", this::closeChatView));
        chatTitleView = txt("", 20, Color.WHITE);
        chatSubView = txt("", 12, Color.parseColor("#8a90a8"));
        LinearLayout tl = col();
        tl.addView(chatTitleView, ff());
        tl.addView(chatSubView, ff());
        header.addView(tl, f1());
        header.addView(chip("💬", this::showChatInfo));
        header.addView(chip("👁", this::toggleSearchMessages));
        l.addView(header, ff());

        msgList = new ListView(this);
        msgList.setDivider(null);
        msgList.setBackgroundColor(Color.parseColor("#0f1117"));
        l.addView(msgList, f1());

        LinearLayout composer = row();
        composer.setPadding(8, 8, 8, 8);
        composer.setBackgroundColor(Color.parseColor("#141726"));
        composer.addView(chip("😀", () -> showEmojiPicker()));
        composer.addView(chip("👻", this::toggleGhostMode));
        composer.addView(chip("📎", this::attach));
        msgInput = input("", "Сообщение…");
        msgInput.setSingleLine(false);
        msgInput.setMinLines(1);
        msgInput.setMaxLines(4);
        composer.addView(msgInput, f1());
        composer.addView(btn("➤", this::sendTyped));
        l.addView(composer, ff());

        setScreen(l);

        try {
            JSONObject c = chats.get(chatId);
            if (c != null) {
                chatTitleView.setText(chatTitle(c));
                c.put("unread", 0);
            }
        } catch (JSONException ignored) {}
        if (chatList != null) renderChatList();
        renderOpenChat();
    }

    void renderOpenChat() {
        if (chatTitleView == null || currentChatId == null) return;
        JSONObject c = chats.get(currentChatId);
        if (c != null) chatTitleView.setText(chatTitle(c));
        renderChatHeader();
        if (msgList != null) {
            msgAdapter = new MsgAdapter();
            msgList.setAdapter(msgAdapter);
            if (!messages.isEmpty()) msgList.setSelection(messages.size() - 1);
        }
    }

    void renderChatHeader() {
        if (chatSubView == null || currentChatId == null) return;
        int t = typing.getOrDefault(currentChatId, 0);
        if (t > 0) { chatSubView.setText("печатает…"); return; }
        JSONObject c = chats.get(currentChatId);
        if (c == null) { chatSubView.setText(""); return; }
        if (c.optString("type").equals("dm")) {
            JSONObject other = dmOther(c);
            if (other != null) chatSubView.setText(other.optBoolean("online") ? "в сети" : "нет в сети");
            else chatSubView.setText("");
        } else {
            chatSubView.setText("участников: " + len(c.optJSONArray("members")));
        }
    }

    void closeChatView() {
        currentChatId = null;
        msgAdapter = null;
        showChatsScreen();
    }

    void sendTyped() {
        if (msgInput == null) return;
        String text = msgInput.getText().toString().trim();
        if (text.isEmpty()) return;
        msgInput.setText("");
        sendTextMessage(text, ghostMode);
    }

    void sendTextMessage(String text, boolean ghost) {
        sendGenericMessage("text", text, null, ghost);
    }

    void sendMediaMessage(String kind, JSONObject payload) {
        sendGenericMessage(kind, null, payload, false);
    }

    void sendGenericMessage(String kind, String text, JSONObject payloadObj, boolean asGhost) {
        if (currentChatId == null) return;
        final String chatId = currentChatId;
        String msgKind = asGhost ? "text" : kind;
        JSONObject meta = new JSONObject();
        try {
            if (asGhost) {
                meta.put("ghost", true);
                meta.put("ghost_timer", ghostTimer);
                meta.put("ghost_views", ghostViews);
            }
            if (replyTo != null) meta.put("reply", replyTo);
        } catch (JSONException ignored) {}

        JSONObject extra = new JSONObject();
        try {
            extra.put("t", "msg_send");
            extra.put("chatId", chatId);
            extra.put("kind", msgKind);
            extra.put("clientId", "m" + System.currentTimeMillis() + String.valueOf(Math.random()).substring(2, 8));
            extra.put("meta", meta);
        } catch (JSONException ignored) {}

        JSONObject chat = chats.get(chatId);
        String plainValue = text != null ? text : (payloadObj != null ? payloadObj.toString() : "");
        boolean isDm = chat != null && chat.optString("type").equals("dm");
        boolean done = false;
        if (isDm && crypto.hasIdentity()) {
            JSONObject peer = dmOther(chat);
            if (peer != null && !peer.optString("pubkey").isEmpty()) {
                try {
                    JSONObject cipher = crypto.encryptFor(peer.optString("pubkey"), plainValue);
                    extra.put("cipher", cipher);
                    done = true;
                } catch (Exception e) { /* падаем в открытый текст */ }
            }
        }
        if (!done) {
            try { extra.put("payload", plainValue); } catch (JSONException ignored) {}
        }
        send(extra);
        replyTo = null;

        JSONObject local = new JSONObject();
        try {
            local.put("id", extra.optString("clientId"));
            local.put("chatId", chatId);
            local.put("sender", meUid);
            local.put("kind", kind);
            local.put("ts", System.currentTimeMillis());
            if (asGhost) {
                JSONObject gm = new JSONObject();
                gm.put("ghost", true);
                gm.put("ghost_timer", ghostTimer);
                gm.put("ghost_views", ghostViews);
                local.put("meta", gm);
            }
            if (payloadObj != null) local.put("payload", payloadObj);
            else local.put("payload", text);
        } catch (JSONException ignored) {}
        messages.add(local);
        messages.sort(BY_TS);
        if (msgAdapter != null) msgAdapter.notifyDataSetChanged();
        if (msgList != null) msgList.setSelection(messages.size() - 1);
        if (chat != null) {
            try {
                chat.put("last", local);
                chat.put("lastTs", local.optLong("ts"));
            } catch (JSONException ignored) {}
        }
        renderChatList();
    }

    void sendTyping(boolean on) {
        if (currentChatId == null) return;
        JSONObject o = o("typing");
        try {
            o.put("chatId", currentChatId);
            o.put("typing", on);
        } catch (JSONException ignored) {}
        send(o);
    }

    // ===================== меню сообщения =====================
    void msgMenu(JSONObject m) {
        final JSONObject msg = m;
        List<String> opts = new ArrayList<>();
        opts.add("💬 Ответить");
        opts.add("👌 Копировать");
        opts.add("😊 Реакции");
        boolean own = meUid != null && meUid.equals(m.optString("sender"));
        if (own) { opts.add("✏️ Редактировать"); opts.add("🗑 Удалить"); }
        showChoice("Сообщение", opts, idx -> {
            switch (idx) {
                case 0: replyTo = msg; toast("Ответ: " + shortText(firstLineOf(msg))); break;
                case 1: {
                    ((ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE))
                        .setPrimaryClip(ClipData.newPlainText("msg", firstLineOf(msg)));
                    toast("Скопировано");
                    break;
                }
                case 2: showReactionPicker(msg); break;
                case 3:
                    if (own) editMessage(msg);
                    break;
                case 4:
                    if (own) deleteMessage(msg);
                    break;
            }
        });
    }

    void editMessage(JSONObject m) {
        final JSONObject msg = m;
        inputDialog("Редактировать", shortText(firstLineOf(msg)), false, newText -> {
            JSONObject o = o("msg_edit");
            JSONObject chat = chats.get(currentChatId);
            boolean isDm = chat != null && chat.optString("type").equals("dm");
            try {
                o.put("chatId", currentChatId);
                o.put("id", msg.optString("id"));
                if (isDm && crypto.hasIdentity()) {
                    JSONObject peer = dmOther(chat);
                    if (peer != null && !peer.optString("pubkey").isEmpty()) {
                        JSONObject cipher = crypto.encryptFor(peer.optString("pubkey"), newText);
                        o.put("cipher", cipher);
                        send(o);
                        return;
                    }
                }
                o.put("payload", newText);
            } catch (Exception ignored) {}
            send(o);
        });
    }

    void deleteMessage(JSONObject m) {
        JSONObject o = o("msg_delete");
        try {
            o.put("chatId", currentChatId);
            o.put("id", m.optString("id"));
        } catch (JSONException ignored) {}
        send(o);
    }

    void showReactionPicker(JSONObject m) {
        showChoice("Реакция", new ArrayList<>(EMOJI.subList(0, 24)), idx -> toggleReaction(m, EMOJI.get(idx)));
    }

    void toggleReaction(JSONObject m, String emoji) {
        JSONArray reactions = m.optJSONArray("reactions");
        if (reactions == null) reactions = new JSONArray();
        JSONArray na = new JSONArray();
        boolean added = false;
        for (int i = 0; i < reactions.length(); i++) {
            JSONObject r = reactions.optJSONObject(i);
            if (r == null) continue;
            JSONArray uids = r.optJSONArray("uids");
            JSONArray nu = new JSONArray();
            boolean rAddedHere = false;
            for (int j = 0; j < len(uids); j++) {
                String uid = uids.optString(j);
                if (uid.equals(meUid)) continue;
                nu.put(uid);
            }
            try {
                if (r.optString("e").equals(emoji) && !added && !contains(nu, meUid)) {
                    nu.put(meUid);
                    added = true;
                    rAddedHere = true;
                }
                r.put("uids", nu);
            } catch (JSONException ignored) {}
            if (nu.length() > 0 || true) na.put(r);
        }
        if (!added) {
            try {
                JSONObject nr = new JSONObject();
                nr.put("e", emoji);
                JSONArray u = new JSONArray();
                u.put(meUid);
                nr.put("uids", u);
                na.put(nr);
            } catch (JSONException ignored) {}
        }
        JSONObject cmd = o("msg_edit");
        try {
            cmd.put("chatId", currentChatId);
            cmd.put("id", m.optString("id"));
            JSONObject meta = new JSONObject();
            meta.put("reactions", na);
            cmd.put("meta", meta);
        } catch (JSONException ignored) {}
        send(cmd);
    }

    static boolean contains(JSONArray a, String v) {
        for (int i = 0; i < len(a); i++) if (a.optString(i).equals(v)) return true;
        return false;
    }

    // ===================== выпадашки =====================
    void showChoice(String title, List<String> opts, ChoiceCb cb) {
        LinearLayout l = col();
        l.setPadding(24, 20, 24, 20);
        l.setBackgroundColor(Color.parseColor("#1b1e2a"));
        l.addView(txt(title, 20, Color.WHITE), ff());
        l.addView(sp(8));
        for (int i = 0; i < opts.size(); i++) {
            final int idx = i;
            TextView t = new TextView(this);
            t.setText(opts.get(i));
            t.setTextSize(18);
            t.setTextColor(Color.WHITE);
            t.setPadding(0, 12, 0, 12);
            t.setOnClickListener(v -> {
                hideOverlay();
                cb.run(idx);
            });
            l.addView(t, ff());
        }
        l.addView(sp(4));
        l.addView(btn("Отмена", this::hideOverlay), ff());
        showOverlay(l);
    }

    String shortText(String s) {
        if (s == null) return "";
        return s.length() > 60 ? s.substring(0, 60) + "…" : s;
    }

    String firstLineOf(JSONObject m) {
        JSONObject p = m.optJSONObject("payload");
        if (m.has("cipher")) {
            String d = decrypted.get(m.optString("id"));
            if (d != null) return d;
            return "🔒 зашифровано";
        }
        if (p != null) {
            if (p.has("text")) return p.optString("text");
            if (p.has("name")) return p.optString("name");
            if (p.has("e")) return p.optString("e");
            return p.optString("url", "");
        }
        return m.optString("payload", "");
    }

    final Map<String, String> decrypted = new HashMap<>();

    // ===================== эмодзи и ghost =====================
    void showEmojiPicker() {
        LinearLayout grid = col();
        grid.setPadding(20, 16, 20, 16);
        grid.setBackgroundColor(Color.parseColor("#1b1e2a"));
        grid.addView(txt("Эмодзи", 16, Color.parseColor("#8a90a8")), ff());
        final List<String> rowList = new ArrayList<>(EMOJI);
        int columns = 8;
        for (int i = 0; i < rowList.size(); i += columns) {
            LinearLayout rowL = row();
            for (int j = i; j < Math.min(i + columns, rowList.size()); j++) {
                final String e = rowList.get(j);
                TextView t = new TextView(this);
                t.setText(e);
                t.setTextSize(24);
                t.setGravity(Gravity.CENTER);
                t.setPadding(2, 6, 2, 6);
                t.setOnClickListener(v -> {
                    hideOverlay();
                    if (msgInput != null) {
                        msgInput.setText(msgInput.getText() + e);
                        msgInput.setSelection(msgInput.getText().length());
                    }
                });
                rowL.addView(t, f1());
            }
            grid.addView(rowL, ff());
        }
        grid.addView(sp(4));
        grid.addView(btn("Отмена", this::hideOverlay), ff());
        showOverlay(grid);
    }

    void toggleGhostMode() {
        showChoice("Призрак 👻", new ArrayList<>(java.util.Arrays.asList(
                "Простой текст", "👻 5 мин · 3 просмотра", "👻 10 мин · 5 просмотров", "👻 30 мин · 5 просмотров")),
            idx -> {
                if (idx == 0) { ghostMode = false; toast("Призрак выключен"); return; }
                ghostMode = true;
                if (idx == 1) { ghostTimer = 300000; ghostViews = 3; }
                if (idx == 2) { ghostTimer = 600000; ghostViews = 5; }
                if (idx == 3) { ghostTimer = 1800000; ghostViews = 5; }
                toast("👻 Призрак: " + (ghostTimer / 60000) + " мин · " + ghostViews + " просмотров");
            });
    }

    // ===================== вложения =====================
    static final int REQ_PICK = 1001;
    String pendingMediaKind = "image";

    void attach() {
        showChoice("Вложение", new ArrayList<>(java.util.Arrays.asList("🖼 Фото", "📄 Файл")), idx -> {
            pendingMediaKind = idx == 0 ? "image" : "file";
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.setType("*/*");
            if (idx == 0) i.setType("image/*");
            startActivityForResult(i, REQ_PICK);
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK || resultCode != Activity.RESULT_OK || data == null || data.getData() == null) return;
        final Uri uri = data.getData();
        new Thread(() -> {
            try {
                String name = queryName(uri);
                InputStream in = getContentResolver().openInputStream(uri);
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                in.close();
                byte[] dataBytes = bos.toByteArray();
                String url = upload(dataBytes, name);
                JSONObject payload = new JSONObject();
                payload.put("url", url);
                payload.put("name", name == null ? "file" : name);
                payload.put("size", dataBytes.length);
                final String kind = pendingMediaKind;
                ui.post(() -> sendMediaMessage(kind, payload));
            } catch (Exception e) {
                ui.post(() -> toast("Ошибка загрузки: " + e.getMessage()));
            }
        }).start();
    }

    String queryName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (i >= 0) return c.getString(i);
            }
        } catch (Exception ignored) {}
        return null;
    }

    String upload(byte[] data, String name) throws Exception {
        String hostHttp = serverHost.replace("ws://", "http://").replace("wss://", "https://");
        if (hostHttp.endsWith("/")) hostHttp = hostHttp.substring(0, hostHttp.length() - 1);
        URL url = new URL(hostHttp + "/api/upload");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/octet-stream");
        if (token != null) conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setConnectTimeout(15000);
        conn.connect();
        conn.getOutputStream().write(data);
        InputStream ris = conn.getInputStream();
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = ris.read(b)) > 0) bos.write(b, 0, n);
        ris.close();
        JSONObject j = new JSONObject(bos.toString("UTF-8"));
        return j.getString("url");
    }

    // ===================== инфо о чате =====================
    void showChatInfo() {
        if (currentChatId == null) return;
        final JSONObject c = chats.get(currentChatId);
        if (c == null) return;
        List<String> opts = new ArrayList<>();
        opts.add("👤 Добавить участника");
        opts.add("🚪 Покинуть чат");
        if (c.optString("type").equals("channel")) opts.add("📢 О канале");
        if (c.optString("type").equals("dm")) opts.add("🪪 Открыть профиль");
        showChoice("Чат", opts, idx -> {
            if (idx == 0) addMember();
            if (idx == 1) leaveChat(c);
            if (idx == 3) openDMProfile(c);
        });
    }

    void addMember() {
        inputDialog("Ник пользователя", "", false, nick -> {
            JSONObject s = o("search");
            try { s.put("q", nick); } catch (JSONException ignored) {}
            send(s);
        });
    }

    void leaveChat(JSONObject c) {
        JSONObject o = o("chat_leave");
        try { o.put("chatId", c.optString("id")); } catch (JSONException ignored) {}
        send(o);
        chats.remove(c.optString("id"));
        if (c.optString("id").equals(currentChatId)) closeChatView();
        else renderChatList();
    }

    void openDMProfile(JSONObject c) {
        final JSONObject u = dmOther(c);
        if (u == null) { toast("Нет профиля"); return; }
        LinearLayout l = col();
        l.setPadding(24, 30, 24, 24);
        l.setBackgroundColor(Color.parseColor("#1b1e2a"));
        l.addView(txt("@" + u.optString("username"), 24, Color.WHITE), ff());
        l.addView(txt(u.optString("nickname", ""), 16, Color.parseColor("#8a90a8")), ff());
        l.addView(sp(12));
        if (u.optString("bio", "").isEmpty() == false) l.addView(txt(u.optString("bio"), 14, Color.parseColor("#c0c4d0")), ff());
        if (u.optString("pubkey", "").isEmpty() == false) l.addView(txt("🔑 E2E активен", 13, Color.parseColor("#7ae582")), ff());
        l.addView(sp(16));
        l.addView(btn("Закрыть", this::hideOverlay), ff());
        showOverlay(l);
    }

    void toggleSearchMessages() {
        inputDialog("Поиск по сообщениям", "", false, q -> {
            JSONObject o = o("msg_search");
            try {
                o.put("chatId", currentChatId);
                o.put("q", q);
            } catch (JSONException ignored) {}
            send(o);
        });
    }

    // ===================== поиск и новый чат =====================
    void showSearchScreen() {
        LinearLayout l = col();
        l.setPadding(20, 40, 20, 20);
        l.addView(txt("Поиск людей", 22, Color.WHITE), ff());
        l.addView(sp(12));
        final EditText q = input("", "@ник / @юзернейм");
        l.addView(q, ff());
        l.addView(sp(8));
        l.addView(btn("Найти", () -> {
            JSONObject o = o("search");
            try { o.put("q", q.getText().toString().trim()); } catch (JSONException ignored) {}
            send(o);
        }), ff());
        l.addView(sp(8));
        l.addView(btn("← Назад", this::showChatsScreen), ff());
        setScreen(l);
    }

    void showNewChatScreen() {
        showChoice("Новый чат", new ArrayList<>(java.util.Arrays.asList("💬 Личный", "👥 Группа", "📢 Канал")), idx -> {
            if (idx == 0) createDM();
            if (idx == 1) createGroupChannel(false);
            if (idx == 2) createGroupChannel(true);
        });
    }

    void createDM() {
        inputDialog("Ник пользователя", "", false, nick -> {
            JSONObject o = o("dm_create");
            try { o.put("username", nick.toLowerCase().replaceAll("^@", "").trim()); } catch (JSONException ignored) {}
            send(o);
        });
    }

    void createGroupChannel(final boolean channel) {
        inputDialog(channel ? "Название канала" : "Название группы", "", false, title -> {
            final String t1 = title;
            inputDialog("О группе (опиши)", "", false, about -> {
                JSONObject o = o(channel ? "channel_create" : "group_create");
                try {
                    o.put("title", t1);
                    o.put("about", about);
                } catch (JSONException ignored) {}
                send(o);
            });
        });
    }

    // ===================== настройки =====================
    void showSettingsScreen() {
        LinearLayout l = col();
        l.setPadding(20, 40, 20, 20);
        l.addView(txt("Настройки", 24, Color.WHITE), ff());
        if (me != null) {
            l.addView(sp(8));
            l.addView(txt("@" + me.optString("username") + " — " + me.optString("nickname"), 16, Color.parseColor("#8a90a8")), ff());
            l.addView(txt("👑 ID: " + meUid, 13, Color.parseColor("#5a6070")), ff());
            if (crypto.hasIdentity()) l.addView(txt("🔑 E2E активен", 13, Color.parseColor("#7ae582")), ff());
        }
        l.addView(sp(12));
        l.addView(btn("✏️ Изменить ник", () -> inputDialog("Ник", me == null ? "" : me.optString("nickname"), false, nick -> {
            JSONObject o = o("profile_update");
            try { o.put("nickname", nick); } catch (JSONException ignored) {}
            send(o);
        })), ff());
        l.addView(sp(8));
        l.addView(btn("👻 Настройки призрака", this::toggleGhostMode), ff());
        l.addView(sp(8));
        l.addView(btn("💾 Экспорт бэкапа", () -> {
            try {
                if (!crypto.hasIdentity()) { toast("Сначала войди по ключу"); return; }
                inputDialog("Пароль для бэкапа", "", false, pass -> {
                    try {
                        JSONObject b = crypto.exportBackup(pass);
                        b.put("token", token);
                        b.put("host", serverHost);
                        b.put("uid", meUid);
                        showOverlay(showBackup(b.toString()));
                    } catch (Exception ex) { toast("Ошибка экспорта"); }
                });
            } catch (Exception e) { toast("Нет ключей"); }
        }), ff());
        l.addView(sp(8));
        l.addView(btn("🔀 Сменить аккаунт", () -> {
            JSONObject o = o("logout");
            try { o.put("all", false); } catch (JSONException ignored) {}
            send(o);
            token = null;
            if (ws != null) ws.close(1000, "bye");
            showConnectScreen();
        }), ff());
        l.addView(sp(8));
        l.addView(btn("← Назад", this::showChatsScreen), ff());
        setScreen(l);
    }

    View showBackup(String backupJson) {
        TextView t = new TextView(this);
        t.setText(backupJson);
        t.setTextSize(11);
        t.setTextColor(Color.WHITE);
        t.setTextIsSelectable(true);
        t.setPadding(12, 12, 12, 12);
        t.setBackgroundColor(Color.parseColor("#262a38"));
        ScrollView sc = new ScrollView(this);
        sc.addView(t);
        LinearLayout l = col();
        l.setPadding(20, 20, 20, 20);
        l.setBackgroundColor(Color.parseColor("#1b1e2a"));
        l.addView(txt("Бэкап (сохранить себе)", 16, Color.WHITE), ff());
        l.addView(sp(8));
        l.addView(sc, f1());
        l.addView(sp(8));
        l.addView(btn("Скопировать", () -> {
            ((ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE))
                .setPrimaryClip(ClipData.newPlainText("backup", backupJson));
            toast("Скопировано");
        }), ff());
        l.addView(sp(4));
        l.addView(btn("Закрыть", this::hideOverlay), ff());
        return l;
    }

    // ===================== кошелёк =====================
    LinearLayout walletScreen;

    void showWalletScreen() {
        JSONObject o = o("wallet_get");
        send(o);
        o = o("gifts_catalog");
        send(o);
        o = o("nft_list");
        send(o);
        LinearLayout sc2 = col();
        sc2.setPadding(20, 30, 20, 20);
        setScreen(sc2);
        walletScreen = sc2;
        renderWallet();
    }

    void updateWalletChip() {
        if (walletChip != null) ui.post(() -> walletChip.setText("⭐ " + balance));
    }

    void renderWallet() {
        if (walletScreen == null) return;
        walletScreen.removeAllViews();
        walletScreen.addView(txt("Кошелёк ⭐ " + balance, 24, Color.WHITE), ff());
        walletScreen.addView(sp(6));
        walletScreen.addView(btn("← Назад", () -> { walletScreen = null; showChatsScreen(); }), ff());
        walletScreen.addView(sp(12));

        walletScreen.addView(txt("Подарки ✨", 18, Color.parseColor("#8a90a8")), ff());
        walletScreen.addView(sp(4));
        LinearLayout giftRow = row();
        for (Map.Entry<String, JSONObject> e : catalog.entrySet()) {
            final JSONObject g = e.getValue();
            TextView t = new TextView(this);
            t.setText(g.optString("e", "🎁"));
            t.setTextSize(30);
            t.setGravity(Gravity.CENTER);
            t.setPadding(2, 8, 2, 8);
            t.setBackgroundColor(Color.parseColor("#1b1e2a"));
            t.setOnClickListener(v -> buyGift(g));
            giftRow.addView(t, ff());
        }
        if (catalog.isEmpty()) winfo("загружаю каталог…");
        walletScreen.addView(giftRow, ff());
        walletScreen.addView(sp(12));

        walletScreen.addView(txt("Мои подарки", 18, Color.parseColor("#8a90a8")), ff());
        walletScreen.addView(sp(4));
        if (walletGifts.isEmpty()) winfo("пока пусто — покупай или получай подарки");
        for (JSONObject g : walletGifts) {
            drawGiftRow(g);
        }
        walletScreen.addView(sp(12));

        walletScreen.addView(txt("NFT-аукционы 💎", 18, Color.parseColor("#8a90a8")), ff());
        walletScreen.addView(sp(4));
        boolean anyNft = false;
        for (Map.Entry<String, JSONObject> e : nftCache.entrySet()) {
            drawNftRow(e.getValue());
            anyNft = true;
        }
        if (!anyNft) winfo("аукционов нет");
    }

    void winfo(String s) {
        walletScreen.addView(txt("· " + s, 14, Color.parseColor("#5a6070")), ff());
    }

    void buyGift(JSONObject g) {
        JSONObject o = o("gift_buy");
        try { o.put("giftId", g.optString("id")); } catch (JSONException ignored) {}
        send(o);
    }

    void drawGiftRow(final JSONObject g) {
        LinearLayout r = row();
        r.addView(txt(g.optString("e", "🎁") + " " + g.optString("name", ""), 16, Color.WHITE), ff());
        LinearLayout btns = row();
        TextView wd = mw("💸");
        wd.setOnClickListener(v -> {
            JSONObject o = o("gift_withdraw");
            try { o.put("copy", g.optString("copy", g.optString("token"))); } catch (JSONException ignored) {}
            send(o);
        });
        btns.addView(wd);
        if (g.optBoolean("unique") == false) {
            TextView up = mw("💎");
            up.setOnClickListener(v -> {
                JSONObject o = o("gift_upgrade");
                try { o.put("copy", g.optString("copy", g.optString("token"))); } catch (JSONException ignored) {}
                send(o);
            });
            btns.addView(up);
        }
        r.addView(btns, ff());
        walletScreen.addView(r, ff());
    }

    void drawNftRow(final JSONObject c) {
        LinearLayout r = col();
        r.setPadding(8, 8, 8, 8);
        r.setBackgroundColor(Color.parseColor("#161a26"));
        TextView head = txt("@" + c.optString("slug") + " — " + c.optString("price") + " ⭐", 15, Color.WHITE);
        r.addView(head, ff());
        if (c.optString("owner", "").equals(meUid) && !c.optString("status", "").equals("sold")) {
            TextView cancel = mw2("Снять с аукциона", "↩️");
            cancel.setOnClickListener(v -> {
                JSONObject o = o("nft_cancel");
                try { o.put("slug", c.optString("slug")); } catch (JSONException ignored) {}
                send(o);
            });
            r.addView(cancel);
            TextView claim = mw2("Забрать ник", "👑");
            claim.setOnClickListener(v -> {
                JSONObject o = o("nft_claim");
                try { o.put("slug", c.optString("slug")); } catch (JSONException ignored) {}
                send(o);
            });
            r.addView(claim);
        } else {
            TextView bid = mw2("Ставка", "🔨");
            bid.setOnClickListener(v -> {
                inputDialog("Твоя ставка ⭐ (мин " + c.optString("price") + ")", "", true, amt -> {
                    JSONObject o = o("nft_bid");
                    try {
                        o.put("slug", c.optString("slug"));
                        o.put("amount", Integer.parseInt(amt.trim()));
                    } catch (Exception ignored) {}
                    send(o);
                });
            });
            r.addView(bid);
            TextView bn = mw2("Купить сразу", "⚡");
            bn.setOnClickListener(v -> {
                JSONObject o = o("nft_buy_now");
                try { o.put("slug", c.optString("slug")); } catch (JSONException ignored) {}
                send(o);
            });
            r.addView(bn);
        }
        walletScreen.addView(r, ff());
        walletScreen.addView(sp(6));
    }

    TextView mw(String label) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextColor(Color.WHITE);
        t.setTextSize(18);
        t.setGravity(Gravity.CENTER);
        t.setPadding(6, 4, 6, 4);
        t.setBackgroundColor(Color.parseColor("#2b356b"));
        return t;
    }

    TextView mw2(String label, final String icon) {
        TextView t = new TextView(this);
        t.setText(icon + " " + label);
        t.setTextColor(Color.WHITE);
        t.setTextSize(14);
        t.setGravity(Gravity.CENTER);
        t.setPadding(8, 6, 8, 6);
        t.setBackgroundColor(Color.parseColor("#2b356b"));
        return t;
    }

    // ===================== адаптер списка чатов =====================
    class ChatListAdapter extends BaseAdapter {
        public int getCount() { return chats.size(); }
        public Object getItem(int i) { return new ArrayList<>(chats.values()).get(i); }
        public long getItemId(int i) { return i; }
        public View getView(int i, View c, ViewGroup p) {
            List<JSONObject> items = new ArrayList<>(chats.values());
            items.sort((a, b) -> Long.compare(b.optLong("lastTs"), a.optLong("lastTs")));
            if (i >= items.size()) return new View(MainActivity.this);
            JSONObject ch = items.get(i);
            String title = chatTitle(ch);
            int unread = ch.optInt("unread");
            String un = unread > 0 ? "  (" + unread + ")" : "";
            TextView t = new TextView(MainActivity.this);
            t.setText((ch.optString("type").equals("channel") ? "📢 " : ch.optString("type").equals("group") ? "👥 " : "💬 ") + title + un);
            t.setTextSize(18);
            t.setPadding(20, 18, 20, 18);
            t.setTextColor(unread > 0 ? Color.parseColor("#ffd54f") : Color.WHITE);
            t.setOnClickListener(v -> openChat(ch.optString("id")));
            return t;
        }
    }

    // ===================== адаптер сообщений =====================
    class MsgAdapter extends BaseAdapter {
        public int getCount() { return messages.size(); }
        public Object getItem(int i) { return messages.get(i); }
        public long getItemId(int i) { return i; }
        public View getView(int i, View c, ViewGroup p) {
            JSONObject m = messages.get(i);
            if (m.optString("kind", "text").equals("system")) {
                TextView s = new TextView(MainActivity.this);
                s.setText("📌 " + m.optString("payload", ""));
                s.setTextSize(12);
                s.setTextColor(Color.parseColor("#8a90a8"));
                s.setGravity(Gravity.CENTER);
                s.setPadding(12, 14, 12, 14);
                return s;
            }
            boolean mine = m.optString("sender", "").equals(meUid);
            LinearLayout item = col();
            item.setPadding(10, 4, 10, 4);

            String text = pretty(m);
            if (mine) {
                TextView t = txt(text, 16, Color.WHITE);
                t.setBackgroundColor(0xFF2B356B);
                t.setPadding(14, 12, 14, 12);
                t.setMaxWidth((int) (getResources().getDisplayMetrics().density * 280));
                item.addView(t, ff());
                TextView time = txt(fmtTime(m.optLong("ts")) + checkMark(m), 11, Color.parseColor("#5a6070"));
                time.setGravity(Gravity.END);
                item.addView(time, ff());
            } else {
                JSONObject sender = myUsers.get(m.optString("sender"));
                String name = sender != null ? sender.optString("nickname", sender.optString("username", "?")) : "?";
                TextView nm = txt(name, 12, Color.parseColor("#7ae582"));
                nm.setPadding(0, 2, 0, 2);
                item.addView(nm, ff());
                LinearLayout wrap = row();
                wrap.setGravity(Gravity.START);
                TextView t = txt(text, 16, Color.WHITE);
                t.setBackgroundColor(0xFF262A38);
                t.setPadding(14, 12, 14, 12);
                t.setMaxWidth((int) (getResources().getDisplayMetrics().density * 280));
                wrap.addView(t);
                item.addView(wrap, ff());
                TextView time = txt(fmtTime(m.optLong("ts")), 11, Color.parseColor("#5a6070"));
                item.addView(time, ff());
            }

            JSONObject meta = m.optJSONObject("meta");
            if (meta != null && len(meta.optJSONArray("reactions")) > 0) {
                StringBuilder rb = new StringBuilder();
                JSONArray rs = meta.optJSONArray("reactions");
                for (int j = 0; j < rs.length(); j++) {
                    JSONObject r = rs.optJSONObject(j);
                    if (r != null) rb.append(r.optString("e")).append("×").append(len(r.optJSONArray("uids"))).append(" ");
                }
                TextView rt = txt(rb.toString(), 14, Color.parseColor("#ffd54f"));
                item.addView(rt, ff());
            }

            TextView tap = new TextView(MainActivity.this);
            tap.setText(""); // жёсткая область клика
            tap.setPadding(0, 0, 0, 0);
            item.setClickable(true);
            item.setOnClickListener(v -> msgMenu(m));
            return item;
        }
    }

    String checkMark(JSONObject m) {
        JSONArray sb = m.optJSONArray("seenBy");
        boolean seen = sb != null && sb.length() > 1;
        return seen ? " ✓✓" : " ✓";
    }

    String pretty(JSONObject m) {
        String kind = m.optString("kind", "text");
        JSONObject meta = m.optJSONObject("meta");
        String prefix = "";
        if (meta != null && meta.has("reply")) {
            prefix = "⤴ " + meta.optJSONObject("reply").optString("name", "") + ": " +
                    shortText(meta.optJSONObject("reply").optString("text", "")) + "\n";
        }
        switch (kind) {
            case "image": return prefix + "🖼 Изображение";
            case "file": return prefix + "📄 " + firstLineOf(m);
            case "voice": return prefix + "🎤 Голосовое: " + m.optJSONObject("payload").optString("duration", "0") + "с";
            case "gif": return prefix + m.optJSONObject("payload").optString("e", "🎬");
            case "sticker": return prefix + "🙂 Стикер";
            case "card": return prefix + "🪪 Визитка: @" + m.optJSONObject("payload").optString("username", "");
            default:
                String text = firstLineOf(m);
                if (meta != null && meta.optBoolean("ghost")) {
                    boolean seenMe = m.optString("sender", "").equals(meUid) || contains(m.optJSONArray("seenBy"), meUid);
                    if (!seenMe) return prefix + "👻 Призрачное сообщение";
                    return prefix + text;
                }
                return prefix + text + (m.optBoolean("edited", false) ? " (ред.)" : "");
        }
    }
}