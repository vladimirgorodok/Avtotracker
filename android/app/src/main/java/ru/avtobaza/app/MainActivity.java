package ru.avtobaza.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Свой обработчик WebDAV: обычный сетевой мост Android не пускает методы PROPFIND и MKCOL
        registerPlugin(WebDavPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
