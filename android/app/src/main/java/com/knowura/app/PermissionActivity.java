package com.knowura.app;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;

/** An assistant panel can't show permission prompts itself, so it opens this invisible screen to ask once (microphone). */
public class PermissionActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String permission = Manifest.permission.RECORD_AUDIO;
        if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
            KnowuraSession.permissionDone();
            finish();
        } else {
            requestPermissions(new String[]{permission}, 1);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        KnowuraSession.permissionDone();   // bring the panel back, as listening if it was allowed
        finish();
    }
}
