package app.joker.browser;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.WebStorage;
import android.webkit.WebViewDatabase;

import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewFeature;

import java.io.File;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * Приватный сеанс. Если WebView умеет профили, на каждый запуск создаётся отдельный профиль
 * (cookie, кэш, localStorage, история). Если профилей нет, всё общее стирается вручную.
 *
 * Как профиль исчезает. ProfileStore.deleteProfile() в том же процессе, где профиль уже использовался,
 * всегда отвечает «профиль занят» (даже когда все WebView уничтожены), поэтому здесь три уровня:
 * 1) при завершении сеанса данные профиля стираются через его API (cookie, хранилище, геоданные);
 * 2) сразу после этого удаляется каталог профиля;
 * 3) при следующем запуске остатки (если приложение убили) удаляются штатным deleteProfile().
 */
final class PrivateSession {
    private static final String TAG = "JokerSession";
    private static final String PREFIX = "jk-";
    private static final String PROFILE_DIR_PREFIX = "Profile ";
    private static final int PURGE_ATTEMPTS = 5;
    private static final long PURGE_DELAY_MS = 1000;

    private final Context ctx;
    private final Handler handler = new Handler(Looper.getMainLooper());
    /** Завершённые профили: пробуем снять регистрацию, вдруг WebView уже отпустил профиль. */
    private final List<String> doomed = new ArrayList<>();
    private String profile;

    PrivateSession(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    void begin() {
        profile = null;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try {
                ProfileStore store = ProfileStore.getInstance();
                for (String name : store.getAllProfileNames()) {
                    if (name.startsWith(PREFIX) && !doomed.contains(name)) {
                        try {
                            store.deleteProfile(name);   // в свежем процессе срабатывает
                        } catch (RuntimeException e) {
                            Log.d(TAG, "остаточный профиль " + name + " пока не удалить: " + e);
                        }
                    }
                }
                deleteProfileDirs();   // каталоги без регистрации (осиротевшие)
                String name = PREFIX + Long.toHexString(new SecureRandom().nextLong());
                store.getOrCreateProfile(name);
                profile = name;
            } catch (RuntimeException e) {
                Log.w(TAG, "профили недоступны: " + e);
                profile = null;
            }
        }
        if (profile == null) wipeShared();
    }

    /** Имя профиля для новых вкладок или null, если профили не поддерживаются. */
    String profileName() {
        return profile;
    }

    /** Вызывать после уничтожения всех WebView и до begin() нового сеанса. */
    void end() {
        if (profile == null) {
            wipeShared();
            return;
        }
        String name = profile;
        profile = null;
        wipeProfileData(name);
        deleteProfileDirs();
        doomed.add(name);
        purge(0);
    }

    /** Стирает данные профиля через его собственные API. */
    private void wipeProfileData(String name) {
        try {
            Profile p = ProfileStore.getInstance().getProfile(name);
            if (p == null) return;
            CookieManager cookies = p.getCookieManager();
            cookies.removeAllCookies(null);
            cookies.flush();
            p.getWebStorage().deleteAllData();
            p.getGeolocationPermissions().clearAll();
        } catch (RuntimeException e) {
            Log.w(TAG, "не удалось стереть данные профиля " + name + ": " + e);
        }
    }

    /** Удаляет каталоги всех профилей приватных сеансов; вызывается, когда живого профиля нет. */
    private void deleteProfileDirs() {
        File[] kids = ctx.getDir("webview", Context.MODE_PRIVATE).listFiles();
        if (kids == null) return;
        for (File f : kids) {
            if (f.isDirectory() && f.getName().startsWith(PROFILE_DIR_PREFIX)) deleteTree(f);
        }
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteTree(k);
        }
        if (!f.delete() && f.exists()) Log.d(TAG, "не удалось удалить " + f);
    }

    private void purge(int attempt) {
        if (doomed.isEmpty()) return;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            doomed.clear();
            return;
        }
        ProfileStore store = ProfileStore.getInstance();
        for (Iterator<String> it = doomed.iterator(); it.hasNext(); ) {
            String name = it.next();
            try {
                store.deleteProfile(name);
                it.remove();
            } catch (RuntimeException e) {
                Log.d(TAG, "профиль " + name + " ещё занят, попытка " + attempt);
            }
        }
        if (!doomed.isEmpty() && attempt < PURGE_ATTEMPTS) {
            handler.postDelayed(() -> purge(attempt + 1), PURGE_DELAY_MS);
        }
    }

    @SuppressWarnings("deprecation")
    private void wipeShared() {
        CookieManager cm = CookieManager.getInstance();
        cm.removeAllCookies(null);
        cm.flush();
        WebStorage.getInstance().deleteAllData();
        WebViewDatabase.getInstance(ctx).clearHttpAuthUsernamePassword();
        GeolocationPermissions.getInstance().clearAll();
    }
}
