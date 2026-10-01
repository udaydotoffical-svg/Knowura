package com.knowura.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/** The assistant panel can't show a file picker itself, so it opens this invisible screen and gets the result back. */
public class FilePickActivity extends Activity {
    private static final int REQUEST = 1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        Uri[] picked = null;
        if (resultCode == RESULT_OK && data != null) {
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
