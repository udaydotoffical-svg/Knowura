package com.knowura.app;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Files the user just picked (or photographed) for the assistant panel. They are copied into the app's own cache
 * straight away, because Android may take back access to the picked file as soon as the picker closes, and the
 * panel can be a brand new window by the time it comes back. The page then fetches them from /__kw_file/N.
 */
final class PickedFiles {
    static final class Item {
        final File file;
        final String name;
        final String mime;

        Item(File file, String name, String mime) {
            this.file = file;
            this.name = name;
            this.mime = mime;
        }
    }

    private static final long MAX_BYTES = 40L * 1024 * 1024;
    private static final List<Item> items = new ArrayList<>();

    private PickedFiles() {
    }

    static synchronized void set(List<Item> list) {
        clear();
        items.addAll(list);
    }

    static synchronized int count() {
        return items.size();
    }

    static synchronized Item get(int i) {
        return i >= 0 && i < items.size() ? items.get(i) : null;
    }

    static synchronized void clear() {
        for (Item it : items) {
            //noinspection ResultOfMethodCallIgnored
            it.file.delete();
        }
        items.clear();
    }

    /** Copies each picked Uri into the cache (call off the main thread). Unreadable or huge files are skipped. */
    static List<Item> copyIn(Context ctx, Uri[] uris) {
        List<Item> out = new ArrayList<>();
        if (uris == null) return out;
        File dir = new File(ctx.getCacheDir(), "picked");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) if (System.currentTimeMillis() - f.lastModified() > 3600_000L) f.delete();
        ContentResolver cr = ctx.getContentResolver();
        int n = 0;
        for (Uri u : uris) {
            if (u == null) continue;
            String name = "file";
            try (Cursor c = cr.query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
            } catch (RuntimeException ignored) {
                // keep the generic name
            }
            String mime = cr.getType(u);
            if (mime == null) mime = "application/octet-stream";
            try (InputStream in = cr.openInputStream(u)) {
                if (in == null) continue;
                File f = new File(dir, "pick-" + System.currentTimeMillis() + "-" + (n++));
                long total = 0;
                boolean tooBig = false;
                try (FileOutputStream os = new FileOutputStream(f)) {
                    byte[] buf = new byte[64 * 1024];
                    int r;
                    while ((r = in.read(buf)) > 0) {
                        total += r;
                        if (total > MAX_BYTES) {
                            tooBig = true;
                            break;
                        }
                        os.write(buf, 0, r);
                    }
                }
                if (tooBig) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                    continue;
                }
                out.add(new Item(f, name, mime));
            } catch (Exception ignored) {
                // skip a file that can't be read
            }
        }
        return out;
    }
}
