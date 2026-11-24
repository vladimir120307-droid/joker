package app.joker.browser;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

/**
 * Страница ошибки без состояния: сама ошибка зашита в адрес https://appassets.../error?u=...&d=...,
 * поэтому «обновить» и «назад» работают предсказуемо, а в адресной строке виден исходный адрес.
 */
final class ErrorPages {
    private static final String PATH = "/error";
    private static final String PREFIX = "https://" + UrlUtils.ASSET_HOST + PATH + "?";

    private ErrorPages() {}

    static String urlFor(String failingUrl, String description) {
        return PREFIX + "u=" + Uri.encode(failingUrl) + "&d=" + Uri.encode(description == null ? "" : description);
    }

    static boolean isErrorUrl(String url) {
        return url != null && url.startsWith(PREFIX);
    }

    static boolean isErrorUri(Uri uri) {
        return UrlUtils.ASSET_HOST.equals(uri.getHost()) && PATH.equals(uri.getPath());
    }

    /** Адрес сайта, который не открылся. */
    static String targetOf(String errorUrl) {
        String t = Uri.parse(errorUrl).getQueryParameter("u");
        return t == null ? "" : t;
    }

    static WebResourceResponse response(Context ctx, Uri uri) {
        String target = orEmpty(uri.getQueryParameter("u"));
        String desc = orEmpty(uri.getQueryParameter("d"));
        String title = ctx.getString(R.string.err_title);
        StringBuilder sb = new StringBuilder(1024);
        sb.append("<!doctype html><html><head><meta charset=utf-8>")
                .append("<meta name=viewport content=\"width=device-width,initial-scale=1\">")
                .append("<title>").append(esc(title)).append("</title><style>")
                .append(":root{color-scheme:light dark}")
                .append("body{font:16px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh}")
                .append("main{max-width:520px;padding:24px}h1{font-size:22px;font-weight:500;margin:0 0 14px}")
                .append("p{color:GrayText;margin:8px 0;word-break:break-all}")
                .append(".b{display:inline-block;margin-top:18px;padding:10px 22px;border-radius:20px;")
                .append("background:#1a73e8;color:#fff;text-decoration:none}")
                .append("</style></head><body><main><h1>").append(esc(title)).append("</h1>")
                .append("<p>").append(esc(target)).append("</p>")
                .append("<p>").append(esc(explain(desc))).append("</p>");
        if (target.startsWith("http://") || target.startsWith("https://")) {
            sb.append("<a class=b href=\"").append(esc(target)).append("\">")
                    .append(esc(ctx.getString(R.string.err_retry))).append("</a>");
        }
        sb.append("</main></body></html>");
        return new WebResourceResponse("text/html", "UTF-8",
                new ByteArrayInputStream(sb.toString().getBytes(StandardCharsets.UTF_8)));
    }

    private static String explain(String desc) {
        String d = desc.toUpperCase(java.util.Locale.ROOT);
        String text;
        if (d.contains("NAME_NOT_RESOLVED")) text = "Не удаётся найти адрес сервера.";
        else if (d.contains("INTERNET_DISCONNECTED") || d.contains("NETWORK_CHANGED")) text = "Нет подключения к интернету.";
        else if (d.contains("CONNECTION_REFUSED")) text = "Сервер отказал в соединении.";
        else if (d.contains("TIMED_OUT")) text = "Сервер слишком долго не отвечает.";
        else if (d.contains("CONNECTION_RESET") || d.contains("CONNECTION_CLOSED")) text = "Соединение было прервано.";
        else if (d.contains("CERT") || d.contains("SSL")) text = "Сертификат сайта недействителен, соединение небезопасно.";
        else if (d.contains("UNSAFE_PORT") || d.contains("BLOCKED")) text = "Браузер заблокировал это соединение из соображений безопасности.";
        else text = "Не удалось открыть страницу.";
        return desc.isEmpty() ? text : text + " (" + desc + ")";
    }

    private static String orEmpty(String s) {
        return s == null ? "" : s;
    }

    private static String esc(String s) {
        StringBuilder out = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&': out.append("&amp;"); break;
                case '<': out.append("&lt;"); break;
                case '>': out.append("&gt;"); break;
                case '"': out.append("&quot;"); break;
                case '\'': out.append("&#39;"); break;
                default: out.append(c);
            }
        }
        return out.toString();
    }
}
