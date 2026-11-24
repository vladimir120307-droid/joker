package app.joker.browser;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.view.ViewGroup;
import android.webkit.HttpAuthHandler;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;

import androidx.webkit.WebViewAssetLoader;

import java.net.URISyntaxException;
import java.util.Locale;

/** Навигация, ошибки и безопасность загрузки страниц. */
final class TabWebViewClient extends WebViewClient {
    private final BrowserHost host;
    private final BrowserTab tab;
    private final WebViewAssetLoader assetLoader;

    TabWebViewClient(BrowserHost host, BrowserTab tab, WebViewAssetLoader assetLoader) {
        this.host = host;
        this.tab = tab;
        this.assetLoader = assetLoader;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri u = request.getUrl();
        if (UrlUtils.ASSET_HOST.equals(u.getHost())) {
            if (ErrorPages.isErrorUri(u)) return ErrorPages.response(host.activity(), u);
            return assetLoader.shouldInterceptRequest(u);
        }
        return null;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return handleUrl(request.getUrl().toString(), request.hasGesture());
    }

    /** true — навигацию обработали сами (или заблокировали). */
    private boolean handleUrl(String url, boolean userGesture) {
        String scheme = Uri.parse(url).getScheme();
        if (scheme == null) return false;
        scheme = scheme.toLowerCase(Locale.ROOT);
        switch (scheme) {
            case "http":
            case "https":
            case "about":
            case "javascript":
            case "blob":
            case "data":
                return false;
            case "intent":
                if (userGesture) openIntentUrl(url);
                return true;
            case "mailto":
            case "tel":
            case "sms":
            case "smsto":
            case "geo":
            case "market":
            case "tg":
            case "whatsapp":
                if (userGesture) openExternal(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                return true;
            default:
                return true;   // всё остальное (file:, content:, чужие схемы) блокируем
        }
    }

    private void openIntentUrl(String url) {
        try {
            Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.setComponent(null);
            Intent selector = intent.getSelector();
            if (selector != null) {
                selector.addCategory(Intent.CATEGORY_BROWSABLE);
                selector.setComponent(null);
            }
            try {
                host.activity().startActivity(intent);
            } catch (ActivityNotFoundException e) {
                String fallback = intent.getStringExtra("browser_fallback_url");
                if (fallback != null && (fallback.startsWith("http://") || fallback.startsWith("https://"))) {
                    tab.load(fallback);
                }
            }
        } catch (URISyntaxException | RuntimeException ignored) {
            // некорректный intent: — игнорируем
        }
    }

    private void openExternal(Intent intent) {
        try {
            host.activity().startActivity(intent);
        } catch (ActivityNotFoundException ignored) {
            // нет приложения для этой ссылки
        }
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        tab.url = url;
        tab.title = "";
        tab.favicon = null;
        tab.loading = true;
        tab.fallbackInject();
        host.onTabChanged(tab);
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        tab.url = url;
        tab.loading = false;
        tab.progress = 100;
        host.onTabChanged(tab);
    }

    @Override
    public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
        tab.url = url;
        host.onTabChanged(tab);
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (!request.isForMainFrame()) return;
        String failing = request.getUrl().toString();
        if (ErrorPages.isErrorUrl(failing)) return;
        String desc = error.getDescription() == null ? "" : error.getDescription().toString();
        if (desc.contains("ERR_ABORTED")) return;   // пользователь сам прервал загрузку
        view.loadUrl(ErrorPages.urlFor(failing, desc));
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        handler.cancel();   // небезопасное соединение не продолжаем; причина покажется на странице ошибки
    }

    @Override
    public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String hostName, String realm) {
        Activity a = host.activity();
        if (a.isFinishing() || a.isDestroyed()) {
            handler.cancel();
            return;
        }
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (20 * a.getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad / 2, pad, 0);
        EditText user = new EditText(a);
        user.setHint(R.string.auth_user);
        user.setSingleLine();
        EditText pass = new EditText(a);
        pass.setHint(R.string.auth_pass);
        pass.setSingleLine();
        pass.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        box.addView(user, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        box.addView(pass, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        new AlertDialog.Builder(a)
                .setTitle(a.getString(R.string.auth_title, hostName))
                .setView(box)
                .setPositiveButton(R.string.sign_in, (d, w) -> handler.proceed(user.getText().toString(), pass.getText().toString()))
                .setNegativeButton(R.string.cancel, (d, w) -> handler.cancel())
                .setOnCancelListener(d -> handler.cancel())
                .show();
    }

    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        host.onRenderGone(tab);
        return true;   // без этого приложение упадёт вместе с процессом отрисовки
    }
}
