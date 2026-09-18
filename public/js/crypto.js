const Crypto = (() => {
  let identity = null;

  async function generateIdentity() {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
    const pub = await exportPem(kp.publicKey);
    return { keyPair: kp, publicKeyPem: pub };
  }

  async function exportPem(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    return btoa(String.fromCharCode(...new Uint8Array(raw)));
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

  function b64(bytes) {
    let s = '';
    bytes.forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s);
  }

  function setIdentity(kp) { identity = kp; }
  function getPublic() { return identity ? identity.publicKeyPem : null; }
  function hasIdentity() { return !!identity; }

  return { generateIdentity, encryptFor, decryptFrom, setIdentity, getPublic, hasIdentity };
})();