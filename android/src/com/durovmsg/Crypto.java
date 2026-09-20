package com.durovmsg;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.spec.ECFieldFp;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Крипто-ядро, бинарно совместимое с веб-клиентом (crypto.js):
 *  ECDH P-256 + AES-GCM(12B IV). Публичный ключ — raw 64 байта (X||Y) в base64.
 *  Ключи храним в JWK (kty=EC, crv=P-256) — так мультиаккаунт переносится между устройствами.
 *  Бэкап: PBKDF2(SHA-256, 210000) → AES-GCM(16B salt, 12B iv) над {privateJwk, publicKeyPem}.
 */
public class Crypto {
    public static final String CURVE = "secp256r1"; // P-256

    public static class Identity {
        public ECPublicKey pub;
        public ECPrivateKey priv;
        public String publicKeyPem; // base64(raw X||Y), 64 байта
        public String publicJwk;    // JSON (x,y)
        public String privateJwk;   // JSON (x,y,d)
    }

    private static final SecureRandom RND = new SecureRandom();
    private static final ECParameterSpec PARAMS = loadStdParams();

    private static ECParameterSpec loadStdParams() {
        try {
            AlgorithmParameters ap = AlgorithmParameters.getInstance("EC");
            ap.init(new ECGenParameterSpec(CURVE));
            return ap.getParameterSpec(ECParameterSpec.class);
        } catch (Exception e) {
            throw new RuntimeException("unable to load P-256 params", e);
        }
    }

    private final Identity identity = new Identity();

    public synchronized Identity generateIdentity() throws Exception {
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("EC");
        kpg.initialize(new ECGenParameterSpec(CURVE), new SecureRandom());
        KeyPair kp = kpg.generateKeyPair();
        identity.pub = (ECPublicKey) kp.getPublic();
        identity.priv = (ECPrivateKey) kp.getPrivate();
        identity.publicKeyPem = pubRawB64(identity.pub);
        identity.publicJwk = pubToJwk(identity.pub);
        identity.privateJwk = privToJwk(identity.pub, identity.priv);
        return identity;
    }

    public Identity identity() { return identity; }
    public boolean hasIdentity() { return identity.priv != null; }
    public String getPublic() { return identity.publicKeyPem; }
    public String getPrivateJwk() { return identity.privateJwk; }
    public String getPublicJwk() { return identity.publicJwk; }

    public void setIdentity(String publicJwkJson, String privateJwkJson) throws Exception {
        JSONObject pub = new JSONObject(publicJwkJson);
        JSONObject priv = new JSONObject(privateJwkJson);
        ECPoint w = jwkToPoint(pub);
        BigInteger d = b64u(priv.optString("d"));
        KeyFactory kf = KeyFactory.getInstance("EC");
        identity.pub = (ECPublicKey) kf.generatePublic(new ECPublicKeySpec(w, PARAMS));
        identity.priv = (ECPrivateKey) kf.generatePrivate(new ECPrivateKeySpec(d, PARAMS));
        identity.publicJwk = publicJwkJson;
        identity.privateJwk = privateJwkJson;
        identity.publicKeyPem = pubRawB64(identity.pub);
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] c = new byte[a.length + b.length];
        System.arraycopy(a, 0, c, 0, a.length);
        System.arraycopy(b, 0, c, a.length, b.length);
        return c;
    }

    /** raw 64 байта: X||Y (без префикса 0x04), как у WebCrypto exportKey('raw') */
    public static byte[] pubRaw(ECPublicKey pub) {
        ECPoint w = pub.getW();
        byte[] x = toFixed(pub.getParams().getCurve().getField().getFieldSize() / 8, w.getAffineX());
        byte[] y = toFixed(pub.getParams().getCurve().getField().getFieldSize() / 8, w.getAffineY());
        return concat(x, y);
    }

    public static String pubRawB64(ECPublicKey pub) {
        return Base64.encodeToString(pubRaw(pub), Base64.NO_WRAP);
    }

    public ECPublicKey importPubRaw(byte[] raw64) throws Exception {
        byte[] x = new byte[32], y = new byte[32];
        System.arraycopy(raw64, 0, x, 0, 32);
        System.arraycopy(raw64, 32, y, 0, 32);
        ECPoint w = new ECPoint(new BigInteger(1, x), new BigInteger(1, y));
        KeyFactory kf = KeyFactory.getInstance("EC");
        return (ECPublicKey) kf.generatePublic(new ECPublicKeySpec(w, PARAMS));
    }

    public ECPublicKey importPubRawB64(String b64) throws Exception {
        return importPubRaw(Base64.decode(b64, Base64.NO_WRAP));
    }

    private SecretKey deriveSharedSecret(ECPublicKey peer) throws Exception {
        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init(identity.priv);
        ka.doPhase(peer, true);
        byte[] bits = ka.generateSecret();
        return new SecretKeySpec(bits, "AES");
    }

    public JSONObject encryptFor(String peerPublicB64, String plaintextJson) throws Exception {
        SecretKey key = deriveSharedSecret(importPubRawB64(peerPublicB64));
        byte[] iv = new byte[12];
        RND.nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
        byte[] ct = cipher.doFinal(plaintextJson.getBytes(StandardCharsets.UTF_8));
        JSONObject o = new JSONObject();
        o.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
        o.put("ct", Base64.encodeToString(ct, Base64.NO_WRAP));
        return o;
    }

    public String decryptFrom(String peerPublicB64, JSONObject cipher) throws Exception {
        SecretKey key = deriveSharedSecret(importPubRawB64(peerPublicB64));
        byte[] iv = Base64.decode(cipher.getString("iv"), Base64.NO_WRAP);
        byte[] ct = Base64.decode(cipher.getString("ct"), Base64.NO_WRAP);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        byte[] data = c.doFinal(ct);
        return new String(data, StandardCharsets.UTF_8);
    }

    // ---------------- JWK ----------------
    public static String pubToJwk(ECPublicKey pub) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("kty", "EC");
        o.put("crv", "P-256");
        o.put("x", b64u(pub.getW().getAffineX()));
        o.put("y", b64u(pub.getW().getAffineY()));
        return o.toString();
    }

    public static String privToJwk(ECPublicKey pub, ECPrivateKey priv) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("kty", "EC");
        o.put("crv", "P-256");
        ECPoint w = pub != null ? pub.getW() : null;
        if (w != null) {
            o.put("x", b64u(w.getAffineX()));
            o.put("y", b64u(w.getAffineY()));
        } else {
            o.put("x", "");
            o.put("y", "");
        }
        o.put("d", b64u(priv.getS()));
        return o.toString();
    }

    private static ECPoint jwkToPoint(JSONObject jwk) throws JSONException {
        BigInteger x = b64u(jwk.getString("x"));
        BigInteger y = b64u(jwk.getString("y"));
        return new ECPoint(x, y);
    }

    private static byte[] toFixed(int len, BigInteger v) {
        byte[] src = v.toByteArray();
        byte[] out = new byte[len];
        if (src.length > len) System.arraycopy(src, src.length - len, out, 0, len);
        else if (src.length < len) System.arraycopy(src, 0, out, len - src.length, src.length);
        else System.arraycopy(src, 0, out, 0, len);
        return out;
    }

    private static String b64u(BigInteger v) {
        byte[] b = toFixed(32, v);
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    private static BigInteger b64u(String s) {
        byte[] b = Base64.decode(s, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        return new BigInteger(1, b);
    }

    public static String b64(byte[] data) {
        return Base64.encodeToString(data, Base64.NO_WRAP);
    }

    // ---------------- бэкап (совместим с crypto.js exportBackup/importBackup) ----------------
    public JSONObject exportBackup(String passphrase) throws Exception {
        if (identity.priv == null) throw new Exception("no identity");
        byte[] salt = new byte[16];
        byte[] iv = new byte[12];
        RND.nextBytes(salt);
        RND.nextBytes(iv);
        SecretKey key = pbkdf2(passphrase, salt, 210000);
        JSONObject data = new JSONObject();
        data.put("privateJwk", new JSONObject(identity.privateJwk));
        data.put("publicKeyPem", identity.publicKeyPem);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
        byte[] ct = cipher.doFinal(data.toString().getBytes(StandardCharsets.UTF_8));
        JSONObject o = new JSONObject();
        o.put("v", 1);
        o.put("pub", identity.publicKeyPem);
        o.put("salt", Base64.encodeToString(salt, Base64.NO_WRAP));
        o.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
        o.put("data", Base64.encodeToString(ct, Base64.NO_WRAP));
        return o;
    }

    public String importBackup(JSONObject backup, String passphrase) throws Exception {
        if (backup == null || backup.optInt("v") != 1) throw new Exception("bad backup");
        byte[] salt = Base64.decode(backup.getString("salt"), Base64.NO_WRAP);
        byte[] iv = Base64.decode(backup.getString("iv"), Base64.NO_WRAP);
        byte[] ct = Base64.decode(backup.getString("data"), Base64.NO_WRAP);
        SecretKey key = pbkdf2(passphrase, salt, 210000);
        byte[] data;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            data = cipher.doFinal(ct);
        } catch (Exception e) {
            throw new Exception("bad password");
        }
        JSONObject plain = new JSONObject(new String(data, StandardCharsets.UTF_8));
        JSONObject privJwk = plain.getJSONObject("privateJwk");
        JSONObject pubJwk = new JSONObject();
        pubJwk.put("kty", "EC");
        pubJwk.put("crv", "P-256");
        pubJwk.put("x", privJwk.getString("x"));
        pubJwk.put("y", privJwk.getString("y"));
        setIdentity(pubJwk.toString(), privJwk.toString());
        return identity.publicKeyPem;
    }

    private static SecretKey pbkdf2(String passphrase, byte[] salt, int iterations) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(passphrase.toCharArray(), salt, iterations, 256);
        SecretKeyFactory f = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
        return new SecretKeySpec(f.generateSecret(spec).getEncoded(), "AES");
    }
}