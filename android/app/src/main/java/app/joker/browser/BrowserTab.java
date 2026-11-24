package app.joker.browser;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Bitmap;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.WebBackForwardList;
import android.webkit.WebHistoryItem;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.Collections;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Одна вкладка: WebView и её состояние, включая два режима. */
final class BrowserTab {
    private static final String TAG = "JokerTab";

    final int id;
    final WebView web;
    /** Случайная строка вкладки для сообщений между фреймами (см. bridge.js). */
    final String nonce = UUID.randomUUID().toString().replace("-", "");

    BrowserTab opener;
    String title = "";
    String url = "";
    Bitmap favicon;
    boolean loading;
    int progress;

    boolean fullscreenMode;
    boolean focusMode;
    boolean desktopMode;

    private final boolean profileBased;
    private ScriptHandler scriptHandler;

    BrowserTab(Activity activity, int id, String profileName, BrowserHost host, WebViewAssetLoader loader) {
        this.id = id;
        this.web = new WebView(activity);
        boolean usingProfile = false;
        if (profileName != null && WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try {
                WebViewCompat.setProfile(web, profileName);   // до первой загрузки
                usingProfile = true;
            } catch (RuntimeException ignored) {
                // профиль недоступен — работаем с общим
            }
        }
        this.profileBased = usingProfile;
        configure();
        web.setWebViewClient(new TabWebViewClient(host, this, loader));
        web.setWebChromeClient(new TabChromeClient(host, this));
        web.setDownloadListener((u, ua, cd, mime, len) -> host.startDownload(this, u, ua, cd, mime));
        installScript();
    }

    @SuppressLint("SetJavaScriptEnabled")
    @SuppressWarnings("deprecation")
    private void configure() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);   // окна без жеста пользователя не открываем
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setGeolocationEnabled(true);
        s.setUserAgentString(mobileUa(WebSettings.getDefaultUserAgent(web.getContext())));
    }

    // ---------- user-agent ----------

    /** Убираем пометки WebView ("; wv", "Version/4.0"), чтобы сайты считали браузер обычным Chrome. */
    static String mobileUa(String def) {
        return def.replace("; wv", "").replace(" Version/4.0", "");
    }

    static String desktopUa(String def) {
        Matcher m = Pattern.compile("Chrome/(\\d+)").matcher(def);
        String major = m.find() ? m.group(1) : "126";
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
                + major + ".0.0.0 Safari/537.36";
    }

    void setDesktop(boolean on) {
        desktopMode = on;
        WebSettings s = web.getSettings();
        String def = WebSettings.getDefaultUserAgent(web.getContext());
        s.setUserAgentString(on ? desktopUa(def) : mobileUa(def));
        s.setLoadWithOverviewMode(on);
        reloadOrRetry();
    }

    // ---------- навигация ----------

    void load(String target) {
        web.loadUrl(target);
    }

    void reloadOrRetry() {
        if (ErrorPages.isErrorUrl(url)) load(ErrorPages.targetOf(url));
        else web.reload();
    }

    /**
     * Куда вернёт «назад». Страница ошибки встаёт в историю после записи неудавшегося адреса; переход на эту
     * запись снова падает и снова рисует ошибку, из-за чего кнопка «назад» зацикливалась. Поэтому такие записи
     * пропускаем. Возвращает индекс записи истории или -1, если вернуться некуда.
     */
    private int backTargetIndex() {
        WebBackForwardList list = web.copyBackForwardList();
        WebHistoryItem now = list.getCurrentItem();
        String failing = null;
        if (now != null && ErrorPages.isErrorUrl(now.getUrl())) {
            failing = trimSlash(ErrorPages.targetOf(now.getUrl()));
        }
        for (int i = list.getCurrentIndex() - 1; i >= 0; i--) {
            WebHistoryItem item = list.getItemAtIndex(i);
            String u = item == null || item.getUrl() == null ? "" : item.getUrl();
            boolean skip = ErrorPages.isErrorUrl(u) || (failing != null && trimSlash(u).equals(failing));
            if (!skip) return i;
        }
        return -1;
    }

    boolean canGoBackSmart() {
        return backTargetIndex() >= 0;
    }

    boolean goBackSmart() {
        int target = backTargetIndex();
        if (target < 0) return false;
        web.goBackOrForward(target - web.copyBackForwardList().getCurrentIndex());
        return true;
    }

    private static String trimSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    /** Адрес для пользователя: пусто для новой вкладки, исходный адрес для страницы ошибки. */
    String displayUrl() {
        if (UrlUtils.isNewTab(url)) return "";
        if (ErrorPages.isErrorUrl(url)) return ErrorPages.targetOf(url);
        return url == null ? "" : url;
    }

    // ---------- режимы ----------

    private static boolean documentStartSupported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
    }

    /** (Пере)регистрирует скрипт, выполняемый в каждом новом документе и фрейме до скриптов сайта. */
    private void installScript() {
        if (!documentStartSupported()) return;
        if (scriptHandler != null) {
            scriptHandler.remove();
            scriptHandler = null;
        }
        scriptHandler = WebViewCompat.addDocumentStartJavaScript(
                web, JokerScripts.build(focusMode, fullscreenMode, nonce), Collections.singleton("*"));
    }

    /** Запасной путь для очень старых WebView без document-start скриптов (внедрение после начала загрузки). */
    void fallbackInject() {
        if (!documentStartSupported()) {
            web.evaluateJavascript(JokerScripts.build(focusMode, fullscreenMode, nonce), null);
        }
    }

    /** Применяет режимы: к новым документам — через перерегистрацию скрипта, к текущему — сразу. */
    void setModes(boolean focus, boolean fullscreen) {
        focusMode = focus;
        fullscreenMode = fullscreen;
        installScript();
        web.evaluateJavascript(JokerScripts.liveUpdate(focus, fullscreen), null);
    }

    /** Вкладка, открытая со страницы, наследует режимы той, откуда открыта (до начала загрузки). */
    void inheritModes(BrowserTab from) {
        focusMode = from.focusMode;
        fullscreenMode = from.fullscreenMode;
        installScript();
    }

    // ---------- приватность ----------

    private CookieManager cookies() {
        if (profileBased) {
            try {
                return WebViewCompat.getProfile(web).getCookieManager();
            } catch (RuntimeException ignored) {
                // откатываемся на общий
            }
        }
        return CookieManager.getInstance();
    }

    void applyCookiePolicy(boolean blockThirdParty) {
        CookieManager cm = cookies();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, !blockThirdParty);
    }

    String cookiesFor(String target) {
        return cookies().getCookie(target);
    }

    // ---------- жизненный цикл ----------

    /** Вкладка с режимом «скрыть» не усыпляется, когда приложение уходит в фон. */
    void onActivityPause() {
        if (!focusMode) web.onPause();
    }

    void onActivityResume() {
        web.onResume();
    }

    /**
     * Закрывает вкладку. Каждый шаг защищён отдельно: web.destroy() обязан выполниться, иначе WebView
     * останется «живым» и профиль приватного сеанса нельзя будет удалить.
     */
    void destroy() {
        step("stopLoading", web::stopLoading);
        step("removeScript", () -> {
            if (scriptHandler != null) scriptHandler.remove();
        });
        scriptHandler = null;
        step("clearData", () -> {
            web.clearCache(true);
            web.clearHistory();
            web.clearFormData();
        });
        step("detachClients", () -> {
            web.setWebChromeClient(null);
            web.setWebViewClient(new WebViewClient());
        });
        step("blank", () -> web.loadUrl("about:blank"));
        step("pause", () -> {
            web.onPause();
            web.removeAllViews();
        });
        step("destroy", web::destroy);
    }

    private static void step(String name, Runnable action) {
        try {
            action.run();
        } catch (RuntimeException e) {
            Log.w(TAG, "закрытие вкладки: шаг " + name + " не удался: " + e);
        }
    }
}
