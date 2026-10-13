package space.dartmeadow.game;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

/** DART Meadow for Android: a full-screen WebView around https://dartmeadow.space (the game updates itself, no APK update needed). */
public class Main extends Activity {
    static final String HOME = "https://dartmeadow.space/";
    WebView web; FrameLayout root; View custom; WebChromeClient.CustomViewCallback customCb; long lastBack = 0;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this); root.setBackgroundColor(Color.parseColor("#10081A"));
        web = new WebView(this); web.setBackgroundColor(Color.parseColor("#10081A"));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1)); setContentView(root);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); s.setAllowFileAccess(false); s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setLoadWithOverviewMode(true); s.setUseWideViewPort(true); s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " DartMeadowAndroid/1.0");
        web.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface public void exit() { runOnUiThread(new Runnable() { public void run() { if (android.os.Build.VERSION.SDK_INT >= 21) finishAndRemoveTask(); else finish(); } }); }
            @android.webkit.JavascriptInterface public String platform() { return "android"; }
            @android.webkit.JavascriptInterface public String version() { return "1.0"; }
        }, "DMAndroid");
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl(); String h = u.getHost() == null ? "" : u.getHost();
                if (h.equals("dartmeadow.space") || h.endsWith(".dartmeadow.space") || h.endsWith("radicaldeepscale.com") || h.endsWith("firebaseapp.com") || h.endsWith("googleapis.com") || h.endsWith("gstatic.com")) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) {} return true;
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) v.loadDataWithBaseURL(null, "<body style='background:#10081a;color:#cfe;font:18px sans-serif;text-align:center;padding-top:30vh'>DART Meadow needs a connection.<br><br><a href='" + HOME + "' style='color:#0ef'>Try again</a></body>", "text/html", "utf-8", null);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onShowCustomView(View v, CustomViewCallback cb) { custom = v; customCb = cb; root.addView(v, new FrameLayout.LayoutParams(-1, -1)); web.setVisibility(View.GONE); immersive(); }
            @Override public void onHideCustomView() { if (custom != null) { root.removeView(custom); custom = null; web.setVisibility(View.VISIBLE); if (customCb != null) customCb.onCustomViewHidden(); } }
            @Override public void onPermissionRequest(PermissionRequest r) { r.deny(); }
        });
        Uri in = getIntent() == null ? null : getIntent().getData();
        web.loadUrl(in != null ? in.toString() : HOME);
    }
    void immersive() { getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION); }
    @Override public void onWindowFocusChanged(boolean f) { super.onWindowFocusChanged(f); if (f) immersive(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); web.resumeTimers(); immersive(); }
    @Override protected void onPause() { web.onPause(); super.onPause(); }
    @Override protected void onNewIntent(Intent i) { super.onNewIntent(i); if (i.getData() != null) web.loadUrl(i.getData().toString()); }
    @Override public void onBackPressed() {
        if (custom != null) { web.getWebChromeClient().onHideCustomView(); return; }
        long n = System.currentTimeMillis();
        if (n - lastBack < 1800) { finish(); return; }
        lastBack = n; Toast.makeText(this, "Press back again to leave DART Meadow", Toast.LENGTH_SHORT).show();
        web.evaluateJavascript("window.dispatchEvent(new Event('androidback'))", null);
    }
    @Override protected void onDestroy() { if (web != null) { root.removeAllViews(); web.destroy(); } super.onDestroy(); }
}
