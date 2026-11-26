package ru.avtobaza.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Свой обработчик обновления: он умеет качать сборку с чужого хоста,
        // проверять контрольную сумму и отдавать файл системе на установку
        registerPlugin(AppUpdatePlugin.class);
        // Свой обработчик WebDAV: обычный сетевой мост Android не пускает методы PROPFIND и MKCOL
        registerPlugin(WebDavPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
