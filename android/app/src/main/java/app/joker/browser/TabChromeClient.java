package app.joker.browser;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Message;
import android.view.View;
import android.webkit.GeolocationPermissions;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.FrameLayout;

import java.util.ArrayList;
import java.util.List;

/** Всё, что страница может «попросить» у браузера: диалоги, окна, файлы, разрешения, полноэкранное видео. */
final class TabChromeClient extends WebChromeClient {
    private final BrowserHost host;
    private final BrowserTab tab;

    TabChromeClient(BrowserHost host, BrowserTab tab) {
        this.host = host;
        this.tab = tab;
    }

    private Activity act() {
        return host.activity();
    }

    private boolean usable() {
        Activity a = act();
        return !(a.isFinishing() || a.isDestroyed());
    }

    // ---------- прогресс, заголовок, значок ----------

    @Override
    public void onProgressChanged(WebView view, int newProgress) {
        tab.progress = newProgress;
        tab.loading = newProgress < 100;
        host.onTabChanged(tab);
    }

    @Override
    public void onReceivedTitle(WebView view, String title) {
        tab.title = title == null ? "" : title;
        host.onTabChanged(tab);
    }

    @Override
    public void onReceivedIcon(WebView view, Bitmap icon) {
        tab.favicon = icon;
        host.onTabChanged(tab);
    }

    @Override
    public Bitmap getDefaultVideoPoster() {
        return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
    }

    // ---------- окна ----------

    @Override
    public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
        if (!isUserGesture) return false;   // всплывающие окна без жеста пользователя не открываем
        BrowserTab child = host.openTab(null, true, tab);
        WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
        transport.setWebView(child.web);   // window.opener продолжает работать (OAuth, оплата)
        resultMsg.sendToTarget();
        return true;
    }

    @Override
    public void onCloseWindow(WebView window) {
        host.closeTab(tab);
    }

    // ---------- диалоги JavaScript ----------

    @Override
    public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
        if (!usable()) {
            result.cancel();
            return true;
        }
        new AlertDialog.Builder(act())
                .setTitle(UrlUtils.hostOf(url))
                .setMessage(message)
                .setPositiveButton(R.string.ok, (d, w) -> result.confirm())
                .setOnCancelListener(d -> result.cancel())
                .show();
        return true;
    }

    @Override
    public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
        if (!usable()) {
            result.cancel();
            return true;
        }
        new AlertDialog.Builder(act())
                .setTitle(UrlUtils.hostOf(url))
                .setMessage(message)
                .setPositiveButton(R.string.ok, (d, w) -> result.confirm())
                .setNegativeButton(R.string.cancel, (d, w) -> result.cancel())
                .setOnCancelListener(d -> result.cancel())
                .show();
        return true;
    }

    @Override
    public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
        if (!usable()) {
            result.cancel();
            return true;
        }
        EditText input = new EditText(act());
        input.setSingleLine();
        input.setText(defaultValue == null ? "" : defaultValue);
        FrameLayout box = new FrameLayout(act());
        int pad = (int) (20 * act().getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad / 2, pad, 0);
        box.addView(input);
        new AlertDialog.Builder(act())
                .setTitle(UrlUtils.hostOf(url))
                .setMessage(message)
                .setView(box)
                .setPositiveButton(R.string.ok, (d, w) -> result.confirm(input.getText().toString()))
                .setNegativeButton(R.string.cancel, (d, w) -> result.cancel())
                .setOnCancelListener(d -> result.cancel())
                .show();
        return true;
    }

    @Override
    public boolean onJsBeforeUnload(WebView view, String url, String message, JsResult result) {
        if (!usable()) {
            result.cancel();
            return true;
        }
        new AlertDialog.Builder(act())
                .setMessage(R.string.leave_page)
                .setPositiveButton(R.string.leave, (d, w) -> result.confirm())
                .setNegativeButton(R.string.stay, (d, w) -> result.cancel())
                .setOnCancelListener(d -> result.cancel())
                .show();
        return true;
    }

    // ---------- файлы ----------

    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        return host.pickFiles(callback, params);
    }

    // ---------- разрешения сайта ----------

    @Override
    public void onPermissionRequest(PermissionRequest request) {
        act().runOnUiThread(() -> {
            List<String> resources = new ArrayList<>();
            List<String> system = new ArrayList<>();
            boolean camera = false;
            boolean mic = false;
            for (String r : request.getResources()) {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) {
                    resources.add(r);
                    system.add(Manifest.permission.CAMERA);
                    camera = true;
                } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                    resources.add(r);
                    system.add(Manifest.permission.RECORD_AUDIO);
                    mic = true;
                }
            }
            if (resources.isEmpty() || !usable()) {
                request.deny();
                return;
            }
            String what = act().getString(camera && mic ? R.string.perm_camera_mic
                    : camera ? R.string.perm_camera : R.string.perm_mic);
            host.requestSitePermission(request.getOrigin().toString(), what,
                    system.toArray(new String[0]), false, granted -> {
                        if (granted) request.grant(resources.toArray(new String[0]));
                        else request.deny();
                    });
        });
    }

    @Override
    public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
        if (!usable()) {
            callback.invoke(origin, false, false);
            return;
        }
        host.requestSitePermission(origin, act().getString(R.string.perm_location),
                new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION},
                true, granted -> callback.invoke(origin, granted, false));
    }

    // ---------- полноэкранное видео ----------

    @Override
    public void onShowCustomView(View view, CustomViewCallback callback) {
        host.showCustomView(view, callback);
    }

    @Override
    public void onHideCustomView() {
        host.hideCustomView();
    }
}
