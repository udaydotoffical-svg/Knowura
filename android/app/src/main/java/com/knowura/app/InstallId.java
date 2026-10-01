package com.knowura.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import java.security.SecureRandom;

/** A random secret that identifies this install. The site links it to your account so the assistant panel can use your sign-in. */
final class InstallId {
    private static final String PREFS = "knowura";
    private static final String KEY = "install_id";

    private InstallId() {
    }

    static synchronized String get(Context context) {
        SharedPreferences prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String id = prefs.getString(KEY, null);
        if (id == null || id.length() < 22) {
            byte[] bytes = new byte[24];
            new SecureRandom().nextBytes(bytes);
            id = Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            prefs.edit().putString(KEY, id).apply();
        }
        return id;
    }
}
