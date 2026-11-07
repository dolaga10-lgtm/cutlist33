package com.mohamedadel.cutlist;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/www/index.html";
    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_SAVE_DOC = 1002;
    private static final String INTERNAL_DB_FILENAME = "cutlist_clients_projects_db.json";

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private byte[] pendingSaveBytes;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(true);

        webView.addJavascriptInterface(new NativeSaver(), "NativeSaver");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost())) {
                    return false; // صفحات التطبيق نفسه
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) { }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setOnCancelListener(d -> result.confirm())
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "اختر ملف"), REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    filePathCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_SAVE_DOC) {
            byte[] bytes = pendingSaveBytes;
            pendingSaveBytes = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && bytes != null) {
                try (OutputStream os = getContentResolver().openOutputStream(data.getData())) {
                    if (os == null) throw new IllegalStateException("OutputStream is null");
                    os.write(bytes);
                    os.flush();
                    Toast.makeText(this, "تم حفظ الملف بنجاح", Toast.LENGTH_LONG).show();
                } catch (Exception e) {
                    Toast.makeText(this, "تعذّر حفظ الملف", Toast.LENGTH_LONG).show();
                }
            } else {
                Toast.makeText(this, "تم إلغاء الحفظ", Toast.LENGTH_SHORT).show();
            }
            return;
        }
        if (requestCode == REQ_FILE_CHOOSER && filePathCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            webView.evaluateJavascript(
                    "(function(){try{var m=window.jQuery&&jQuery('.modal.in');"
                            + "if(m&&m.length){m.modal('hide');return 'closed';}}catch(e){}return 'none';})()",
                    value -> {
                        if (value != null && value.contains("closed")) {
                            return;
                        }
                        String url = webView.getUrl();
                        boolean onMainPage = url == null || url.contains("/index.html");
                        if (!onMainPage && webView.canGoBack()) {
                            webView.goBack();
                        } else {
                            finish();
                        }
                    });
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("NativeSaver");
            webView.destroy();
        }
        super.onDestroy();
    }

    /**
     * واجهة الحفظ المحلية:
     * - المشروعات وقائمة العملاء: تُحفظ داخلياً في التطبيق بدون فتح مدير الملفات.
     * - استخراج PDF أو صورة (أو CSV/نسخة احتياطية): يفتح مدير الملفات ليختار المستخدم مكان الحفظ بالضبط.
     */
    public class NativeSaver {

        /** حفظ قاعدة بيانات العملاء والمشروعات داخلياً داخل مساحة التطبيق الخاصة بدون مدير ملفات */
        @JavascriptInterface
        public void saveInternalDb(String jsonContent) {
            try {
                if (jsonContent == null) return;
                File dbFile = new File(getFilesDir(), INTERNAL_DB_FILENAME);
                try (FileOutputStream fos = new FileOutputStream(dbFile, false)) {
                    fos.write(jsonContent.getBytes(StandardCharsets.UTF_8));
                    fos.flush();
                }
            } catch (Exception ignored) { }
        }

        /** قراءة قاعدة بيانات العملاء والمشروعات المحفوظة داخلياً */
        @JavascriptInterface
        public String loadInternalDb() {
            try {
                File dbFile = new File(getFilesDir(), INTERNAL_DB_FILENAME);
                if (!dbFile.exists()) return "";
                try (FileInputStream fis = new FileInputStream(dbFile);
                     ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = fis.read(buf)) != -1) {
                        bos.write(buf, 0, n);
                    }
                    return new String(bos.toByteArray(), StandardCharsets.UTF_8);
                }
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void saveText(String content, String filename, String mime) {
            pick(content.getBytes(StandardCharsets.UTF_8), filename, mime);
        }

        @JavascriptInterface
        public void saveDataUrl(String dataUrl, String filename, String mime) {
            pickSaveDataUrl(dataUrl, filename, mime);
        }

        /** يفتح مدير الملفات (Save As) عشان المستخدم يختار مكان الحفظ بالضبط (للصور وملفات PDF وغيرها). */
        @JavascriptInterface
        public void pickSaveText(String content, String filename, String mime) {
            pick(content.getBytes(StandardCharsets.UTF_8), filename, mime);
        }

        @JavascriptInterface
        public void pickSaveDataUrl(String dataUrl, String filename, String mime) {
            try {
                int comma = dataUrl.indexOf(',');
                String header = dataUrl.substring(0, comma);
                String body = dataUrl.substring(comma + 1);
                byte[] bytes = header.contains(";base64")
                        ? Base64.decode(body, Base64.DEFAULT)
                        : Uri.decode(body).getBytes(StandardCharsets.UTF_8);
                if (mime == null || mime.isEmpty()) {
                    int semi = header.indexOf(';');
                    if (header.startsWith("data:") && header.length() > 5) {
                        mime = header.substring(5, semi > 0 ? semi : header.length());
                    }
                }
                pick(bytes, filename, mime);
            } catch (Exception e) {
                toast("تعذّر تجهيز الملف للحفظ");
            }
        }

        private void pick(final byte[] bytes, final String filename, final String mime) {
            runOnUiThread(() -> {
                try {
                    pendingSaveBytes = bytes;
                    String safeName = (filename == null || filename.isEmpty() ? "cutlist" : filename)
                            .replaceAll("[\\\\/:*?\"<>|]", "_");
                    String resolvedMime = mime;
                    if (resolvedMime == null || resolvedMime.isEmpty()) {
                        String lower = safeName.toLowerCase();
                        if (lower.endsWith(".pdf")) resolvedMime = "application/pdf";
                        else if (lower.endsWith(".jpeg") || lower.endsWith(".jpg")) resolvedMime = "image/jpeg";
                        else if (lower.endsWith(".png")) resolvedMime = "image/png";
                        else if (lower.endsWith(".csv")) resolvedMime = "text/csv";
                        else if (lower.endsWith(".json")) resolvedMime = "application/json";
                        else resolvedMime = "application/octet-stream";
                    }
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType(resolvedMime);
                    intent.putExtra(Intent.EXTRA_TITLE, safeName);
                    startActivityForResult(intent, REQ_SAVE_DOC);
                } catch (Exception e) {
                    pendingSaveBytes = null;
                    toast("تعذّر فتح مدير الملفات");
                }
            });
        }

        private void toast(final String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show());
        }
    }
}
