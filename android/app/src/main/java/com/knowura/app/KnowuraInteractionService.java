package com.knowura.app;

import android.service.voice.VoiceInteractionService;

/** Entry point the system keeps bound while Knowura is the default digital assistant. It can also bring the panel back on screen. */
public class KnowuraInteractionService extends VoiceInteractionService {
    private static volatile KnowuraInteractionService instance;

    @Override
    public void onReady() {
        super.onReady();
        instance = this;
    }

    @Override
    public void onShutdown() {
        instance = null;
        super.onShutdown();
    }

    /** Shows the assistant panel again (reusing the hidden session or starting a new one). False if the service isn't ready. */
    static boolean showPanel() {
        KnowuraInteractionService s = instance;
        if (s == null) return false;
        try {
            s.showSession(null, 0);
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }
}
