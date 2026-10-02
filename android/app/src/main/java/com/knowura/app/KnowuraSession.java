package com.knowura.app;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.service.voice.VoiceInteractionSession;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.FileInputStream;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The floating assistant panel. It shows https://knowura.vercel.app/assistant (Knowura's own UI) in a
 * transparent WebView over whatever app is underneath. It never asks for screen contents.
 */
public class KnowuraSession extends VoiceInteractionSession {
    private static final String HOST = "knowura.vercel.app";
    private static final String ASSISTANT_URL = "https://" + HOST + "/assistant?native=1";

    private static WeakReference<KnowuraSession> current = new WeakReference<>(null);
    private static ValueCallback<Uri[]> pendingFiles;
    private static volatile boolean resumeNext;   // the next show() is a return from the picker / permission screen, not a fresh open
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private boolean pageFailed;
    private boolean showing;
    private boolean resuming;
    private boolean pageReady;   // the page has finished loading, so its hooks (knowuraShown ...) exist
    private long loadedAt;   // when the panel's page last finished loading; an old one is reloaded on open so deploys always show
    private volatile NativeMic mic;

    public KnowuraSession(Context context) {
        super(context);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            // lift the panel above the on-screen keyboard instead of being covered by it
            getWindow().getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        } catch (RuntimeException ignored) {
            // cosmetic only
        }
    }

    @Override
    public View onCreateContentView() {
        Context ctx = getContext();
        FrameLayout root = new FrameLayout(ctx);
        web = new WebView(ctx);
        web.setBackgroundColor(Color.TRANSPARENT);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " KnowuraAssistant/1");

        web.addJavascriptInterface(new Bridge(), "KnowuraNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("https".equals(u.getScheme()) && HOST.equals(u.getHost())) return false;
                openExternal(new Intent(Intent.ACTION_VIEW, u));
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                loadedAt = System.currentTimeMillis();
                pageReady = true;
                // the panel can be opened before the page has loaded; start it as soon as it has
                if (showing) {
                    callShown();
                    deliverPicked();
                }
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost()) && u.getPath() != null && u.getPath().startsWith("/__kw_file/")) {
                    try {
                        PickedFiles.Item it = PickedFiles.get(Integer.parseInt(u.getLastPathSegment()));
                        if (it != null) {
                            Map<String, String> h = new HashMap<>();
                            h.put("X-Kw-Name", Uri.encode(it.name));
                            h.put("Cache-Control", "no-store");
                            return new WebResourceResponse(it.mime, null, 200, "OK", h, new FileInputStream(it.file));
                        }
                    } catch (Exception ignored) {
                        // falls through to 404
                    }
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) pageFailed = true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                Intent pick = new Intent(getContext(), FilePickActivity.class);
                pick.putExtra("multiple", params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                String[] types = params.getAcceptTypes();
                boolean imagesOnly = types != null && types.length > 0;
                if (types != null) for (String t : types) if (t == null || !t.startsWith("image/")) imagesOnly = false;
                pick.putExtra("images", imagesOnly);
                pick.putExtra("capture", params.isCaptureEnabled());   // <input capture>: open the phone's camera app
                if (openExternal(pick)) {
                    // the panel's window sits above the camera app, gallery and file manager, so step aside; filesPicked() brings it back (with the files, or as it was if cancelled)
                    main.postDelayed(() -> {
                        try {
                            hide();
                        } catch (RuntimeException ignored) {
                            // already hidden
                        }
                    }, 150);
                }
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                ArrayList<String> allowed = new ArrayList<>();
                boolean missing = false;
                for (String r : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                        if (hasMic()) allowed.add(r); else missing = true;
                    }
                }
                if (allowed.isEmpty() || !HOST.equals(request.getOrigin().getHost())) {
                    request.deny();
                    if (missing) web.evaluateJavascript("window.knowuraNeedMic&&window.knowuraNeedMic()", null);
                } else {
                    request.grant(allowed.toArray(new String[0]));
                }
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(ASSISTANT_URL);
        return root;
    }

    @Override
    public void onShow(Bundle args, int showFlags) {
        super.onShow(args, showFlags);
        BubbleService.hide();   // the panel is back, so the minimised bubble goes away
        showing = true;
        current = new WeakReference<>(this);
        boolean resume = resumeNext;
        resumeNext = false;
        if (resume) resuming = true;
        if (web == null) return;
        boolean stale = !resuming && loadedAt > 0 && System.currentTimeMillis() - loadedAt > 5 * 60 * 1000L;
        if (pageFailed || stale) {
            pageFailed = false;
            pageReady = false;
            web.loadUrl(ASSISTANT_URL);   // revalidates with the server, so the newest deploy shows up
            return; // onPageFinished starts it
        }
        if (!pageReady) return;   // still loading: onPageFinished starts it
        callShown();
        deliverPicked();
    }

    private void callShown() {
        boolean again = resuming;
        resuming = false;
        if (web != null) web.evaluateJavascript("window.knowuraShown&&window.knowuraShown(" + hasMic() + "," + again + ")", null);
    }

    /** Tells the page that files are waiting; it fetches them from /__kw_file/N and calls pickedDone() when it has them. */
    private void deliverPicked() {
        int n = PickedFiles.count();
        if (n > 0 && web != null) web.evaluateJavascript("window.knowuraPicked&&window.knowuraPicked(" + n + ")", null);
    }

    /** Result of the picker or camera (empty if cancelled): keep the files, finish the web view's chooser, bring the panel back. */
    static void filesPicked(List<PickedFiles.Item> items) {
        PickedFiles.set(items);
        ValueCallback<Uri[]> cb = pendingFiles;
        pendingFiles = null;
        if (cb != null) {
            try {
                cb.onReceiveValue(null);   // the files travel through /__kw_file/N instead, which survives a new window
            } catch (RuntimeException ignored) {
                // the old web view is gone
            }
        }
        reopen(true);
    }

    /** Brings the panel back on screen after another screen (picker, camera, permission prompt) has closed. */
    static void reopen(boolean resume) {
        resumeNext = resume;
        MAIN.post(() -> {
            if (KnowuraInteractionService.showPanel()) return;
            KnowuraSession s = current.get();
            if (s != null) {
                try {
                    s.show(null, 0);
                } catch (RuntimeException ignored) {
                    // the session is gone
                }
            }
        });
    }

    @Override
    public void onHide() {
        super.onHide();
        showing = false;
        stopMic();
        if (web != null) web.evaluateJavascript("window.knowuraHidden&&window.knowuraHidden()", null);
    }

    @Override
    public void onDestroy() {
        stopMic();
        if (web != null) {
            web.removeJavascriptInterface("KnowuraNative");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** The panel's window sits above other screens, so it steps aside a moment after another screen has been started. */
    private void hideSoon() {
        hideAfter(150);
    }

    private void hideAfter(long ms) {
        main.postDelayed(() -> {
            try {
                hide();
            } catch (RuntimeException ignored) {
                // already hidden
            }
        }, ms);
    }

    private void stopMic() {
        NativeMic m = mic;
        mic = null;
        if (m != null) m.stop();
    }

    private void js(final String code) {
        main.post(() -> {
            if (web != null) web.evaluateJavascript(code, null);
        });
    }

    private boolean hasMic() {
        return getContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    /** Starts another screen from the panel. Tries the assistant-stack way first, then a plain new task; tells the page if neither works. */
    private boolean openExternal(Intent intent) {
        boolean started;
        try {
            startAssistantActivity(intent);
            started = true;
        } catch (RuntimeException first) {
            try {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                started = true;
            } catch (RuntimeException second) {
                note("Couldn't open that. Try again from the Knowura app.");
                return false;
            }
        }
        return started;
    }

    /** Shows a short message in the panel (a toast), from any thread. */
    private void note(final String message) {
        main.post(() -> {
            if (web != null) web.evaluateJavascript("window.knowuraNote&&window.knowuraNote(" + org.json.JSONObject.quote(message) + ")", null);
        });
    }

    /** Called when the microphone prompt closes: bring the panel back and let the page start listening. */
    static void permissionDone() {
        reopen(false);
    }


    /** Methods the page can call. They arrive on a WebView thread, so everything hops to the main thread. */
    private class Bridge {
        @JavascriptInterface
        public void hide() {
            main.post(KnowuraSession.this::hide);
        }

        /** Listens with Android itself. Returns false if it can't, and the page falls back to the browser's microphone. */
        @JavascriptInterface
        public synchronized boolean micStart() {
            if (!KnowuraSession.this.hasMic()) return false;
            stopMic();
            NativeMic m = new NativeMic();
            boolean ok = m.start(new NativeMic.Listener() {
                @Override
                public void onLevel(float rms) {
                    js("window.knowuraLevel&&window.knowuraLevel(" + rms + ")");
                }

                @Override
                public void onClip(byte[] wav) {
                    js("window.knowuraClip&&window.knowuraClip('" + Base64.encodeToString(wav, Base64.NO_WRAP) + "')");
                }
            });
            if (ok) mic = m;
            return ok;
        }

        @JavascriptInterface
        public void micArm(boolean on) {
            NativeMic m = mic;
            if (m != null) m.arm(on);
        }

        /** Minimise to a floating bubble over other apps. Asks once for "Display over other apps" if it isn't allowed yet. */
        @JavascriptInterface
        public void minimize() {
            main.post(() -> {
                if (!Settings.canDrawOverlays(getContext())) {
                    if (openExternal(new Intent(getContext(), OverlayPermissionActivity.class))) hideSoon();
                    return;
                }
                BubbleService.show(getContext());
                hide();
            });
        }

        @JavascriptInterface
        public void pickedDone() {
            PickedFiles.clear();
        }

        @JavascriptInterface
        public void micStop() {
            stopMic();
        }

        @JavascriptInterface
        public boolean hasMic() {
            return KnowuraSession.this.hasMic();
        }

        @JavascriptInterface
        public void requestMic() {
            main.post(() -> openExternal(new Intent(getContext(), PermissionActivity.class).putExtra("perm", "mic")));
        }

        @JavascriptInterface
        public String installId() {
            return InstallId.get(getContext());
        }

        @JavascriptInterface
        public void openApp(final String path) {
            final String safe = path != null && path.startsWith("/") && !path.startsWith("//") ? path : "/";
            main.post(() -> {
                // through a tiny hop screen that starts the app in a normal task (not parked in the assistant's stack)
                Intent i = new Intent(getContext(), OpenAppActivity.class).setData(Uri.parse("https://" + HOST + safe));
                // keep the full-screen panel up while the app launches, then step aside once it is on screen, so the app
                // never shows half-loaded behind the panel
                if (openExternal(i)) hideAfter(550);
            });
        }

        @JavascriptInterface
        public boolean copy(final String text) {
            try {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null || text == null) return false;
                cm.setPrimaryClip(ClipData.newPlainText("Knowura", text));
                return true;
            } catch (RuntimeException e) {
                return false;
            }
        }

        @JavascriptInterface
        public void share(final String text) {
            main.post(() -> {
                Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                if (openExternal(Intent.createChooser(send, "Share Knowura's answer"))) {
                    // only the share sheet needs this: the panel's window sits above it, so step aside
                    // or the sheet opens hidden behind the panel
                    main.postDelayed(() -> {
                        try {
                            hide();
                        } catch (RuntimeException ignored) {
                            // already hidden
                        }
                    }, 150);
                }
            });
        }
    }
}
