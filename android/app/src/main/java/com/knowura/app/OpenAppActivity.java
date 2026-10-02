package com.knowura.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * Opens the Knowura app as a normal app, then disappears. The panel can only start screens in the assistant's own
 * stack, and an app started there stays parked in that stack: later, when the picker or camera screen closes, Android
 * would show that parked app behind the panel. This invisible hop starts the app in a regular task instead.
 */
public class OpenAppActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent in = getIntent();
        if (in != null && in.getData() != null) {
            Intent open = new Intent(Intent.ACTION_VIEW, in.getData())
                    .setPackage(getPackageName())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                startActivity(open);
            } catch (RuntimeException ignored) {
                // nothing can open it
            }
        }
        finish();
    }
}
