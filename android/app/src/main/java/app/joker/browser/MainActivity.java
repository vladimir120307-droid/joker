package app.joker.browser;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.SparseArray;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import androidx.webkit.WebViewAssetLoader;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Главный экран: адресная строка, вкладки, два режима, меню. */
public class MainActivity extends Activity implements BrowserHost {

    private static final int REQ_FILE = 1001;
    private static final int REQ_STORAGE = 1002;

    private final List<BrowserTab> tabs = new ArrayList<>();
    private BrowserTab current;
    private int tabSeq;
    private PrivateSession session;
    private WebViewAssetLoader assetLoader;
    private boolean blockThirdPartyCookies = true;
    private int lastNightMode;
    private int lastOrientation;

    // разрешения сайтов
    private final Map<String, Boolean> siteDecisions = new HashMap<>();
    private final SparseArray<PermissionResult> permissionCallbacks = new SparseArray<>();
    private final SparseArray<Boolean> permissionAnyOf = new SparseArray<>();
    private int permissionSeq = 100;
    private ValueCallback<Uri[]> fileCallback;

    // полноэкранное видео
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    // интерфейс
    private View mainContent;
    private View tabSwitcher;
    private View findBar;
    private View bottomBar;
    private FrameLayout webContainer;
    private FrameLayout fullscreenHolder;
    private EditText urlBar;
    private EditText findInput;
    private ImageView securityIcon;
    private ImageView iconFs;
    private ImageView iconFocus;
    private ImageButton btnReload;
    private ImageButton btnBack;
    private ImageButton btnForward;
    private View btnFs;
    private View btnFocus;
    private TextView labelFs;
    private TextView labelFocus;
    private TextView tabCountView;
    private TextView findCount;
    private ProgressBar progress;

    // ---------- жизненный цикл ----------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);   // только в отладочной сборке
        }
        JokerScripts.init(this);
        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(UrlUtils.ASSET_HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        session = new PrivateSession(this);
        session.begin();
        lastNightMode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        lastOrientation = getResources().getConfiguration().orientation;

        bindViews();
        registerBackHandler();

        String start = urlFromIntent(getIntent());
        openTab(start != null ? start : UrlUtils.NEWTAB_URL, true, null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = urlFromIntent(intent);
        if (url != null) openTab(url, true, null);
    }

    private static String urlFromIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return null;
        String s = intent.getDataString();
        if (s != null && (s.startsWith("http://") || s.startsWith("https://"))) return s;
        return null;
    }

    @Override
    protected void onPause() {
        for (BrowserTab t : tabs) t.onActivityPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        for (BrowserTab t : tabs) t.onActivityResume();
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) {
            destroyAllTabs();
            session.end();
        }
        super.onDestroy();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        int night = newConfig.uiMode & Configuration.UI_MODE_NIGHT_MASK;
        int orientation = newConfig.orientation;
        if (night != lastNightMode || orientation != lastOrientation) {
            lastNightMode = night;
            lastOrientation = orientation;
            bindViews();   // перестраиваем интерфейс под тему и ориентацию; вкладки (WebView) остаются теми же
        }
    }

    // ---------- интерфейс ----------

    private void bindViews() {
        for (BrowserTab t : tabs) {
            ViewGroup parent = (ViewGroup) t.web.getParent();
            if (parent != null) parent.removeView(t.web);
        }
        setContentView(R.layout.activity_main);

        mainContent = findViewById(R.id.main_content);
        tabSwitcher = findViewById(R.id.tab_switcher);
        findBar = findViewById(R.id.find_bar);
        bottomBar = findViewById(R.id.bottom_bar);
        webContainer = findViewById(R.id.web_container);
        fullscreenHolder = findViewById(R.id.fullscreen_holder);
        urlBar = findViewById(R.id.url_bar);
        findInput = findViewById(R.id.find_input);
        securityIcon = findViewById(R.id.security_icon);
        btnReload = findViewById(R.id.btn_reload);
        btnBack = findViewById(R.id.btn_back);
        btnForward = findViewById(R.id.btn_forward);
        btnFs = findViewById(R.id.btn_fs);
        btnFocus = findViewById(R.id.btn_focus);
        iconFs = findViewById(R.id.icon_fs);
        iconFocus = findViewById(R.id.icon_focus);
        labelFs = findViewById(R.id.label_fs);
        labelFocus = findViewById(R.id.label_focus);
        tabCountView = findViewById(R.id.tab_count);
        findCount = findViewById(R.id.find_count);
        progress = findViewById(R.id.progress);

        // в альбомной ориентации места мало: подписи под кнопками режимов скрываем
        int labelsVisibility = getResources().getBoolean(R.bool.show_toggle_labels) ? View.VISIBLE : View.GONE;
        labelFs.setVisibility(labelsVisibility);
        labelFocus.setVisibility(labelsVisibility);

        for (BrowserTab t : tabs) {
            webContainer.addView(t.web, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            t.web.setVisibility(t == current ? View.VISIBLE : View.GONE);
        }

        // адресная строка
        urlBar.setOnFocusChangeListener((v, hasFocus) -> {
            if (current == null) return;
            if (hasFocus) {
                urlBar.setText(current.displayUrl());
                urlBar.selectAll();
            } else {
                urlBar.setText(UrlUtils.shortForm(current.displayUrl()));
            }
        });
        urlBar.setOnEditorActionListener((v, actionId, event) -> {
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                    && event.getAction() == KeyEvent.ACTION_DOWN;
            if (actionId == EditorInfo.IME_ACTION_GO || enter) {
                navigate(urlBar.getText().toString());
                return true;
            }
            return false;
        });

        btnReload.setOnClickListener(v -> {
            if (current == null) return;
            if (current.loading) current.web.stopLoading();
            else current.reloadOrRetry();
        });
        btnBack.setOnClickListener(v -> {
            if (current != null) current.goBackSmart();
        });
        btnForward.setOnClickListener(v -> {
            if (current != null && current.web.canGoForward()) current.web.goForward();
        });
        btnFs.setOnClickListener(v -> toggleMode(true));
        btnFocus.setOnClickListener(v -> toggleMode(false));
        btnFs.setOnLongClickListener(v -> {
            showHelp();
            return true;
        });
        btnFocus.setOnLongClickListener(v -> {
            showHelp();
            return true;
        });
        findViewById(R.id.btn_tabs).setOnClickListener(v -> showSwitcher());
        findViewById(R.id.btn_menu).setOnClickListener(this::showMenu);
        findViewById(R.id.btn_switcher_new).setOnClickListener(v -> {
            hideSwitcher();
            newTabAndFocus();
        });
        findViewById(R.id.btn_switcher_close).setOnClickListener(v -> hideSwitcher());

        // поиск по странице
        findViewById(R.id.find_close).setOnClickListener(v -> hideFind());
        findViewById(R.id.find_next).setOnClickListener(v -> {
            if (current != null) current.web.findNext(true);
        });
        findViewById(R.id.find_prev).setOnClickListener(v -> {
            if (current != null) current.web.findNext(false);
        });
        findInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }

            @Override
            public void afterTextChanged(Editable s) {
                if (current == null) return;
                String q = s.toString();
                if (q.isEmpty()) {
                    current.web.clearMatches();
                    findCount.setText("");
                } else {
                    current.web.findAllAsync(q);
                }
            }
        });
        findInput.setOnEditorActionListener((v, actionId, event) -> {
            if (current != null) current.web.findNext(true);
            return true;
        });

        View root = findViewById(R.id.root);
        root.setOnApplyWindowInsetsListener(this::onInsets);
        root.requestApplyInsets();
        applySystemBarAppearance();
        refreshUi();
    }

    /**
     * Цвет значков статус-бара и навигации под текущую тему. Вручную, потому что смену темы мы обрабатываем
     * без пересоздания экрана (иначе пропали бы вкладки), а атрибуты темы в этом случае не пересчитываются.
     */
    @SuppressWarnings("deprecation")
    private void applySystemBarAppearance() {
        boolean light = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                != Configuration.UI_MODE_NIGHT_YES;
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(light ? mask : 0, mask);
            }
        } else {
            View decor = getWindow().getDecorView();
            int mask = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            int flags = decor.getSystemUiVisibility();
            decor.setSystemUiVisibility(light ? flags | mask : flags & ~mask);
        }
        if (Build.VERSION.SDK_INT < 35) {
            getWindow().setStatusBarColor(getColor(R.color.surface));
            getWindow().setNavigationBarColor(getColor(R.color.surface));
        }
    }

    @SuppressWarnings("deprecation")
    private WindowInsets onInsets(View v, WindowInsets insets) {
        int l;
        int t;
        int r;
        int b;
        boolean ime = false;
        if (Build.VERSION.SDK_INT >= 30) {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets imeInsets = insets.getInsets(WindowInsets.Type.ime());
            l = bars.left;
            t = bars.top;
            r = bars.right;
            b = Math.max(bars.bottom, imeInsets.bottom);
            ime = insets.isVisible(WindowInsets.Type.ime());
        } else {
            l = insets.getSystemWindowInsetLeft();
            t = insets.getSystemWindowInsetTop();
            r = insets.getSystemWindowInsetRight();
            b = insets.getSystemWindowInsetBottom();
        }
        mainContent.setPadding(l, t, r, b);
        tabSwitcher.setPadding(l, t, r, b);
        bottomBar.setVisibility(ime ? View.GONE : View.VISIBLE);
        return insets;
    }

    private void refreshUi() {
        if (current == null || urlBar == null) return;
        String shown = current.displayUrl();
        if (!urlBar.hasFocus()) urlBar.setText(UrlUtils.shortForm(shown));

        boolean https = shown.startsWith("https://");
        boolean http = shown.startsWith("http://");
        if (https || http) {
            securityIcon.setVisibility(View.VISIBLE);
            securityIcon.setImageResource(https ? R.drawable.ic_lock : R.drawable.ic_warning);
            securityIcon.setColorFilter(getColor(https ? R.color.text_dim : R.color.warn));
            securityIcon.setContentDescription(https ? null : getString(R.string.not_secure));
        } else {
            securityIcon.setVisibility(View.GONE);
        }

        btnReload.setImageResource(current.loading ? R.drawable.ic_close : R.drawable.ic_refresh);
        btnReload.setContentDescription(getString(current.loading ? R.string.stop : R.string.reload));
        progress.setVisibility(current.loading && current.progress < 100 ? View.VISIBLE : View.INVISIBLE);
        progress.setProgress(current.progress);

        setEnabledAlpha(btnBack, current.canGoBackSmart());
        setEnabledAlpha(btnForward, current.web.canGoForward());
        styleToggle(btnFs, iconFs, labelFs, current.fullscreenMode, R.string.mode_fullscreen);
        styleToggle(btnFocus, iconFocus, labelFocus, current.focusMode, R.string.mode_focus);
        tabCountView.setText(String.valueOf(tabs.size()));
    }

    private static void setEnabledAlpha(View v, boolean enabled) {
        v.setEnabled(enabled);
        v.setAlpha(enabled ? 1f : 0.35f);
    }

    private void styleToggle(View box, ImageView icon, TextView label, boolean on, int nameRes) {
        int c = getColor(on ? R.color.accent : R.color.text_dim);
        icon.setColorFilter(c);
        label.setTextColor(c);
        box.setBackgroundResource(on ? R.drawable.bg_toggle_on : R.drawable.ripple_item);
        box.setContentDescription(getString(nameRes) + ", " + getString(on ? R.string.state_on : R.string.state_off));
    }

    private void navigate(String text) {
        if (current == null) return;
        current.load(UrlUtils.fromInput(text));
        urlBar.clearFocus();
        hideKeyboard();
        current.web.requestFocus();
    }

    private void toggleMode(boolean fullscreen) {
        if (current == null) return;
        if (fullscreen) {
            current.setModes(current.focusMode, !current.fullscreenMode);
            toast(current.fullscreenMode ? R.string.toast_fs_on : R.string.toast_fs_off);
        } else {
            current.setModes(!current.focusMode, current.fullscreenMode);
            toast(current.focusMode ? R.string.toast_focus_on : R.string.toast_focus_off);
        }
        refreshUi();
    }

    private void toast(int res) {
        Toast.makeText(this, res, Toast.LENGTH_SHORT).show();
    }

    private void showKeyboard(View v) {
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.showSoftInput(v, InputMethodManager.SHOW_IMPLICIT);
    }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        View focus = getCurrentFocus();
        if (imm != null && focus != null) imm.hideSoftInputFromWindow(focus.getWindowToken(), 0);
    }

    // ---------- вкладки ----------

    @Override
    public BrowserTab openTab(String url, boolean activate, BrowserTab opener) {
        final BrowserTab tab = new BrowserTab(this, ++tabSeq, session.profileName(), this, assetLoader);
        tab.opener = opener;
        if (opener != null) tab.inheritModes(opener);
        tab.applyCookiePolicy(blockThirdPartyCookies);
        tab.web.setOnLongClickListener(v -> onWebLongPress(tab));
        tab.web.setFindListener((active, total, done) -> {
            if (tab == current) updateFindCount(active, total);
        });
        tabs.add(tab);
        webContainer.addView(tab.web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        tab.web.setVisibility(View.GONE);
        if (activate) switchTo(tab);
        if (url != null) tab.load(url);
        refreshUi();
        return tab;
    }

    private void newTabAndFocus() {
        openTab(UrlUtils.NEWTAB_URL, true, null);
        urlBar.requestFocus();
        showKeyboard(urlBar);
    }

    private void switchTo(BrowserTab tab) {
        if (current != null && current != tab) current.web.setVisibility(View.GONE);
        current = tab;
        tab.web.setVisibility(View.VISIBLE);
        if (findBar.getVisibility() == View.VISIBLE) hideFind();
        urlBar.clearFocus();
        tab.web.requestFocus();
        refreshUi();
    }

    @Override
    public void closeTab(BrowserTab tab) {
        int index = tabs.indexOf(tab);
        if (index < 0) return;
        tabs.remove(index);
        for (BrowserTab t : tabs) {
            if (t.opener == tab) t.opener = null;
        }
        webContainer.removeView(tab.web);
        tab.destroy();
        if (current == tab) {
            current = null;
            BrowserTab next = tab.opener != null && tabs.contains(tab.opener) ? tab.opener
                    : tabs.isEmpty() ? null : tabs.get(Math.min(index, tabs.size() - 1));
            if (next == null) openTab(UrlUtils.NEWTAB_URL, true, null);
            else switchTo(next);
        } else {
            refreshUi();
        }
    }

    private void destroyAllTabs() {
        for (BrowserTab t : new ArrayList<>(tabs)) {
            if (webContainer != null) webContainer.removeView(t.web);
            t.destroy();
        }
        tabs.clear();
        current = null;
    }

    @Override
    public void onTabChanged(BrowserTab tab) {
        if (tab == current) refreshUi();
    }

    @Override
    public void onRenderGone(BrowserTab tab) {
        toast(R.string.render_gone);
        closeTab(tab);
    }

    // ---------- список вкладок ----------

    private void showSwitcher() {
        hideKeyboard();
        rebuildSwitcher();
        tabSwitcher.setVisibility(View.VISIBLE);
    }

    private void hideSwitcher() {
        tabSwitcher.setVisibility(View.GONE);
    }

    private void rebuildSwitcher() {
        LinearLayout list = findViewById(R.id.tab_list);
        list.removeAllViews();
        LayoutInflater inflater = getLayoutInflater();
        for (BrowserTab t : new ArrayList<>(tabs)) {
            View row = inflater.inflate(R.layout.item_tab, list, false);
            ImageView icon = row.findViewById(R.id.tab_icon);
            if (t.favicon != null) icon.setImageBitmap(t.favicon);
            else icon.setImageResource(R.drawable.ic_globe);
            ((TextView) row.findViewById(R.id.tab_title)).setText(tabTitle(t));
            ((TextView) row.findViewById(R.id.tab_url)).setText(UrlUtils.shortForm(t.displayUrl()));
            TextView modes = row.findViewById(R.id.tab_modes);
            String text = modesText(t);
            modes.setText(text);
            modes.setVisibility(text.isEmpty() ? View.GONE : View.VISIBLE);
            if (t == current) row.setBackgroundResource(R.drawable.bg_tab_current);
            row.setOnClickListener(v -> {
                hideSwitcher();
                switchTo(t);
            });
            row.findViewById(R.id.tab_close).setOnClickListener(v -> {
                closeTab(t);
                if (tabSwitcher.getVisibility() == View.VISIBLE) rebuildSwitcher();
            });
            list.addView(row);
        }
        ((TextView) findViewById(R.id.switcher_title)).setText(getString(R.string.tabs_title, tabs.size()));
    }

    private String tabTitle(BrowserTab t) {
        if (UrlUtils.isNewTab(t.url)) return getString(R.string.tab_new_title);
        if (!t.title.isEmpty()) return t.title;
        String host = UrlUtils.hostOf(t.displayUrl());
        return host.isEmpty() ? getString(R.string.tab_untitled) : host;
    }

    private String modesText(BrowserTab t) {
        StringBuilder sb = new StringBuilder();
        if (t.fullscreenMode) sb.append(getString(R.string.tab_mode_fullscreen));
        if (t.focusMode) {
            if (sb.length() > 0) sb.append(" · ");
            sb.append(getString(R.string.tab_mode_focus));
        }
        return sb.toString();
    }

    // ---------- поиск по странице ----------

    private void showFind() {
        findBar.setVisibility(View.VISIBLE);
        findInput.requestFocus();
        showKeyboard(findInput);
    }

    private void hideFind() {
        findBar.setVisibility(View.GONE);
        findInput.setText("");
        if (current != null) current.web.clearMatches();
        hideKeyboard();
    }

    private void updateFindCount(int active, int total) {
        findCount.setText(total == 0 || findInput.getText().length() == 0 ? "" : (active + 1) + "/" + total);
    }

    // ---------- меню ----------

    private void showMenu(View anchor) {
        if (current == null) return;
        PopupMenu menu = new PopupMenu(this, anchor, Gravity.END);
        menu.getMenuInflater().inflate(R.menu.browser_menu, menu.getMenu());
        menu.getMenu().findItem(R.id.menu_desktop).setChecked(current.desktopMode);
        menu.getMenu().findItem(R.id.menu_third_party).setChecked(blockThirdPartyCookies);
        menu.setOnMenuItemClickListener(this::onMenuItem);
        menu.show();
    }

    private boolean onMenuItem(MenuItem item) {
        int id = item.getItemId();
        if (current == null) return false;
        if (id == R.id.menu_new_tab) {
            newTabAndFocus();
        } else if (id == R.id.menu_find) {
            showFind();
        } else if (id == R.id.menu_desktop) {
            current.setDesktop(!current.desktopMode);
        } else if (id == R.id.menu_third_party) {
            blockThirdPartyCookies = !blockThirdPartyCookies;
            for (BrowserTab t : tabs) t.applyCookiePolicy(blockThirdPartyCookies);
        } else if (id == R.id.menu_share) {
            Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_TEXT, current.displayUrl());
            startActivity(Intent.createChooser(send, getString(R.string.menu_share)));
        } else if (id == R.id.menu_copy) {
            copyText(current.displayUrl());
        } else if (id == R.id.menu_open_external) {
            openInOtherApp(current.displayUrl());
        } else if (id == R.id.menu_downloads) {
            try {
                startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS));
            } catch (RuntimeException e) {
                toast(R.string.no_app);
            }
        } else if (id == R.id.menu_help) {
            showHelp();
        } else if (id == R.id.menu_end_session) {
            confirmEndSession();
        } else {
            return false;
        }
        return true;
    }

    private void showHelp() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.help_title)
                .setMessage(R.string.help_message)
                .setPositiveButton(R.string.ok, null)
                .show();
    }

    private void copyText(String text) {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("url", text));
        toast(R.string.copied);
    }

    private void openInOtherApp(String url) {
        if (!url.startsWith("http")) return;
        Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        Intent chooser = Intent.createChooser(view, getString(R.string.menu_open_external));
        chooser.putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS,
                new ComponentName[]{new ComponentName(this, MainActivity.class)});
        try {
            startActivity(chooser);
        } catch (RuntimeException e) {
            toast(R.string.no_app);
        }
    }

    private void confirmEndSession() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.end_session_title)
                .setMessage(R.string.end_session_message)
                .setPositiveButton(R.string.end_session_yes, (d, w) -> resetSession())
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    private void resetSession() {
        hideSwitcher();
        if (findBar.getVisibility() == View.VISIBLE) hideFind();
        destroyAllTabs();
        session.end();
        session.begin();
        siteDecisions.clear();
        openTab(UrlUtils.NEWTAB_URL, true, null);
        toast(R.string.session_cleared);
    }

    // ---------- долгое нажатие на ссылку или картинку ----------

    private boolean onWebLongPress(BrowserTab tab) {
        WebView.HitTestResult r = tab.web.getHitTestResult();
        String extra = r.getExtra();
        if (extra == null || extra.isEmpty()) return false;
        int type = r.getType();
        if (type == WebView.HitTestResult.SRC_ANCHOR_TYPE || type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE) {
            showLinkMenu(tab, extra);
            return true;
        }
        if (type == WebView.HitTestResult.IMAGE_TYPE) {
            showImageMenu(tab, extra);
            return true;
        }
        return false;
    }

    private static String shorten(String s) {
        return s.length() > 90 ? s.substring(0, 90) + "…" : s;
    }

    private void showLinkMenu(BrowserTab tab, String link) {
        String[] items = {getString(R.string.link_open_new), getString(R.string.link_copy), getString(R.string.link_share)};
        new AlertDialog.Builder(this).setTitle(shorten(link)).setItems(items, (d, which) -> {
            if (which == 0) {
                openTab(link, false, tab);
            } else if (which == 1) {
                copyText(link);
            } else {
                Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link);
                startActivity(Intent.createChooser(send, getString(R.string.link_share)));
            }
        }).show();
    }

    private void showImageMenu(BrowserTab tab, String image) {
        String[] items = {getString(R.string.image_open), getString(R.string.image_save), getString(R.string.image_copy)};
        new AlertDialog.Builder(this).setTitle(shorten(image)).setItems(items, (d, which) -> {
            if (which == 0) {
                openTab(image, false, tab);
            } else if (which == 1) {
                startDownload(tab, image, tab.web.getSettings().getUserAgentString(), null, null);
            } else {
                copyText(image);
            }
        }).show();
    }

    // ---------- кнопка «назад» ----------

    private void registerBackHandler() {
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, () -> handleBack());
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBack();   // Android до 13; на новых работает зарегистрированный обработчик
    }

    private boolean handleBack() {
        if (customView != null) {
            hideCustomView();
            return true;
        }
        if (tabSwitcher.getVisibility() == View.VISIBLE) {
            hideSwitcher();
            return true;
        }
        if (findBar.getVisibility() == View.VISIBLE) {
            hideFind();
            return true;
        }
        if (urlBar.hasFocus()) {
            urlBar.clearFocus();
            hideKeyboard();
            return true;
        }
        if (current != null) {
            if (current.goBackSmart()) return true;
            if (tabs.size() > 1) {
                closeTab(current);
                return true;
            }
        }
        finish();
        return true;
    }

    // ---------- полноэкранное видео ----------

    @Override
    public void showCustomView(View view, WebChromeClient.CustomViewCallback callback) {
        if (customView != null) {
            callback.onCustomViewHidden();
            return;
        }
        customView = view;
        customViewCallback = callback;
        fullscreenHolder.addView(view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        fullscreenHolder.setVisibility(View.VISIBLE);
        mainContent.setVisibility(View.GONE);
        applyImmersive(true);
    }

    @Override
    public void hideCustomView() {
        if (customView == null) return;
        fullscreenHolder.removeView(customView);
        fullscreenHolder.setVisibility(View.GONE);
        mainContent.setVisibility(View.VISIBLE);
        applyImmersive(false);
        applySystemBarAppearance();
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customView = null;
        customViewCallback = null;
    }

    @SuppressWarnings("deprecation")
    private void applyImmersive(boolean on) {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c == null) return;
            if (on) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else {
                c.show(WindowInsets.Type.systemBars());
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(on
                    ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    : View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    // ---------- файлы ----------

    @Override
    public boolean pickFiles(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        try {
            startActivityForResult(params.createIntent(), REQ_FILE);
        } catch (RuntimeException e) {
            fileCallback = null;
            return false;
        }
        return true;
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ---------- загрузки ----------

    @Override
    public void startDownload(BrowserTab tab, String url, String userAgent, String contentDisposition, String mimeType) {
        if (url == null || url.startsWith("blob:") || url.startsWith("data:")) {
            toast(R.string.download_unsupported);
            return;
        }
        if (Build.VERSION.SDK_INT <= 28
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
            toast(R.string.download_failed);
            return;
        }
        try {
            String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            String cookie = tab.cookiesFor(url);
            if (cookie != null) req.addRequestHeader("Cookie", cookie);
            if (userAgent != null) req.addRequestHeader("User-Agent", userAgent);
            if (mimeType != null) req.setMimeType(mimeType);
            req.setTitle(name);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
            Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show();
        } catch (RuntimeException e) {
            toast(R.string.download_failed);
        }
    }

    // ---------- разрешения сайтов ----------

    @Override
    public void requestSitePermission(String origin, String what, String[] androidPermissions,
                                      boolean anyOf, PermissionResult result) {
        String key = UrlUtils.originOf(origin) + "|" + what;
        Boolean known = siteDecisions.get(key);
        if (known != null) {
            if (known) ensureSystemPermission(androidPermissions, anyOf, result);
            else result.done(false);
            return;
        }
        String site = UrlUtils.hostOf(origin);
        new AlertDialog.Builder(this)
                .setTitle(R.string.perm_title)
                .setMessage(getString(R.string.perm_message, site.isEmpty() ? origin : site, what))
                .setPositiveButton(R.string.allow, (d, w) -> {
                    siteDecisions.put(key, true);
                    ensureSystemPermission(androidPermissions, anyOf, result);
                })
                .setNegativeButton(R.string.block, (d, w) -> {
                    siteDecisions.put(key, false);
                    result.done(false);
                })
                .setOnCancelListener(d -> result.done(false))
                .show();
    }

    private void ensureSystemPermission(String[] perms, boolean anyOf, PermissionResult result) {
        List<String> missing = new ArrayList<>();
        boolean anyGranted = false;
        for (String p : perms) {
            if (checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) anyGranted = true;
            else missing.add(p);
        }
        if (missing.isEmpty() || (anyOf && anyGranted)) {
            result.done(true);
            return;
        }
        int code = ++permissionSeq;
        permissionCallbacks.put(code, result);
        permissionAnyOf.put(code, anyOf);
        requestPermissions(missing.toArray(new String[0]), code);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        PermissionResult cb = permissionCallbacks.get(requestCode);
        if (cb == null) {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults);
            return;
        }
        boolean anyOf = Boolean.TRUE.equals(permissionAnyOf.get(requestCode));
        permissionCallbacks.remove(requestCode);
        permissionAnyOf.remove(requestCode);
        boolean all = grantResults.length > 0;
        boolean any = false;
        for (int r : grantResults) {
            if (r == PackageManager.PERMISSION_GRANTED) any = true;
            else all = false;
        }
        cb.done(anyOf ? any : all);
    }

    @Override
    public Activity activity() {
        return this;
    }
}
