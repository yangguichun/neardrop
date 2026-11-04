package com.huajie.neardrop;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.MediaRecorder;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

public class MainActivity extends Activity {

    public static final String PREFS = "neardrop";
    public static final String ASSET_HOST = "appassets.local";
    public static final String ASSET_BASE = "http://appassets.local/";
    private static final int REQ_AUDIO = 1001;
    private static final int REQ_FILE = 1002;
    private static final int REQ_CAMERA = 1003;

    private WebView web;
    private FrameLayout root;
    private String server = "";

    // WebView 里 <input type="file"> 的回调，必须由原生实现，否则点击无反应
    private ValueCallback<Uri[]> filePathCallback;
    private Uri cameraUri;

    private MediaRecorder recorder;
    private File recFile;
    private long recStart = 0;
    private String pendingConv = "room";
    private String pendingDevice = "";

    // 保存任务的进度/结果要靠原生回传前端，前端挂上钩子后才用它，否则退回 Toast
    private volatile boolean jsHooked = false;
    private volatile boolean saving = false;
    // 最近一次保存落在哪个目录（相对外部存储），「打开」按钮用它定位；同时写进 SP，重启也还在
    private volatile String lastSaveFolder = "";

    // ------------------------------------------------------------------ 生命周期
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#f7f7f7"));
        w.setNavigationBarColor(Color.parseColor("#f7f7f7"));
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(true);
        }

        root = new FrameLayout(this);
        root.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        server = sp.getString("server", "");

        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        if (Build.VERSION.SDK_INT >= 26) {
            s.setSafeBrowsingEnabled(false);
        }

        web.setBackgroundColor(Color.parseColor("#f7f7f7"));
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u != null && ASSET_HOST.equals(u.getHost())) {
                    String path = u.getPath();
                    if (path == null || path.equals("/")) path = "/index.html";
                    if (path.startsWith("/")) path = path.substring(1);
                    try {
                        InputStream is = getAssets().open(path);
                        String mime = guessMime(path);
                        String enc = isTextMime(mime) ? "utf-8" : null;
                        java.util.Map<String, String> headers = new java.util.HashMap<>();
                        headers.put("Access-Control-Allow-Origin", "*");
                        headers.put("Cache-Control", "no-cache");
                        return new WebResourceResponse(mime, enc, 200, "OK", headers, is);
                    } catch (Exception e) {
                        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final android.webkit.PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        request.grant(request.getResources());
                    }
                });
            }

            /** 关键：把网页里的 <input type="file"> 点击转成系统选择器 */
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    try { filePathCallback.onReceiveValue(null); } catch (Exception ignored) {}
                    filePathCallback = null;
                }
                filePathCallback = callback;

                try {
                    String[] accepts = params.getAcceptTypes();
                    String type = "*/*";
                    boolean wantImage = false, wantVideo = false;
                    if (accepts != null) {
                        for (String a : accepts) {
                            if (a == null) continue;
                            for (String part : a.split(",")) {
                                part = part.trim().toLowerCase();
                                if (part.isEmpty()) continue;
                                if (part.startsWith("image/")) { wantImage = true; type = "image/*"; }
                                else if (part.startsWith("video/")) { wantVideo = true; type = "video/*"; }
                                else if (part.startsWith("audio/")) { type = "audio/*"; }
                                else if (!part.equals("*/*")) { type = part; }
                            }
                        }
                    }
                    if (wantImage && wantVideo) type = "*/*";

                    // 拍照：网页里带 capture 的输入框
                    if (params.isCaptureEnabled() && wantImage) {
                        Intent take = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                        cameraUri = createCameraUri();
                        if (cameraUri != null) {
                            take.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                            take.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                            startActivityForResult(take, REQ_CAMERA);
                            return true;
                        }
                    }

                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType(type);
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    Intent chooser = Intent.createChooser(intent, "选择文件");
                    startActivityForResult(chooser, REQ_FILE);
                    return true;
                } catch (Exception e) {
                    if (filePathCallback != null) {
                        try { filePathCallback.onReceiveValue(null); } catch (Exception ignored) {}
                        filePathCallback = null;
                    }
                    toast("打开选择器失败：" + e.getMessage());
                    return false;
                }
            }
        });
        web.addJavascriptInterface(new Bridge(), "NearDrop");

        if (server == null || server.isEmpty()) {
            web.loadUrl(ASSET_BASE + "connect.html");
        } else {
            loadApp();
        }
    }

    private void loadApp() {
        web.loadUrl(ASSET_BASE + "index.html");
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            // 先让页面自己处理：全屏播放器、长按菜单、图片预览都是页面内的浮层
            web.evaluateJavascript(
                    "(function(){" +
                            "if(window.__ndBack&&window.__ndBack()==='1')return '2';" +
                            "if(document.body.classList.contains('chat-open')){" +
                            "document.body.classList.remove('chat-open');return '1';}" +
                            "return '0';})()",
                    value -> {
                        if (value == null || (!value.contains("1") && !value.contains("2"))) {
                            if (server == null || server.isEmpty()) {
                                finish();
                            } else {
                                moveTaskToBack(true);
                            }
                        }
                    });
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ------------------------------------------------------------------ 选择结果
    /** 拍照落地用的目标 Uri（走 MediaStore，免存储权限、免 FileProvider） */
    private Uri createCameraUri() {
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, "shot_" + System.currentTimeMillis() + ".jpg");
            v.put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg");
            if (Build.VERSION.SDK_INT >= 29) {
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/近传");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            }
            return getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE || requestCode == REQ_CAMERA) {
            Uri[] result = null;
            if (resultCode == RESULT_OK) {
                if (requestCode == REQ_CAMERA) {
                    if (cameraUri != null) {
                        // 拍照完成，解除 pending，否则相册里看不到
                        if (Build.VERSION.SDK_INT >= 29) {
                            try {
                                ContentValues v = new ContentValues();
                                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                                getContentResolver().update(cameraUri, v, null, null);
                            } catch (Exception ignored) {}
                        }
                        result = new Uri[]{cameraUri};
                    }
                } else if (data != null) {
                    ClipData clip = data.getClipData();
                    if (clip != null && clip.getItemCount() > 0) {
                        result = new Uri[clip.getItemCount()];
                        for (int i = 0; i < clip.getItemCount(); i++) {
                            result[i] = clip.getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        result = new Uri[]{data.getData()};
                    }
                }
            } else if (requestCode == REQ_CAMERA && cameraUri != null) {
                // 取消拍照，删掉占位文件，免得相册里留空图
                try { getContentResolver().delete(cameraUri, null, null); } catch (Exception ignored) {}
            }

            if (filePathCallback != null) {
                try { filePathCallback.onReceiveValue(result); } catch (Exception ignored) {}
                filePathCallback = null;
            }
            cameraUri = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ------------------------------------------------------------------ JS 桥
    public class Bridge {

        @JavascriptInterface
        public String isApp() {
            return "1";
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }

        /**
         * 这台手机的固定编号。存在 SharedPreferences 里，清缓存、重装 App 都还在，
         * 服务端靠它认出「还是上次那台手机」，换 Wi-Fi 也不用重新输访问码。
         */
        @JavascriptInterface
        public String getDeviceId() {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            String id = sp.getString("device_id", "");
            if (id == null || id.isEmpty()) {
                id = "d_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
                sp.edit().putString("device_id", id).apply();
            }
            return id;
        }

        /** 安卓系统给本应用的稳定标识，作为设备编号丢失后的找回依据。 */
        @JavascriptInterface
        public String getHwId() {
            try {
                String aid = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
                if (aid != null && !aid.isEmpty()) return "android:" + aid;
            } catch (Exception ignored) {
            }
            return "";
        }

        @JavascriptInterface
        public String getServer() {
            return server == null ? "" : server;
        }

        @JavascriptInterface
        public void setServer(String url) {
            if (url == null) return;
            url = url.trim();
            if (url.endsWith("/")) url = url.substring(0, url.length() - 1);
            server = url;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("server", url).apply();
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    loadApp();
                }
            });
        }

        @JavascriptInterface
        public void resetServer() {
            server = "";
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("server").apply();
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    web.loadUrl(ASSET_BASE + "connect.html");
                }
            });
        }

        /** 只清掉记住的地址，不跳转（连不上旧地址时用，避免下次启动又卡住） */
        @JavascriptInterface
        public void clearServer() {
            server = "";
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("server").apply();
        }

        @JavascriptInterface
        public String discover() {
            return discoverServers();
        }

        /** 前端脚本就绪标记：挂上 __ndSave 之后，保存进度就不再用原生 Toast */
        @JavascriptInterface
        public void jsReady() {
            jsHooked = true;
        }

        /** 复制到剪贴板：WebView 从 http:// 加载，navigator.clipboard 在部分机型上不可用，走原生最稳 */
        @JavascriptInterface
        public void copyText(final String text) {
            if (text == null) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("neardrop", text));
                    } catch (Exception ignored) {
                    }
                }
            });
        }

        /**
         * 在文件管理器里打开保存目录。
         * which：last（最近一次保存的目录）/ download（下载 › 近传）/ camera（相册 › 相机）
         * 跳不过去时会把真实路径复制到剪贴板并提示，保证用户始终有办法找到文件。
         */
        @JavascriptInterface
        public void openFolder(final String which) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    openFolderInner(which);
                }
            });
        }

        /** 全屏播放器旋转：landscape / portrait / auto */
        @JavascriptInterface
        public void setOrientation(final String mode) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if ("landscape".equals(mode)) {
                            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                        } else if ("portrait".equals(mode)) {
                            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
                        } else {
                            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                        }
                    } catch (Exception ignored) {
                    }
                }
            });
        }

        /**
         * 下载并保存到相册（图片/视频）或下载目录。
         * 注意：这里是异步的，返回 "ok" 只代表任务已开始，绝不能再当成"保存成功"。
         * 真正的结果通过 window.__ndSave(state, msg) 回传，state 为 start/progress/done/error。
         */
        @JavascriptInterface
        public String saveUrl(final String url, final String name) {
            if (saving) return "busy";
            saving = true;
            final String full = url.startsWith("http") ? url : (server + url);
            final String finalName = (name == null || name.isEmpty()) ? ("neardrop_" + System.currentTimeMillis()) : name;
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        saveState("start", "正在保存…");
                        HttpURLConnection c = (HttpURLConnection) new URL(full).openConnection();
                        c.setConnectTimeout(8000);
                        c.setReadTimeout(120000);
                        c.setRequestProperty("Accept-Encoding", "identity");
                        c.connect();
                        // 必须先看状态码：401/404 时拿到的是错误页，存下来就是一张打不开的"图"
                        int status = c.getResponseCode();
                        if (status != 200 && status != 206) {
                            saveState("error", "保存失败：HTTP " + status);
                            return;
                        }
                        String mime = c.getContentType();
                        if (mime == null) mime = guessMime(finalName);
                        int semi = mime.indexOf(';');
                        if (semi > 0) mime = mime.substring(0, semi);
                        mime = mime.trim().toLowerCase();
                        if (mime.isEmpty() || mime.equals("application/octet-stream")) {
                            mime = guessMime(finalName);
                        }
                        long total = -1;
                        try {
                            total = c.getContentLengthLong();
                        } catch (Throwable ignored) {
                        }
                        InputStream in = new BufferedInputStream(c.getInputStream(), 262144);
                        long tStart = System.currentTimeMillis();
                        String where = saveStream(in, finalName, mime, total);
                        in.close();
                        long dt = Math.max(1, System.currentTimeMillis() - tStart);
                        if (total > 0) {
                            where = where + " · " + Math.round(total / 1048576.0) + "MB / "
                                    + String.format(java.util.Locale.US, "%.0f", dt / 1000.0) + "s";
                        }
                        saveState("done", where);
                    } catch (Exception e) {
                        saveState("error", "保存失败：" + e.getMessage());
                    } finally {
                        saving = false;
                    }
                }
            }).start();
            return "ok";
        }

        @JavascriptInterface
        public void recordStart() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startRecord();
                }
            });
        }

        @JavascriptInterface
        public void recordStop(String cancel, String conv, String device) {
            pendingConv = (conv == null || conv.isEmpty()) ? "room" : conv;
            pendingDevice = (device == null) ? "" : device;
            final boolean c = "1".equals(cancel);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    stopRecord(c);
                }
            });
        }

        @JavascriptInterface
        public void toastMsg(String msg) {
            toast(msg);
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    finish();
                }
            });
        }
    }

    private void toast(final String msg) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
            }
        });
    }

    // ------------------------------------------------------------------ 打开保存目录
    private void setLastFolder(String rel) {
        lastSaveFolder = rel;
        try {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("last_folder", rel).apply();
        } catch (Exception ignored) {
        }
    }

    private void openFolderInner(String which) {
        String rel;
        if ("camera".equals(which)) {
            rel = Environment.DIRECTORY_DCIM + "/Camera";
        } else if ("download".equals(which)) {
            rel = Environment.DIRECTORY_DOWNLOADS + "/近传";
        } else {
            rel = lastSaveFolder;
            if (rel == null || rel.isEmpty()) {
                rel = getSharedPreferences(PREFS, MODE_PRIVATE).getString("last_folder", "");
            }
            if (rel == null || rel.isEmpty()) rel = Environment.DIRECTORY_DOWNLOADS + "/近传";
        }
        // 目录还没建出来（比如从来没存过非媒体文件）就往上退一级，别让文件管理器弹空目录或报错
        String probe = rel;
        for (int i = 0; i < 2 && !dirExists(probe); i++) {
            int slash = probe.lastIndexOf('/');
            probe = slash > 0 ? probe.substring(0, slash) : "";
        }
        if (openTree(probe)) return;
        if (openTree("")) return;
        String abs = "/storage/emulated/0/" + (rel.isEmpty() ? "" : rel + "/");
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("neardrop-path", abs));
            toast("这台手机不支持跳转，路径已复制：" + abs);
        } catch (Exception e) {
            toast("打不开文件管理器，路径：" + abs);
        }
    }

    private boolean dirExists(String rel) {
        try {
            File f = new File(Environment.getExternalStorageDirectory(), rel);
            return f.isDirectory();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 用系统文档界面（文件管理器）打开某个目录。
     * rel 传空表示外部存储根目录。系统不认时会抛异常，交给调用方降级。
     */
    private boolean openTree(String rel) {
        try {
            String docId = (rel == null || rel.isEmpty()) ? "primary:" : "primary:" + rel;
            Uri uri = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", docId);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "resource/folder");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            startActivity(i);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 把保存状态回传前端。前端挂了 window.__ndSave 就用它（能显示百分比进度、也不会提前报成功），
     * 没挂上则退回原生 Toast，保证任何情况下用户都能得到一次真实的结果提示。
     */
    private void saveState(final String state, final String msg) {
        if (jsHooked) {
            final String js = "window.__ndSave&&window.__ndSave("
                    + JSONObject.quote(state) + "," + JSONObject.quote(msg) + ");";
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        web.evaluateJavascript(js, null);
                    } catch (Exception ignored) {
                    }
                }
            });
        } else if ("done".equals(state) || "error".equals(state)) {
            toast(msg);
        }
    }

    // ------------------------------------------------------------------ 录音
    private boolean hasAudioPermission() {
        if (Build.VERSION.SDK_INT < 23) return true;
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void startRecord() {
        if (!hasAudioPermission()) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
            toast("请允许录音权限后再点一次");
            return;
        }
        try {
            recFile = new File(getCacheDir(), "rec_" + System.currentTimeMillis() + ".m4a");
            if (Build.VERSION.SDK_INT >= 31) {
                recorder = new MediaRecorder(this);
            } else {
                recorder = new MediaRecorder();
            }
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioEncodingBitRate(64000);
            recorder.setAudioSamplingRate(44100);
            recorder.setOutputFile(recFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            recStart = System.currentTimeMillis();
        } catch (Exception e) {
            toast("录音启动失败：" + e.getMessage());
            releaseRecorder();
        }
    }

    private void stopRecord(boolean cancel) {
        if (recorder == null) {
            recFile = null;
            return;
        }
        try {
            recorder.stop();
        } catch (Exception ignored) {
        }
        releaseRecorder();

        if (recFile == null || !recFile.exists()) return;
        if (cancel) {
            recFile.delete();
            recFile = null;
            return;
        }
        final double dur = (System.currentTimeMillis() - recStart) / 1000.0;
        final File f = recFile;
        recFile = null;

        if (f.length() < 1200 || dur < 0.6) {
            f.delete();
            toast("录音太短");
            return;
        }

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    uploadAudio(f, pendingConv, pendingDevice, dur);
                } catch (Exception e) {
                    toast("发送语音失败：" + e.getMessage());
                } finally {
                    f.delete();
                }
            }
        }).start();
    }

    private void releaseRecorder() {
        if (recorder != null) {
            try {
                recorder.release();
            } catch (Exception ignored) {
            }
            recorder = null;
        }
    }

    private void uploadAudio(File f, String conv, String device, double dur) throws Exception {
        String boundary = "----NearDrop" + System.currentTimeMillis();
        String urlStr = server + "/api/upload";
        HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(120000);
        c.setDoOutput(true);
        c.setRequestMethod("POST");
        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);

        byte[] data = readAll(f);
        DataOutputStream out = new DataOutputStream(c.getOutputStream());
        writePart(out, boundary, "conv", conv);
        writePart(out, boundary, "device", device);
        writePart(out, boundary, "duration", String.valueOf(dur));
        String fname = "voice_" + System.currentTimeMillis() + ".m4a";
        out.writeBytes("--" + boundary + "\r\n");
        out.writeBytes("Content-Disposition: form-data; name=\"file\"; filename=\"" + fname + "\"\r\n");
        out.writeBytes("Content-Type: audio/mp4\r\n\r\n");
        out.write(data);
        out.writeBytes("\r\n--" + boundary + "--\r\n");
        out.flush();
        out.close();

        int code = c.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new Exception("HTTP " + code);
        }
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript("window.__ndRefresh && window.__ndRefresh();", null);
            }
        });
    }

    private void writePart(DataOutputStream out, String boundary, String name, String value) throws Exception {
        out.writeBytes("--" + boundary + "\r\n");
        out.writeBytes("Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n");
        out.write(value.getBytes("UTF-8"));
        out.writeBytes("\r\n");
    }

    private static byte[] readAll(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return bos.toByteArray();
    }

    // ------------------------------------------------------------------ 保存到相册
    // 存到系统相机目录 DCIM/Camera：华为/荣耀图库只稳定索引这个目录和 Pictures 根目录，
    // 之前存 Pictures/近传 会出现「提示保存成功、相册里找不到」。
    private String saveStream(InputStream in, String name, String mime, long total) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver resolver = getContentResolver();
            Uri collection;
            String rel;
            if (mime.startsWith("image/")) {
                collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                rel = Environment.DIRECTORY_DCIM + "/Camera";
            } else if (mime.startsWith("video/")) {
                collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                rel = Environment.DIRECTORY_DCIM + "/Camera";
            } else {
                collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                rel = Environment.DIRECTORY_DOWNLOADS + "/近传";
            }
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri item = resolver.insert(collection, v);
            if (item == null) throw new Exception("无法创建文件");
            OutputStream out = resolver.openOutputStream(item);
            copy(in, out, total);
            out.close();
            v.clear();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(item, v, null, null);
            // 催一下媒体库刷新，华为图库有时不主动扫
            try {
                sendBroadcast(new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, item));
            } catch (Exception ignored) {
            }
            setLastFolder(rel);
            if (mime.startsWith("image/") || mime.startsWith("video/")) return "已存到相册（相机）";
            return "已存到 文件管理 › 下载 › 近传";
        } else {
            File dir;
            if (mime.startsWith("image/") || mime.startsWith("video/")) {
                dir = new File(Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DCIM), "Camera");
            } else {
                dir = new File(Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS), "近传");
            }
            if (!dir.exists()) dir.mkdirs();
            File outFile = new File(dir, name);
            int i = 1;
            String base = name;
            String ext = "";
            int dot = name.lastIndexOf('.');
            if (dot > 0) {
                base = name.substring(0, dot);
                ext = name.substring(dot);
            }
            while (outFile.exists()) {
                outFile = new File(dir, base + "_" + (i++) + ext);
            }
            FileOutputStream fos = new FileOutputStream(outFile);
            copy(in, fos, total);
            fos.close();
            // 通知相册刷新
            android.media.MediaScannerConnection.scanFile(
                    this, new String[]{outFile.getAbsolutePath()},
                    new String[]{mime}, null);
            setLastFolder(mime.startsWith("image/") || mime.startsWith("video/")
                    ? Environment.DIRECTORY_DCIM + "/Camera"
                    : Environment.DIRECTORY_DOWNLOADS + "/近传");
            if (mime.startsWith("image/") || mime.startsWith("video/")) return "已存到相册（相机）";
            return "已存到 文件管理 › 下载 › 近传";
        }
    }

    /** 带进度的拷贝：每超过 5% 回传一次，避免刷屏；消息里带实时速度，方便判断是不是网络慢 */
    private void copy(InputStream in, OutputStream out, long total) throws Exception {
        byte[] buf = new byte[262144];
        int n;
        long done = 0;
        long t0 = System.currentTimeMillis();
        int lastPct = -5;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            done += n;
            if (total > 0) {
                int pct = (int) (done * 100 / total);
                if (pct >= lastPct + 5) {
                    lastPct = pct;
                    double sec = Math.max(0.001, (System.currentTimeMillis() - t0) / 1000.0);
                    double mbps = done / 1048576.0 / sec;
                    saveState("progress", Math.min(pct, 99) + "% · "
                            + String.format(java.util.Locale.US, "%.1f", mbps) + " MB/s");
                }
            }
        }
        out.flush();
    }

    private static String guessMime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".js")) return "application/javascript";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".ico")) return "image/x-icon";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".heic")) return "image/heic";
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".mov")) return "video/quicktime";
        if (n.endsWith(".m4a")) return "audio/mp4";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".webm")) return "audio/webm";
        return "application/octet-stream";
    }

    private static boolean isTextMime(String m) {
        return m != null && (m.startsWith("text/") || m.contains("javascript") || m.contains("json"));
    }

    // ------------------------------------------------------------------ 自动发现
    private String discoverServers() {
        JSONArray arr = new JSONArray();
        DatagramSocket sock = null;
        try {
            sock = new DatagramSocket();
            sock.setBroadcast(true);
            sock.setSoTimeout(300);
            byte[] req = "NEARDROP_DISCOVER".getBytes("UTF-8");

            List<InetAddress> targets = new ArrayList<>();
            targets.add(InetAddress.getByName("255.255.255.255"));
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (ia.getBroadcast() != null) targets.add(ia.getBroadcast());
                }
            }
            for (InetAddress t : targets) {
                try {
                    sock.send(new DatagramPacket(req, req.length, t, 37021));
                } catch (Exception ignored) {
                }
            }

            long end = System.currentTimeMillis() + 1500;
            Set<String> seen = new HashSet<>();
            while (System.currentTimeMillis() < end) {
                byte[] buf = new byte[2048];
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try {
                    sock.receive(p);
                } catch (SocketTimeoutException e) {
                    continue;
                } catch (Exception e) {
                    break;
                }
                String txt = new String(p.getData(), 0, p.getLength(), "UTF-8");
                try {
                    JSONObject o = new JSONObject(txt);
                    String ip = p.getAddress().getHostAddress();
                    int port = o.optInt("port", 8787);
                    String key = ip + ":" + port;
                    if (!seen.add(key)) continue;
                    JSONObject item = new JSONObject();
                    item.put("ip", ip);
                    item.put("port", port);
                    item.put("name", o.optString("name", "电脑"));
                    item.put("sid", o.optString("sid", ""));
                    item.put("url", "http://" + ip + ":" + port);
                    arr.put(item);
                } catch (Exception ignored) {
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (sock != null) sock.close();
        }
        return arr.toString();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onDestroy() {
        releaseRecorder();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
