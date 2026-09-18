const Crypto = (() => {
  const STORE = 'durov_priv';
  let identity = null;

  async function generateIdentity() {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
    const publicKeyPem = await exportPem(kp.publicKey);
    const publicJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    identity = { keyPair: kp, publicKeyPem, publicJwk, privateJwk };
    saveToStorage();
    return identity;
  }

  async function exportPem(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    return b64(new Uint8Array(raw));
  }

  async function importRaw(base64, type) {
    const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey(
      'raw',
      bin,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      type === 'public' ? [] : ['deriveKey']
    );
  }

  async function deriveSharedSecret(peerPublicB64) {
    const peerKey = await importRaw(peerPublicB64, 'public');
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerKey },
      identity.keyPair.privateKey,
      256
    );
    const raw = new Uint8Array(bits);
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function encryptFor(peerPublicB64, plaintext) {
    const key = await deriveSharedSecret(peerPublicB64);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(plaintext));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  }

  async function decryptFrom(peerPublicB64, cipher) {
    const key = await deriveSharedSecret(peerPublicB64);
    const iv = Uint8Array.from(atob(cipher.iv), (c) => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(cipher.ct), (c) => c.charCodeAt(0));
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(data));
  }

  // ---------------- storage (настоящий, не «{}») ----------------
  function saveToStorage() {
    if (!identity) return;
    try {
      localStorage.setItem(STORE, JSON.stringify({
        v: 2,
        publicKeyPem: identity.publicKeyPem,
        publicJwk: identity.publicJwk,
        privateJwk: identity.privateJwk,
      }));
    } catch {}
  }

  async function importKeyPair(publicJwk, privateJwk) {
    const privateKey = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    const publicKey = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    return { keyPair: { publicKey, privateKey }, publicKeyPem: await exportPem(publicKey) };
  }

  async function restoreFromStorage() {
    const raw = localStorage.getItem(STORE);
    if (!raw) return false;
    try {
      const o = JSON.parse(raw);
      if (o && o.v === 2 && o.privateJwk && o.publicJwk) {
        const rec = await importKeyPair(o.publicJwk, o.privateJwk);
        identity = { ...rec, publicJwk: o.publicJwk, privateJwk: o.privateJwk };
        return true;
      }
      // старый битый формат (CryptoKey не сериализуется) — чистим и заводим новый ключ
      localStorage.removeItem(STORE);
      return false;
    } catch {
      localStorage.removeItem(STORE);
      return false;
    }
  }

  function clearStored() {
    try { localStorage.removeItem(STORE); } catch {}
  }

  // ---------------- резервная копия ключа под паролем ----------------
  async function pbkdf2Key(passphrase, salt) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: 210000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function exportBackup(passphrase) {
    if (!identity) return null;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await pbkdf2Key(passphrase, salt);
    const data = new TextEncoder().encode(JSON.stringify({
      privateJwk: identity.privateJwk,
      publicKeyPem: identity.publicKeyPem,
    }));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return {
      v: 1,
      pub: identity.publicKeyPem,
      salt: b64(salt),
      iv: b64(iv),
      data: b64(new Uint8Array(ct)),
    };
  }

  async function importBackup(backup, passphrase) {
    if (!backup || backup.v !== 1 || !backup.data) throw new Error('bad backup');
    const salt = Uint8Array.from(atob(backup.salt), (c) => c.charCodeAt(0));
    const iv = Uint8Array.from(atob(backup.iv), (c) => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(backup.data), (c) => c.charCodeAt(0));
    const key = await pbkdf2Key(passphrase, salt);
    let plain;
    try {
      const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      plain = JSON.parse(new TextDecoder().decode(data));
    } catch {
      throw new Error('bad password');
    }
    const publicJwk = plain.publicKeyPem ? await pubJwkFromRaw(plain.publicKeyPem) : null;
    const privJwk = plain.privateJwk;
    if (!privJwk) throw new Error('bad backup');
    const rec = await importKeyPair(publicJwk, privJwk);
    identity = { ...rec, publicJwk, privateJwk: privJwk };
    saveToStorage();
    return identity.publicKeyPem;
  }

  async function pubJwkFromRaw(rawB64) {
    const raw = Uint8Array.from(atob(rawB64), (c) => c.charCodeAt(0));
    const pub = await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    return crypto.subtle.exportKey('jwk', pub);
  }

  function b64(bytes) {
    let s = '';
    bytes.forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s);
  }

  function setIdentity(kp) { identity = kp; }
  function getPublic() { return identity ? identity.publicKeyPem : null; }
  function hasIdentity() { return !!identity; }
  function getJwks() {
    return identity ? { publicKeyPem: identity.publicKeyPem, publicJwk: identity.publicJwk, privateJwk: identity.privateJwk } : null;
  }

  // загрузить чужой (другого аккаунта) ключ без генерации; durov_priv синхронизируется
  async function setFromJwk(publicKeyPem, publicJwk, privateJwk) {
    const rec = await importKeyPair(publicJwk, privateJwk);
    identity = { ...rec, publicJwk, privateJwk };
    saveToStorage();
    return identity.publicKeyPem;
  }

  return {
    generateIdentity, encryptFor, decryptFrom, setIdentity, getPublic, hasIdentity,
    saveToStorage, restoreFromStorage, clearStored, exportBackup, importBackup,
    getJwks, setFromJwk,
  };
})();