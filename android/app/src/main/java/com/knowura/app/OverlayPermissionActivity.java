package com.knowura.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;

/**
 * The floating bubble needs "Display over other apps". The panel can't show that settings screen itself, so it opens this
 * invisible screen: it sends you to the switch, and when you come back it shows the bubble (or the panel if you said no).
 */
public class OverlayPermissionActivity extends Activity {
    private static final int REQUEST = 7;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Settings.canDrawOverlays(this)) {
            BubbleService.show(this);
            finish();
            return;
        }
        try {
            startActivityForResult(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())), REQUEST);
        } catch (RuntimeException e) {
            KnowuraSession.reopen(true);
            finish();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (Settings.canDrawOverlays(this)) BubbleService.show(this);
        else KnowuraSession.reopen(true);   // not allowed: back to the panel
        finish();
    }
}
