package com.durovmsg;

import android.util.Base64;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Чистый WebSocket-клиент (RFC6455) без сторонних библиотек.
 * Поддерживает text/binary/ping/pong/close и клиентский маскинг.
 */
public class WsClient implements Runnable {
    private static final String TAG = "WsClient";
    private final URI uri;
    private final String serverHost;
    private final int serverPort;
    private final Listener listener;
    private final SecureRandom rnd = new SecureRandom();
    private Socket socket;
    private OutputStream out;
    private Thread thread;
    private final AtomicBoolean closed = new AtomicBoolean(true);
    private volatile long maxPayload = 16L * 1024 * 1024;

    public interface Listener {
        void onOpen(WsClient ws);
        void onMessage(String text);
        void onClose(int code, String reason);
        void onError(Exception e);
    }

    public WsClient(String url, Listener listener) {
        this.uri = URI.create(url);
        this.serverHost = uri.getHost();
        this.serverPort = uri.getPort() > 0 ? uri.getPort()
                : (uri.getScheme().equalsIgnoreCase("wss") ? 443 : 80);
        this.listener = listener;
    }

    public synchronized void connect() {
        if (!closed.get()) return;
        closed.set(false);
        thread = new Thread(this, "ws-client");
        thread.setDaemon(true);
        thread.start();
    }

    public boolean isOpen() {
        return !closed.get() && socket != null && socket.isConnected() && !socket.isClosed();
    }

    public void close(int code, String reason) {
        if (closed.getAndSet(true)) return;
        try {
            if (socket != null && socket.isConnected() && !socket.isClosed()) {
                sendFrame(0x8, stringBytes(reason == null ? "" : reason));
            } else {
                try { if (socket != null) socket.close(); } catch (IOException ignored) {}
            }
        } catch (Exception ignored) {}
    }

    public void sendText(String text) {
        try {
            sendFrame(0x1, stringBytes(text));
        } catch (IOException e) {
            listener.onError(e);
            close(1001, "send error");
        }
    }

    private static byte[] stringBytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    private synchronized void sendFrame(int opcode, byte[] payload) throws IOException {
        if (closed.get()) return;
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte b0 = (byte) (0x80 | (opcode & 0x0f));
        bos.write(b0);
        long len = payload.length;
        byte maskBit = (byte) 0x80;
        if (len <= 125) {
            bos.write(maskBit | (byte) len);
        } else if (len <= 0xFFFF) {
            bos.write(maskBit | 126);
            bos.write((int) ((len >> 8) & 0xFF));
            bos.write((int) (len & 0xFF));
        } else {
            bos.write(maskBit | 127);
            for (int i = 7; i >= 0; i--) bos.write((int) ((len >> (i * 8)) & 0xFF));
        }
        byte[] mask = new byte[4];
        rnd.nextBytes(mask);
        bos.write(mask);
        for (int i = 0; i < payload.length; i++) {
            bos.write(payload[i] ^ mask[i & 3]);
        }
        bos.writeTo(out);
        out.flush();
    }

    @Override
    public void run() {
        try {
            socket = new Socket(serverHost, serverPort);
            socket.setTcpNoDelay(true);
            out = socket.getOutputStream();

            StringBuilder req = new StringBuilder();
            String key = Base64.encodeToString(rnd.generateSeed(16), Base64.NO_WRAP);
            req.append("GET ").append(uri.getPath().isEmpty() ? "/" : uri.getPath())
               .append(" HTTP/1.1\r\n");
            req.append("Host: ").append(serverHost).append(':').append(serverPort).append("\r\n");
            req.append("Upgrade: websocket\r\n");
            req.append("Connection: Upgrade\r\n");
            req.append("Sec-WebSocket-Key: ").append(key).append("\r\n");
            req.append("Sec-WebSocket-Version: 13\r\n");
            req.append("\r\n");
            out.write(stringBytes(req.toString()));
            out.flush();

            InputStream in = socket.getInputStream();
            readHttpResponse(in);

            listener.onOpen(this);

            ByteArrayOutputStream frag = new ByteArrayOutputStream();
            int fragOp = -1;
            while (!closed.get()) {
                int b1 = in.read();
                if (b1 < 0) break;
                int b2 = in.read();
                if (b2 < 0) break;
                int opcode = b1 & 0x0f;
                boolean fin = (b1 & 0x80) != 0;
                long len = b2 & 0x7f;
                if (len == 126) {
                    len = ((long) in.read() & 0xff) << 8 | (in.read() & 0xff);
                } else if (len == 127) {
                    len = readLong(in);
                }
                boolean masked = (b2 & 0x80) != 0;
                byte[] mask = new byte[4];
                if (masked) {
                    if (in.read(mask) != 4) break;
                }
                if (len > maxPayload) throw new IOException("payload too big: " + len);
                byte[] data = new byte[(int) len];
                int got = 0;
                while (got < len) {
                    int n = in.read(data, got, (int) len - got);
                    if (n < 0) throw new IOException("eof");
                    got += n;
                }
                if (masked) {
                    for (int i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
                }
                switch (opcode) {
                    case 0x0: frag.write(data); break;
                    case 0x1:
                    case 0x2:
                        if (fin) {
                            deliverText(data);
                        } else {
                            fragOp = opcode; frag.reset(); frag.write(data);
                        }
                        break;
                    case 0x8: close(1000, "remote close"); socket.close(); return;
                    case 0x9: sendFrame(0xA, data); break;
                    case 0xA: break;
                    default: break;
                }
                if (fin && fragOp >= 0) {
                    deliverText(frag.toByteArray());
                    fragOp = -1;
                }
            }
            if (!closed.getAndSet(true)) listener.onClose(1000, "closed");
        } catch (Exception e) {
            Log.w(TAG, "ws error", e);
            if (!closed.getAndSet(true)) listener.onError(e);
        } finally {
            try { if (socket != null) socket.close(); } catch (IOException ignored) {}
        }
    }

    private void deliverText(byte[] data) {
        if (data.length > 0) listener.onMessage(new String(data, StandardCharsets.UTF_8));
    }

    private void readHttpResponse(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        int state = 0;
        while (state < 4) {
            int c = in.read();
            if (c < 0) throw new IOException("no http response");
            bos.write(c);
            if (c == '\r') {
                int c2 = in.read();
                if (c2 < 0) throw new IOException("eof");
                bos.write(c2);
                if (c2 == '\n') {
                    state++;
                } else {
                    state = (c2 == '\r') ? 1 : 0;
                }
            } else {
                state = 0;
            }
        }
        String header = bos.toString("ISO-8859-1");
        if (!header.startsWith("HTTP/1.1 101")) {
            throw new IOException("bad handshake: " + header.split("\r\n")[0]);
        }
    }

    private static long readLong(InputStream in) throws IOException {
        long v = 0;
        for (int i = 0; i < 8; i++) {
            v = (v << 8) | (in.read() & 0xff);
        }
        return v;
    }
}