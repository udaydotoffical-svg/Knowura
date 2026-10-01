package com.knowura.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import androidx.core.content.FileProvider;
import java.io.File;

/** The assistant panel can't show a file picker itself, so it opens this invisible screen and gets the result back. */
public class FilePickActivity extends Activity {
    private static final int REQUEST = 1;
    private Uri shot;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getIntent().getBooleanExtra("capture", false) && openCamera(savedInstanceState)) return;
        Intent get = new Intent(Intent.ACTION_GET_CONTENT)
                .setType(getIntent().getBooleanExtra("images", false) ? "image/*" : "*/*")
                .addCategory(Intent.CATEGORY_OPENABLE)
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, getIntent().getBooleanExtra("multiple", true));
        try {
            startActivityForResult(Intent.createChooser(get, "Attach to Knowura"), REQUEST);
        } catch (RuntimeException e) {
            KnowuraSession.deliverFiles(null);
            finish();
        }
    }

    /** Opens the phone's own camera app (no camera permission needed); the picture lands in our cache and comes back as a content Uri. */
    private boolean openCamera(Bundle saved) {
        try {
            File dir = new File(getCacheDir(), "captures");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) if (System.currentTimeMillis() - f.lastModified() > 3600_000L) f.delete();
            File file = File.createTempFile("camera-", ".jpg", dir);
            shot = FileProvider.getUriForFile(this, getPackageName() + ".captures", file);
            Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                    .putExtra(MediaStore.EXTRA_OUTPUT, shot)
                    .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            cam.setClipData(ClipData.newRawUri("", shot));
            startActivityForResult(cam, REQUEST);
            return true;
        } catch (Exception e) {
            return false;   // no camera app: fall back to the normal picker
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        Uri[] picked = null;
        if (shot != null) {
            if (resultCode == RESULT_OK) picked = new Uri[]{shot};
        } else if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                picked = new Uri[clip.getItemCount()];
                for (int i = 0; i < picked.length; i++) picked[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                picked = new Uri[]{data.getData()};
            }
        }
        KnowuraSession.deliverFiles(picked);
        finish();
    }
}
