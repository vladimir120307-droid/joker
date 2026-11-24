package app.joker.browser;

import android.app.Activity;
import android.net.Uri;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;

/** То, что вкладкам нужно от главного экрана. */
interface BrowserHost {
    Activity activity();

    /** Состояние вкладки изменилось: заголовок, адрес, прогресс, режимы. */
    void onTabChanged(BrowserTab tab);

    /** Открывает вкладку. url может быть null — тогда страница придёт через WebViewTransport (window.open). */
    BrowserTab openTab(String url, boolean activate, BrowserTab opener);

    void closeTab(BrowserTab tab);

    /** Процесс отрисовки вкладки аварийно завершился. */
    void onRenderGone(BrowserTab tab);

    boolean pickFiles(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params);

    /**
     * Спрашивает пользователя о разрешении сайту и, если нужно, о системном разрешении Android.
     * anyOf — достаточно любого из системных разрешений (геопозиция: точная или приблизительная).
     */
    void requestSitePermission(String origin, String what, String[] androidPermissions,
                               boolean anyOf, PermissionResult result);

    void showCustomView(View view, WebChromeClient.CustomViewCallback callback);

    void hideCustomView();

    void startDownload(BrowserTab tab, String url, String userAgent, String contentDisposition, String mimeType);

    interface PermissionResult {
        void done(boolean granted);
    }
}
