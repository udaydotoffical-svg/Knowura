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
import android.service.voice.VoiceInteractionSession;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.lang.ref.WeakReference;
import java.util.ArrayList;

/**
 * The floating assistant panel. It shows https://knowura.vercel.app/assistant (Knowura's own UI) in a
 * transparent WebView over whatever app is underneath. It never asks for screen contents.
 */
public class KnowuraSession extends VoiceInteractionSession {
    private static final String HOST = "knowura.vercel.app";
    private static final String ASSISTANT_URL = "https://" + HOST + "/assistant?native=1";

    private static WeakReference<KnowuraSession> current = new WeakReference<>(null);
    private static ValueCallback<Uri[]> pendingFiles;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private boolean pageFailed;
    private boolean showing;
    private boolean resuming;

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
                // the panel can be opened before the page has loaded; start it as soon as it has
                if (showing) callShown();
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
                final boolean camera = params.isCaptureEnabled();
                pick.putExtra("capture", camera);   // <input capture>: open the phone's camera app
                if (openExternal(pick) && camera) {
                    // the panel's window sits above the camera app, so step aside; deliverFiles() brings it back with the picture
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
        showing = true;
        current = new WeakReference<>(this);
        if (web == null) return;
        if (pageFailed) {
            pageFailed = false;
            web.loadUrl(ASSISTANT_URL);
            return; // onPageFinished starts it
        }
        callShown();
    }

    private void callShown() {
        boolean again = resuming;
        resuming = false;
        if (web != null) web.evaluateJavascript("window.knowuraShown&&window.knowuraShown(" + hasMic() + "," + again + ")", null);
    }

    /** Result of the file picker: hand the files to the page and bring the panel back (as it was, not reset). */
    static void deliverFiles(Uri[] uris) {
        ValueCallback<Uri[]> cb = pendingFiles;
        pendingFiles = null;
        if (cb != null) cb.onReceiveValue(uris);
        final KnowuraSession s = current.get();
        if (s == null) return;
        s.main.post(() -> {
            s.resuming = true;
            try {
                s.show(null, 0);
            } catch (RuntimeException ignored) {
                s.resuming = false;
            }
        });
    }

    @Override
    public void onHide() {
        super.onHide();
        showing = false;
        if (web != null) web.evaluateJavascript("window.knowuraHidden&&window.knowuraHidden()", null);
    }

    @Override
    public void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("KnowuraNative");
            web.destroy();
            web = null;
        }
        super.onDestroy();
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
        final KnowuraSession s = current.get();
        if (s == null) return;
        s.main.post(() -> {
            s.resuming = false;
            try {
                s.show(null, 0);
            } catch (RuntimeException ignored) {
                // the panel was closed meanwhile
            }
        });
    }

    /** Methods the page can call. They arrive on a WebView thread, so everything hops to the main thread. */
    private class Bridge {
        @JavascriptInterface
        public void hide() {
            main.post(KnowuraSession.this::hide);
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
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("https://" + HOST + safe));
                i.setPackage(getContext().getPackageName());
                if (openExternal(i)) hide();
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
