package com.knowura.app;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;

/** An assistant panel can't show permission prompts itself, so it opens this invisible screen to ask once (microphone or camera). */
public class PermissionActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String permission = "camera".equals(getIntent().getStringExtra("perm")) ? Manifest.permission.CAMERA : Manifest.permission.RECORD_AUDIO;
        if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
            finish();
        } else {
            requestPermissions(new String[]{permission}, 1);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        finish();
    }
}
