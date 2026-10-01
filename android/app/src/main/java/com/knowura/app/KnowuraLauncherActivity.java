package com.knowura.app;

import android.net.Uri;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

/** Opens the site like the stock launcher, but adds this install's id (?kwdev=...) so the site can link it to your account. */
public class KnowuraLauncherActivity extends LauncherActivity {
    @Override
    protected Uri getLaunchingUrl() {
        Uri url = super.getLaunchingUrl();
        if (url == null || !"knowura.vercel.app".equals(url.getHost())) return url;
        return url.buildUpon().appendQueryParameter("kwdev", InstallId.get(this)).build();
    }
}
