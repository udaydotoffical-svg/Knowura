package com.knowura.app;

import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.ResolveInfo;
import android.os.Bundle;
import android.os.RemoteException;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.SpeechRecognizer;

import java.util.List;

/**
 * Android makes the default assistant's recognition service the phone's speech recognizer (keyboard
 * dictation and so on), so this one hands every request to another installed recognizer instead of
 * breaking voice typing. Knowura does its own transcription inside the assistant panel.
 */
public class KnowuraRecognitionService extends RecognitionService {
    private SpeechRecognizer delegate;

    @Override
    protected void onStartListening(Intent intent, final Callback cb) {
        ComponentName target = findDelegate();
        if (target == null) {
            fail(cb, SpeechRecognizer.ERROR_CLIENT);
            return;
        }
        release();
        delegate = SpeechRecognizer.createSpeechRecognizer(this, target);
        delegate.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle p) { try { cb.readyForSpeech(p); } catch (RemoteException ignored) { } }
            @Override public void onBeginningOfSpeech() { try { cb.beginningOfSpeech(); } catch (RemoteException ignored) { } }
            @Override public void onRmsChanged(float v) { try { cb.rmsChanged(v); } catch (RemoteException ignored) { } }
            @Override public void onBufferReceived(byte[] b) { try { cb.bufferReceived(b); } catch (RemoteException ignored) { } }
            @Override public void onEndOfSpeech() { try { cb.endOfSpeech(); } catch (RemoteException ignored) { } }
            @Override public void onError(int e) { fail(cb, e); }
            @Override public void onResults(Bundle r) { try { cb.results(r); } catch (RemoteException ignored) { } }
            @Override public void onPartialResults(Bundle r) { try { cb.partialResults(r); } catch (RemoteException ignored) { } }
            @Override public void onEvent(int type, Bundle params) { }
        });
        delegate.startListening(intent);
    }

    @Override
    protected void onStopListening(Callback cb) {
        if (delegate != null) delegate.stopListening();
    }

    @Override
    protected void onCancel(Callback cb) {
        release();
    }

    @Override
    public void onDestroy() {
        release();
        super.onDestroy();
    }

    private void release() {
        if (delegate != null) {
            delegate.cancel();
            delegate.destroy();
            delegate = null;
        }
    }

    private static void fail(Callback cb, int error) {
        try {
            cb.error(error);
        } catch (RemoteException ignored) {
            // caller already gone
        }
    }

    /** Another installed recognizer (never this one), system apps first. */
    private ComponentName findDelegate() {
        List<ResolveInfo> found = getPackageManager().queryIntentServices(new Intent(RecognitionService.SERVICE_INTERFACE), 0);
        ComponentName fallback = null;
        for (ResolveInfo r : found) {
            if (r.serviceInfo == null || getPackageName().equals(r.serviceInfo.packageName)) continue;
            ComponentName c = new ComponentName(r.serviceInfo.packageName, r.serviceInfo.name);
            if ((r.serviceInfo.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0) return c;
            if (fallback == null) fallback = c;
        }
        return fallback;
    }
}
