package com.knowura.app;

import android.animation.ValueAnimator;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Shader;
import android.os.Build;
import android.os.IBinder;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;

/**
 * The minimised assistant: a small floating bubble with Knowura's logo drawn over other apps (needs "Display over other apps").
 * Drag it anywhere, it snaps to the nearest edge; tap to bring the panel back; drag it onto the X to dismiss it.
 * Everything underneath stays fully usable.
 */
public class BubbleService extends Service {
    private static volatile BubbleService instance;

    private WindowManager wm;
    private BubbleView bubble;
    private TargetView target;
    private WindowManager.LayoutParams lp, targetLp;
    private int size, screenW, screenH, margin;

    static void show(Context c) {
        try {
            c.startService(new Intent(c, BubbleService.class));
        } catch (RuntimeException ignored) {
            // can't start right now
        }
    }

    /** Removes the bubble (the panel is on screen again). */
    static void hide() {
        BubbleService s = instance;
        if (s != null) {
            s.removeAll();
            s.stopSelf();
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        addBubble();
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        removeAll();
        if (instance == this) instance = null;
        super.onDestroy();
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private int overlayType() {
        return Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
    }

    private void addBubble() {
        if (bubble != null) return;
        DisplayMetrics dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);
        screenW = dm.widthPixels;
        screenH = dm.heightPixels;
        size = dp(58);
        margin = dp(6);

        SharedPreferences prefs = getSharedPreferences("bubble", MODE_PRIVATE);
        int x = prefs.getInt("x", screenW - size - margin);
        int y = prefs.getInt("y", (int) (screenH * 0.35f));
        lp = new WindowManager.LayoutParams(size, size, overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = clamp(x, 0, screenW - size);
        lp.y = clamp(y, dp(24), screenH - size - dp(24));

        bubble = new BubbleView(this);
        bubble.setContentDescription("Knowura. Tap to open, drag to move.");
        bubble.setOnTouchListener(new Touch());
        try {
            wm.addView(bubble, lp);
            bubble.setScaleX(0f);
            bubble.setScaleY(0f);
            bubble.animate().scaleX(1f).scaleY(1f).setDuration(260).setInterpolator(new android.view.animation.OvershootInterpolator(1.6f)).start();
        } catch (RuntimeException e) {
            bubble = null;   // overlay permission was withdrawn
            stopSelf();
        }
    }

    private void showTarget() {
        if (target != null) return;
        int t = dp(64);
        targetLp = new WindowManager.LayoutParams(t, t, overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        targetLp.gravity = Gravity.TOP | Gravity.START;
        targetLp.x = (screenW - t) / 2;
        targetLp.y = screenH - t - dp(96);
        target = new TargetView(this);
        try {
            wm.addView(target, targetLp);
            target.setAlpha(0f);
            target.animate().alpha(1f).setDuration(160).start();
        } catch (RuntimeException e) {
            target = null;
        }
    }

    private void hideTarget() {
        if (target == null) return;
        try {
            wm.removeView(target);
        } catch (RuntimeException ignored) {
            // already gone
        }
        target = null;
    }

    private boolean overTarget() {
        if (target == null) return false;
        float bx = lp.x + size / 2f, by = lp.y + size / 2f;
        float tx = targetLp.x + targetLp.width / 2f, ty = targetLp.y + targetLp.height / 2f;
        return Math.hypot(bx - tx, by - ty) < dp(70);
    }

    private void removeAll() {
        hideTarget();
        if (bubble != null) {
            try {
                wm.removeView(bubble);
            } catch (RuntimeException ignored) {
                // already gone
            }
            bubble = null;
        }
    }

    private void savePosition() {
        getSharedPreferences("bubble", MODE_PRIVATE).edit().putInt("x", lp.x).putInt("y", lp.y).apply();
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    private void snapToEdge() {
        final int from = lp.x;
        final int to = (lp.x + size / 2 < screenW / 2) ? margin : screenW - size - margin;
        ValueAnimator a = ValueAnimator.ofInt(from, to);
        a.setDuration(240);
        a.setInterpolator(new DecelerateInterpolator(1.6f));
        a.addUpdateListener(v -> {
            if (bubble == null) return;
            lp.x = (int) v.getAnimatedValue();
            try {
                wm.updateViewLayout(bubble, lp);
            } catch (RuntimeException ignored) {
                // removed meanwhile
            }
        });
        a.start();
        savePosition();
    }

    private void expand() {
        removeAll();
        stopSelf();
        KnowuraSession.reopen(true);   // the panel comes back as it was
    }

    private void dismiss() {
        if (bubble != null) bubble.animate().scaleX(0f).scaleY(0f).alpha(0f).setDuration(160).withEndAction(() -> {
            removeAll();
            stopSelf();
        }).start();
        else stopSelf();
    }

    private class Touch implements View.OnTouchListener {
        private float downX, downY;
        private int startX, startY;
        private boolean dragging;

        @Override
        public boolean onTouch(View v, MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = e.getRawX();
                    downY = e.getRawY();
                    startX = lp.x;
                    startY = lp.y;
                    dragging = false;
                    bubble.animate().scaleX(0.92f).scaleY(0.92f).setDuration(90).start();
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                    if (!dragging && Math.hypot(dx, dy) > dp(8)) {
                        dragging = true;
                        showTarget();
                    }
                    if (dragging) {
                        lp.x = clamp((int) (startX + dx), 0, screenW - size);
                        lp.y = clamp((int) (startY + dy), dp(24), screenH - size);
                        try {
                            wm.updateViewLayout(bubble, lp);
                        } catch (RuntimeException ignored) {
                            // removed meanwhile
                        }
                        boolean over = overTarget();
                        if (target != null) target.setHot(over);
                        bubble.animate().scaleX(over ? 0.7f : 1f).scaleY(over ? 0.7f : 1f).setDuration(90).start();
                    }
                    return true;
                }
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    bubble.animate().scaleX(1f).scaleY(1f).setDuration(120).start();
                    if (!dragging) {
                        if (e.getActionMasked() == MotionEvent.ACTION_UP) expand();
                    } else {
                        boolean gone = overTarget();
                        hideTarget();
                        if (gone) dismiss();
                        else snapToEdge();
                    }
                    return true;
                default:
                    return false;
            }
        }
    }

    /** Knowura's own logo (the pencil K, same artwork as the app icon) in a round bubble with a glowing ring. */
    private static class BubbleView extends View {
        private final Paint glow = new Paint(Paint.ANTI_ALIAS_FLAG), logo = new Paint(Paint.ANTI_ALIAS_FLAG), ring = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Bitmap art;
        private final Matrix m = new Matrix();

        BubbleView(Context c) {
            super(c);
            setLayerType(LAYER_TYPE_SOFTWARE, null);   // needed for the glow
            art = BitmapFactory.decodeResource(c.getResources(), R.drawable.ic_launcher_foreground);
            glow.setColor(0xFF0F2A80);
            glow.setShadowLayer(14f, 0f, 3f, 0xAA22E5FF);
            ring.setStyle(Paint.Style.STROKE);
            ring.setStrokeWidth(3.5f);
            ring.setColor(0xCC22E5FF);
            if (art != null) logo.setShader(new BitmapShader(art, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
        }

        @Override
        protected void onDraw(Canvas c) {
            float w = getWidth(), h = getHeight(), cx = w / 2f, cy = h / 2f, rad = Math.min(w, h) / 2f - 8f;
            c.drawCircle(cx, cy, rad, glow);   // the glow, and the fill if the artwork can't load
            if (art != null) {
                // the K sits in the middle of the artwork; scale it so the pencil-K fills the circle nicely
                float scale = (2f * rad * 1.32f) / art.getWidth();
                m.reset();
                m.postScale(scale, scale);
                m.postTranslate(cx - art.getWidth() * scale / 2f, cy - art.getHeight() * scale / 2f);
                logo.getShader().setLocalMatrix(m);
                c.drawCircle(cx, cy, rad, logo);
            }
            c.drawCircle(cx, cy, rad - 1.75f, ring);
        }
    }

    /** The "drop here to dismiss" circle with a pixel X (the same 21x21 pixel grid as the app's Pixel icons). */
    private static class TargetView extends View {
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG), x = new Paint();
        private boolean hot;

        TargetView(Context c) {
            super(c);
            fill.setColor(0xCC10162B);
            x.setColor(0xFFFFFFFF);   // no anti-aliasing: hard pixel edges
        }

        void setHot(boolean h) {
            if (hot == h) return;
            hot = h;
            animate().scaleX(h ? 1.25f : 1f).scaleY(h ? 1.25f : 1f).setDuration(110).start();
            fill.setColor(h ? 0xFFFF3057 : 0xCC10162B);
            invalidate();
        }

        @Override
        protected void onDraw(Canvas c) {
            float cx = getWidth() / 2f, cy = getHeight() / 2f, r = Math.min(cx, cy) - 2f;
            c.drawCircle(cx, cy, r, fill);
            // the X is drawn from square "pixels": a 21x21 grid, diagonal 2 cells thick, spanning about 60% of the circle
            float cell = (r * 1.2f) / 21f, ox = cx - cell * 10.5f, oy = cy - cell * 10.5f;
            for (int i = 0; i <= 14; i++) {
                int[][] cells = { { 3 + i, 3 + i }, { 4 + i, 3 + i }, { 18 - i, 3 + i }, { 17 - i, 3 + i } };
                for (int[] k : cells) c.drawRect(ox + k[0] * cell, oy + k[1] * cell, ox + (k[0] + 1) * cell, oy + (k[1] + 1) * cell, x);
            }
        }
    }
}
