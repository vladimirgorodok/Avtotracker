package ru.avtobaza.app;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Обновление приложения: скачивание новой сборки и передача её системному установщику.
 *
 * Зачем свой обработчик, а не обычная загрузка средствами веб-страницы:
 *  - файл сборки отдаётся с другого хоста (release-assets.githubusercontent.com),
 *    и обычная загрузка из окна приложения упирается в запрет чужих запросов;
 *  - скачанную сборку нужно проверить по контрольной сумме, которую публикует GitHub,
 *    и только потом отдавать на установку;
 *  - установить сборку может только сама система: приложение открывает окно
 *    установщика и передаёт ему файл по правилам Android (через FileProvider),
 *    а решение об установке всегда подтверждает человек.
 *
 * Обычная загрузка идёт по перенаправлениям (GitHub уводит на хост с файлами),
 * поэтому, в отличие от обработчика WebDAV, перенаправления здесь разрешены.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    /** Куда кладём скачанную сборку: личная папка кэша приложения */
    private static final String FILE_NAME = "avtobaza-update.apk";
    private static final String MIME = "application/vnd.android.package-archive";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private OkHttpClient client;

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        executor.shutdownNow();
    }

    private OkHttpClient client() {
        if (client == null) {
            client = new OkHttpClient.Builder()
                .connectTimeout(20, TimeUnit.SECONDS)
                // Сборка весит несколько мегабайт: на слабой сети это может занять минуты
                .readTimeout(180, TimeUnit.SECONDS)
                .writeTimeout(60, TimeUnit.SECONDS)
                .build();
        }
        return client;
    }

    /** Можно ли приложению ставить сборки поверх себя (разрешение «из неизвестных источников») */
    @PluginMethod
    public void canInstall(final PluginCall call) {
        JSObject answer = new JSObject();
        answer.put("allowed", canRequestInstall());
        call.resolve(answer);
    }

    /** Открыть системный экран, где разрешают установку из неизвестных источников */
    @PluginMethod
    public void openInstallSettings(final PluginCall call) {
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            } else {
                intent = new Intent(Settings.ACTION_SECURITY_SETTINGS);
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Не удалось открыть настройки установки");
        }
    }

    /**
     * Скачать сборку в кэш приложения, проверить её и запомнить путь.
     * Ход загрузки отдаём событиями `progress`, чтобы на экране шла полоса.
     */
    @PluginMethod
    public void download(final PluginCall call) {
        final String url = call.getString("url", "");
        final String sha256 = call.getString("sha256", "");
        if (url == null || url.isEmpty()) {
            call.reject("Не указан адрес сборки");
            return;
        }
        executor.submit(() -> {
            try {
                File file = downloadToCache(url, sha256, call);
                JSObject answer = new JSObject();
                answer.put("path", file.getAbsolutePath());
                answer.put("size", file.length());
                call.resolve(answer);
            } catch (Exception e) {
                String text = e.getMessage();
                call.reject(text == null || text.isEmpty() ? e.getClass().getSimpleName() : text);
            }
        });
    }

    /** Отдать скачанную сборку системному установщику */
    @PluginMethod
    public void install(final PluginCall call) {
        String path = call.getString("path", "");
        if (path == null || path.isEmpty()) {
            call.reject("Сборка ещё не скачана");
            return;
        }
        File file = new File(path);
        if (!file.exists()) {
            call.reject("Файл сборки не найден — скачайте заново");
            return;
        }
        if (!canRequestInstall()) {
            call.reject("Разрешите установку из неизвестных источников и повторите");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                file
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, MIME);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (getActivity() != null) {
                getActivity().startActivity(intent);
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Система не смогла открыть установщик: " + e.getMessage());
        }
    }

    private boolean canRequestInstall() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PackageManager pm = getContext().getPackageManager();
            return pm.canRequestPackageInstalls();
        }
        return true;
    }

    private File downloadToCache(String url, String sha256, PluginCall call) throws Exception {
        File dir = new File(getContext().getCacheDir(), "updates");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("Не удалось подготовить папку для сборки");
        File file = new File(dir, FILE_NAME);

        Request request = new Request.Builder()
            .url(url)
            .header("User-Agent", "AvtoBaza-Updater")
            .header("Accept", "application/octet-stream")
            .build();
        try (Response response = client().newCall(request).execute()) {
            if (!response.isSuccessful()) {
                throw new IOException("Сервер ответил " + response.code());
            }
            ResponseBody body = response.body();
            if (body == null) throw new IOException("Пустой ответ сервера");
            long total = body.contentLength();

            MessageDigest digest = (sha256 == null || sha256.isEmpty())
                ? null
                : MessageDigest.getInstance("SHA-256");

            byte[] buffer = new byte[64 * 1024];
            long done = 0;
            long lastSent = 0;
            try (InputStream in = body.byteStream(); FileOutputStream out = new FileOutputStream(file, false)) {
                int len;
                while ((len = in.read(buffer)) > 0) {
                    out.write(buffer, 0, len);
                    if (digest != null) digest.update(buffer, 0, len);
                    done += len;
                    long now = System.currentTimeMillis();
                    if (now - lastSent > 100) { // не чаще 10 раз в секунду
                        emitProgress(done, total);
                        lastSent = now;
                    }
                }
            }
            emitProgress(done, total);

            if (digest != null) {
                String actual = toHex(digest.digest());
                if (!actual.equalsIgnoreCase(sha256)) {
                    // Сборка не совпала с обещанной — ставить её нельзя
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                    throw new IOException("Скачанная сборка повреждена: контрольная сумма не совпала");
                }
            }
            return file;
        }
    }

    private void emitProgress(long bytes, long total) {
        JSObject data = new JSObject();
        data.put("bytes", bytes);
        data.put("total", total);
        data.put("percent", total > 0 ? Math.min(100, Math.round(bytes * 100.0 / total)) : 0);
        notifyListeners("progress", data);
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
