package app.joker.browser;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Собирает скрипт, который выполняется в каждом фрейме до скриптов сайта:
 * начальные флаги + мост между фреймами (bridge.js) + общая подмена (core.js из extension/).
 */
final class JokerScripts {
    private static String core = "";
    private static String bridge = "";

    private JokerScripts() {}

    static synchronized void init(Context ctx) {
        if (!core.isEmpty()) return;
        core = read(ctx, "js/core.js");
        bridge = read(ctx, "js/bridge.js");
    }

    static String build(boolean focus, boolean fullscreen, String nonce) {
        String prelude = "(function(){var K=Symbol.for('wnd.s');"
                + "var S=window[K]||Object.defineProperty(window,K,{value:{focus:false,fullscreen:false},configurable:true})[K];"
                + "S.focus=" + focus + ";S.fullscreen=" + fullscreen + ";})();\n";
        return prelude + bridge.replace("__NONCE__", nonce) + "\n" + core;
    }

    /** Живое переключение уже открытой страницы (в главном фрейме; во вложенные доходит через bridge.js). */
    static String liveUpdate(boolean focus, boolean fullscreen) {
        return "window.dispatchEvent(new CustomEvent('wnd:s',{detail:{focus:" + focus
                + ",fullscreen:" + fullscreen + "}}));";
    }

    private static String read(Context ctx, String path) {
        try (InputStream in = ctx.getAssets().open(path); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("Не найден asset " + path, e);
        }
    }
}
