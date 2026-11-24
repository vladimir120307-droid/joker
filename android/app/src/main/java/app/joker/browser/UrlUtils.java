package app.joker.browser;

import android.net.Uri;

import java.util.Locale;
import java.util.regex.Pattern;

/** Разбор того, что ввели в адресную строку, и вспомогательные функции для адресов. */
final class UrlUtils {
    /** Виртуальный домен, который WebViewAssetLoader отдаёт из assets приложения. */
    static final String ASSET_HOST = "appassets.androidplatform.net";
    static final String NEWTAB_URL = "https://" + ASSET_HOST + "/assets/newtab.html";
    static final String SEARCH_URL = "https://www.google.com/search?q=";

    private static final Pattern LOCAL = Pattern.compile(
            "^(localhost|\\d{1,3}(\\.\\d{1,3}){3})(:\\d+)?([/?#].*)?$", Pattern.CASE_INSENSITIVE);
    private static final Pattern DOMAINISH = Pattern.compile(
            "^[^\\s/?#@]+\\.[^\\s/?#@.]{2,}(:\\d+)?([/?#]\\S*)?$");

    private UrlUtils() {}

    /** Превращает ввод пользователя в адрес: ссылка, локальный адрес, домен или поисковый запрос. */
    static String fromInput(String raw) {
        String text = raw == null ? "" : raw.trim();
        if (text.isEmpty()) return NEWTAB_URL;
        String lower = text.toLowerCase(Locale.ROOT);
        if (lower.startsWith("http://") || lower.startsWith("https://")) return text;
        if (lower.equals("about:blank")) return text;
        if (LOCAL.matcher(text).matches()) return "http://" + text;
        if (DOMAINISH.matcher(text).matches()) return "https://" + text;
        return SEARCH_URL + Uri.encode(text);
    }

    static boolean isNewTab(String url) {
        return NEWTAB_URL.equals(url);
    }

    static String hostOf(String url) {
        try {
            String h = Uri.parse(url).getHost();
            return h == null ? "" : h;
        } catch (RuntimeException e) {
            return "";
        }
    }

    static String originOf(String url) {
        try {
            Uri u = Uri.parse(url);
            if (u.getScheme() == null || u.getHost() == null) return url;
            int port = u.getPort();
            return u.getScheme() + "://" + u.getHost() + (port == -1 ? "" : ":" + port);
        } catch (RuntimeException e) {
            return url;
        }
    }

    /** Короткая форма для адресной строки: без схемы и «www.». */
    static String shortForm(String url) {
        if (url == null) return "";
        String s = url;
        if (s.startsWith("https://")) s = s.substring(8);
        else if (s.startsWith("http://")) s = s.substring(7);
        if (s.startsWith("www.")) s = s.substring(4);
        if (s.endsWith("/") && s.indexOf('/') == s.length() - 1) s = s.substring(0, s.length() - 1);
        return s;
    }
}
