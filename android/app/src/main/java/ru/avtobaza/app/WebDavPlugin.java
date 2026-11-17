package ru.avtobaza.app;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Запросы к Яндекс Диску по протоколу WebDAV.
 *
 * Штатный сетевой мост Capacitor (CapacitorHttp) работает через HttpURLConnection, а тот
 * разрешает только обычные методы (GET, POST, PUT, DELETE и ещё несколько). Методы WebDAV
 * — PROPFIND и MKCOL — он отвергает, поэтому запросы идут через OkHttp: он умеет любые
 * методы. Логин и пароль приложения приходят в заголовке Authorization, как и раньше.
 */
@CapacitorPlugin(name = "WebDav")
public class WebDavPlugin extends Plugin {

    /** Какие свойства спрашиваем у Диска. Так же спрашивает приложение «Платежи». */
    private static final String PROPFIND_BODY =
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
            + "<d:propfind xmlns:d=\"DAV:\"><d:prop>"
            + "<d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/>"
            + "<d:quota-available-bytes/>"
            + "</d:prop></d:propfind>";

    private static final String XML = "application/xml; charset=utf-8";

    private final ExecutorService executor = Executors.newCachedThreadPool();
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
                .readTimeout(150, TimeUnit.SECONDS)
                .writeTimeout(150, TimeUnit.SECONDS)
                // Переадресации разбираем сами: файлы Диск отдаёт с других хостов
                .followRedirects(false)
                .followSslRedirects(false)
                .build();
        }
        return client;
    }

    /** Сеть — в отдельном потоке, чтобы не подвешивать окно приложения */
    @PluginMethod
    public void request(final PluginCall call) {
        executor.submit(() -> {
            try {
                call.resolve(perform(call));
            } catch (Exception e) {
                String text = e.getMessage();
                call.reject(text == null || text.isEmpty() ? e.getClass().getSimpleName() : text);
            }
        });
    }

    private JSObject perform(PluginCall call) throws IOException {
        String url = call.getString("url", "");
        String method = call.getString("method", "GET");
        boolean binary = Boolean.TRUE.equals(call.getBoolean("binary", false));
        String bodyBase64 = call.getString("bodyBase64");
        JSObject headers = call.getObject("headers", new JSObject());

        Request.Builder builder = new Request.Builder().url(url);
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            String value = headers.getString(key);
            if (value != null) builder.header(key, value);
        }

        RequestBody body = null;
        if (bodyBase64 != null) {
            body = RequestBody.create(Base64.decode(bodyBase64, Base64.DEFAULT), mediaType(headers));
        } else if ("PROPFIND".equals(method)) {
            body = RequestBody.create(PROPFIND_BODY.getBytes("UTF-8"), MediaType.parse(XML));
        }

        try (Response response = client().newCall(builder.method(method, body).build()).execute()) {
            JSObject answer = new JSObject();
            answer.put("status", response.code());

            JSObject outHeaders = new JSObject();
            for (String name : response.headers().names()) {
                outHeaders.put(name, response.header(name));
            }
            answer.put("headers", outHeaders);

            ResponseBody responseBody = response.body();
            if (binary) {
                byte[] bytes = responseBody == null ? new byte[0] : responseBody.bytes();
                answer.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            } else {
                answer.put("text", responseBody == null ? "" : responseBody.string());
            }
            return answer;
        }
    }

    private MediaType mediaType(JSObject headers) {
        String type = headers.getString("Content-Type");
        return type == null ? null : MediaType.parse(type);
    }
}
