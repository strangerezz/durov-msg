package com.durovmsg;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;
import android.graphics.Color;

public class MainActivity extends Activity {
    private WebView web;
    private EditText addrInput;
    private LinearLayout bar;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0f1117"));

        // Верхняя строка: адрес + кнопка Сохранить
        bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setPadding(12, 12, 12, 12);
        bar.setBackgroundColor(Color.parseColor("#1b1e2a"));

        addrInput = new EditText(this);
        addrInput.setTextColor(Color.WHITE);
        addrInput.setSingleLine(true);
        addrInput.setHint("http://IP-сервера:9173");
        addrInput.setHintTextColor(Color.parseColor("#8a90a8"));
        LinearLayout.LayoutParams barLp = new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.MATCH_PARENT, 1f);
        addrInput.setLayoutParams(barLp);
        bar.addView(addrInput);

        android.widget.Button saveBtn = new android.widget.Button(this);
        saveBtn.setText("GO");
        saveBtn.setAllCaps(true);
        saveBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                saveAndLoad();
            }
        });
        bar.addView(saveBtn, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.MATCH_PARENT));

        root.addView(bar, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0f1117"));
        root.addView(web, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0, 1f));

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.grant(request.getResources());
            }
        });
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        setContentView(root);

        SharedPreferences prefs = getSharedPreferences("durov", MODE_PRIVATE);
        String last = prefs.getString("server", "");
        addrInput.setText(last);
        if (last.isEmpty()) {
            addrInput.setText("http://192.168.1.2:9173");
        } else {
            loadUrl(last);
        }
    }

    private void saveAndLoad() {
        String url = addrInput.getText().toString().trim();
        if (url.isEmpty()) {
            Toast.makeText(this, "Введи адрес сервера: http://IP:9173", Toast.LENGTH_LONG).show();
            return;
        }
        if (!url.startsWith("http")) url = "http://" + url;
        getSharedPreferences("durov", MODE_PRIVATE).edit().putString("server", url).apply();
        loadUrl(url);
    }

    private void loadUrl(String url) {
        web.loadUrl(url);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (web != null) web.destroy();
    }
}