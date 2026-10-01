package com.knowura.app;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;

/**
 * Listens to the microphone with Android itself (not the web view, whose getUserMedia was failing). It watches the
 * volume, and when you speak and then pause it hands back one short WAV clip. After each clip it stops listening
 * until the page arms it again, so the app can think and talk without hearing itself.
 */
final class NativeMic {
    interface Listener {
        void onLevel(float rms);

        void onClip(byte[] wav);
    }

    private static final int RATE = 16000;
    private static final int FRAME = 320;                 // 20 ms
    private static final int PRE_ROLL_FRAMES = 15;        // keep 300 ms from before the voice started
    private static final long SILENCE_MS = 900, MAX_MS = 20000;
    private static final int MIN_LOUD_FRAMES = 8;         // about 160 ms of actual speech
    private static final int GAIN = 3;                    // phone microphones are quiet at arm's length

    private volatile boolean running;
    private volatile boolean armed;
    private Thread thread;
    private AudioRecord rec;

    boolean start(final Listener listener) {
        if (running) return true;
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) return false;
        int size = Math.max(min, FRAME * 2 * 16);
        AudioRecord r = null;
        for (int source : new int[]{MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC}) {
            try {
                AudioRecord candidate = new AudioRecord(source, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size);
                if (candidate.getState() == AudioRecord.STATE_INITIALIZED) {
                    candidate.startRecording();
                    if (candidate.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                        r = candidate;
                        break;
                    }
                }
                candidate.release();
            } catch (RuntimeException ignored) {
                // try the next source
            }
        }
        if (r == null) return false;
        rec = r;
        running = true;
        armed = true;
        thread = new Thread(() -> loop(listener), "knowura-mic");
        thread.start();
        return true;
    }

    void arm(boolean on) {
        armed = on;
    }

    void stop() {
        running = false;
        armed = false;
        Thread t = thread;
        thread = null;
        if (t != null) {
            try {
                t.join(400);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        release();
    }

    private synchronized void release() {
        AudioRecord r = rec;
        rec = null;
        if (r != null) {
            try {
                r.stop();
            } catch (RuntimeException ignored) {
                // already stopped
            }
            r.release();
        }
    }

    private void loop(Listener listener) {
        AudioRecord r = rec;
        short[] frame = new short[FRAME];
        ArrayDeque<short[]> pre = new ArrayDeque<>();
        ByteArrayOutputStream clip = new ByteArrayOutputStream();
        boolean capturing = false;
        long startedAt = 0, lastLoud = 0, lastLevel = 0;
        int loudFrames = 0;
        double noise = 0.008;
        while (running && r != null) {
            int n = r.read(frame, 0, FRAME);
            if (n <= 0) {
                if (n < 0) break;   // the device went away
                continue;
            }
            for (int i = 0; i < n; i++) {
                int boosted = frame[i] * GAIN;
                frame[i] = (short) Math.max(-32768, Math.min(32767, boosted));
            }
            double sum = 0;
            for (int i = 0; i < n; i++) {
                double v = frame[i] / 32768.0;
                sum += v * v;
            }
            double rms = Math.sqrt(sum / n);
            long now = System.currentTimeMillis();
            if (now - lastLevel > 60) {
                lastLevel = now;
                listener.onLevel((float) rms);
            }
            if (!armed) {
                capturing = false;
                clip.reset();
                pre.clear();
                loudFrames = 0;
                continue;
            }
            // follows the room's background noise so a quiet voice still counts and a loud room doesn't
            double threshold = Math.max(0.02, noise * 2.6);
            boolean loud = rms > threshold;
            if (!capturing) {
                if (!loud) noise = noise * 0.95 + rms * 0.05;
                short[] copy = new short[n];
                System.arraycopy(frame, 0, copy, 0, n);
                pre.addLast(copy);
                while (pre.size() > PRE_ROLL_FRAMES) pre.removeFirst();
                if (loud) {
                    capturing = true;
                    startedAt = lastLoud = now;
                    loudFrames = 1;
                    clip.reset();
                    for (short[] f : pre) append(clip, f, f.length);
                    pre.clear();
                }
            } else {
                append(clip, frame, n);
                if (loud) {
                    lastLoud = now;
                    loudFrames++;
                }
                if (now - lastLoud > SILENCE_MS || now - startedAt > MAX_MS) {
                    capturing = false;
                    if (loudFrames >= MIN_LOUD_FRAMES) {
                        armed = false;   // one clip at a time; the page re-arms after it has answered
                        listener.onClip(wav(clip.toByteArray()));
                    }
                    clip.reset();
                    loudFrames = 0;
                }
            }
        }
    }

    private static void append(ByteArrayOutputStream out, short[] samples, int n) {
        for (int i = 0; i < n; i++) {
            out.write(samples[i] & 0xff);
            out.write((samples[i] >> 8) & 0xff);
        }
    }

    private static byte[] wav(byte[] pcm) {
        int len = pcm.length;
        byte[] out = new byte[44 + len];
        put(out, 0, "RIFF");
        le32(out, 4, 36 + len);
        put(out, 8, "WAVE");
        put(out, 12, "fmt ");
        le32(out, 16, 16);
        out[20] = 1;
        out[22] = 1;
        le32(out, 24, RATE);
        le32(out, 28, RATE * 2);
        out[32] = 2;
        out[34] = 16;
        put(out, 36, "data");
        le32(out, 40, len);
        System.arraycopy(pcm, 0, out, 44, len);
        return out;
    }

    private static void put(byte[] b, int at, String s) {
        for (int i = 0; i < s.length(); i++) b[at + i] = (byte) s.charAt(i);
    }

    private static void le32(byte[] b, int at, int v) {
        b[at] = (byte) v;
        b[at + 1] = (byte) (v >> 8);
        b[at + 2] = (byte) (v >> 16);
        b[at + 3] = (byte) (v >> 24);
    }
}
