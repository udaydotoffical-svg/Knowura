package com.knowura.app;

import android.app.Activity;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;

import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;

import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

/**
 * Google refuses its web sign-in page inside embedded web views, so the assistant panel signs in natively
 * (the phone's own account picker) and passes the resulting Google ID token to the page, which verifies it
 * with the Knowura server exactly like the website's own sign-in does.
 */
public class SignInActivity extends Activity {
    // the same web client id the site uses, so the server accepts the token
    private static final String WEB_CLIENT_ID = "21362482851-mj9pla405ejg3aqcvu8uve693u2ibjp8.apps.googleusercontent.com";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CredentialManager manager = CredentialManager.create(this);
        GetCredentialRequest request = new GetCredentialRequest.Builder()
                .addCredentialOption(new GetSignInWithGoogleOption.Builder(WEB_CLIENT_ID).build())
                .build();
        final Handler main = new Handler(Looper.getMainLooper());
        manager.getCredentialAsync(this, request, new CancellationSignal(), main::post,
                new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override
                    public void onResult(GetCredentialResponse result) {
                        Credential c = result.getCredential();
                        if (c instanceof CustomCredential
                                && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(c.getType())) {
                            GoogleIdTokenCredential g = GoogleIdTokenCredential.createFrom(((CustomCredential) c).getData());
                            KnowuraSession.deliverSignIn(g.getIdToken(), null);
                        } else {
                            KnowuraSession.deliverSignIn(null, "Google sent back something unexpected. Please try again.");
                        }
                        finish();
                    }

                    @Override
                    public void onError(GetCredentialException e) {
                        String msg;
                        if (e instanceof GetCredentialCancellationException) msg = "Sign-in cancelled.";
                        else if (e instanceof NoCredentialException) msg = "No Google account found on this phone. Add one in Settings, or sign in inside the Knowura app.";
                        else msg = "Google sign-in isn't available for this build yet. You can sign in inside the Knowura app instead.";
                        KnowuraSession.deliverSignIn(null, msg);
                        finish();
                    }
                });
    }
}
