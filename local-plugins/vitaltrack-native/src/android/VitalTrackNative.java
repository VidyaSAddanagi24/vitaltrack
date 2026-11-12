package com.ishan.vitaltrack.nativebridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.res.Resources;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Native window insets, alert channels, and restricted foreground sync HTTP.
 * This plugin does not provide a background delivery service.
 */
public class VitalTrackNative extends CordovaPlugin {

    public static final String WATCH_CHANNEL  = "vt_alerts_watch_v1";
    public static final String REVIEW_CHANNEL = "vt_alerts_review_v4";
    public static final String URGENT_CHANNEL = "vt_alerts_urgent_v4";

    /* 2 s single pulse */
    private static final long[] WATCH_PATTERN = { 0, 2000 };
    /* 5 x 800 ms with 250 ms gaps = 5000 ms */
    private static final long[] REVIEW_PATTERN = { 0, 800, 250, 800, 250, 800, 250, 800, 250, 800 };
    /* 5 x 1800 ms with 250 ms gaps = 10000 ms */
    private static final long[] URGENT_PATTERN = { 0, 1800, 250, 1800, 250, 1800, 250, 1800, 250, 1800 };

    @Override
    protected void pluginInitialize() {
        createChannels();
        applySystemBars();
    }

    @Override
    public void onResume(boolean multitasking) {
        applySystemBars();
    }

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) {
        if ("getInsets".equals(action)) {
            callbackContext.success(readInsets());
            return true;
        }
        if ("applySystemBars".equals(action)) {
            applySystemBars();
            callbackContext.success();
            return true;
        }
        if ("requestSync".equals(action)) {
            cordova.getThreadPool().execute(() -> requestSync(args, callbackContext));
            return true;
        }
        return false;
    }

    private static boolean isLocalHttpHost(String host) {
        host = host.toLowerCase(Locale.ROOT);
        if ("localhost".equals(host) || "[::1]".equals(host) ||
                "[0:0:0:0:0:0:0:1]".equals(host)) return true;
        if (host.endsWith(".local") && host.matches("[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.local")) {
            return true;
        }
        // Literal dotted IPv4 only: do not resolve public DNS names to permit HTTP.
        if (!host.matches("[0-9]{1,3}(?:\\.[0-9]{1,3}){3}")) return false;
        String[] parts = host.split("\\.");
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            if (parts[i].length() > 1 && parts[i].startsWith("0")) return false;
            octets[i] = Integer.parseInt(parts[i]);
            if (octets[i] > 255) return false;
        }
        return octets[0] == 127 || octets[0] == 10 ||
            (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) ||
            (octets[0] == 192 && octets[1] == 168);
    }

    private static URI syncOrigin(String server) throws Exception {
        URI origin = new URI(server);
        String scheme = origin.getScheme();
        String host = origin.getHost();
        String path = origin.getRawPath();
        if (host == null || origin.getRawUserInfo() != null ||
                origin.getRawQuery() != null || origin.getRawFragment() != null ||
                (path != null && !path.isEmpty() && !"/".equals(path)) ||
                origin.getPort() == 0 || origin.getPort() > 65535 ||
                !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) {
            throw new IllegalArgumentException();
        }
        if ("http".equalsIgnoreCase(scheme) && !isLocalHttpHost(host)) {
            throw new IllegalArgumentException();
        }
        return origin;
    }

    private static void syncError(CallbackContext callback, int status, String message) {
        JSONObject error = new JSONObject();
        try {
            error.put("status", status);
            error.put("message", message);
        } catch (JSONException ignored) { }
        callback.error(error);
    }

    private void requestSync(JSONArray args, CallbackContext callback) {
        HttpURLConnection connection = null;
        int status = 0;
        try {
            URI origin = syncOrigin(args.getString(0));
            String path = args.getString(1);
            String method = args.getString(2);
            String token = args.optString(3, "");
            String body = args.isNull(4) ? null : args.getString(4);
            boolean claim = "POST".equals(method) && "/api/clinical/mobile/claim".equals(path);
            boolean feed = "GET".equals(method) &&
                path.matches("/api/clinical/mobile/feed\\?after=[0-9]+");
            boolean revoke = "DELETE".equals(method) && "/api/clinical/mobile/connection".equals(path);
            if (!(claim || feed || revoke)) throw new IllegalArgumentException();
            if (claim) {
                if (!token.isEmpty() || body == null) throw new IllegalArgumentException();
                JSONObject payload = new JSONObject(body);
                if (payload.length() != 1 || !(payload.get("code") instanceof String) ||
                        !payload.getString("code").matches("[0-9]{6}")) {
                    throw new IllegalArgumentException();
                }
            } else if (body != null || !token.matches("[\\x21-\\x7E]+")) {
                throw new IllegalArgumentException();
            }

            connection = (HttpURLConnection) origin.resolve(path).toURL().openConnection();
            connection.setInstanceFollowRedirects(false); // Never forward a bearer token.
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setUseCaches(false);
            connection.setRequestMethod(method);
            connection.setRequestProperty("Accept", "application/json");
            if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(bytes);
                }
            }
            status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                syncError(callback, status, "Redirects are not allowed");
                return;
            }
            boolean success = status >= 200 && status < 300;
            String response = "";
            try (InputStream input = success ? connection.getInputStream() : connection.getErrorStream();
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                if (input != null) {
                    byte[] buffer = new byte[4096];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (output.size() + count > 1024 * 1024) {
                            throw new java.io.IOException("Response too large");
                        }
                        output.write(buffer, 0, count);
                    }
                    response = new String(output.toByteArray(), StandardCharsets.UTF_8);
                }
            }
            if (success) {
                callback.success(response.trim().isEmpty() ? new JSONObject() : new JSONObject(response));
            } else {
                String message = "Sync request failed";
                try { message = new JSONObject(response).optString("message", message); }
                catch (JSONException ignored) { }
                syncError(callback, status, message);
            }
        } catch (IllegalArgumentException e) {
            syncError(callback, 0, "Invalid sync origin, endpoint, or request");
        } catch (Exception e) {
            // Do not expose URLs, request bodies, or credentials in errors/logs.
            syncError(callback, status, "Sync request failed or timed out");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private Context ctx() {
        return cordova.getActivity().getApplicationContext();
    }

    /* ── notification channels ─────────────────────────────────── */

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager nm =
            (NotificationManager) ctx().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        // Superseded channels stored the old sound; drop them so settings stay clean.
        for (String stale : new String[] {
                "vt_alerts_review_v1", "vt_alerts_review_v2", "vt_alerts_review_v3",
                "vt_alerts_urgent_v1", "vt_alerts_urgent_v2", "vt_alerts_urgent_v3" }) {
            nm.deleteNotificationChannel(stale);
        }

        channel(nm, WATCH_CHANNEL, "VitalTrack · Watch",
            "Routine check-in alerts", WATCH_PATTERN, "vt_watch",
            AudioAttributes.USAGE_NOTIFICATION, Color.rgb(255, 214, 10));

        channel(nm, REVIEW_CHANNEL, "VitalTrack · Review",
            "Alerts that need a clinician review", REVIEW_PATTERN, "vt_review",
            AudioAttributes.USAGE_NOTIFICATION, Color.rgb(30, 228, 225));

        channel(nm, URGENT_CHANNEL, "VitalTrack · Emergency",
            "Urgent medical alerts", URGENT_PATTERN, "vt_urgent",
            AudioAttributes.USAGE_ALARM, Color.rgb(255, 69, 58));
    }

    private void channel(NotificationManager nm, String id, String name, String description,
                         long[] pattern, String soundRes, int usage, int lightColor) {
        // Channels are immutable once created, so only build the missing ones.
        if (nm.getNotificationChannel(id) != null) return;

        NotificationChannel channel =
            new NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(description);
        channel.enableVibration(true);
        channel.setVibrationPattern(pattern);
        channel.enableLights(true);
        channel.setLightColor(lightColor);
        channel.setShowBadge(true);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        Uri sound = rawUri(soundRes);
        if (sound != null) {
            AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(usage)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            channel.setSound(sound, attributes);
        }

        nm.createNotificationChannel(channel);
    }

    private Uri rawUri(String name) {
        Resources res = ctx().getResources();
        int id = res.getIdentifier(name, "raw", ctx().getPackageName());
        if (id == 0) return null;
        return Uri.parse("android.resource://" + ctx().getPackageName() + "/" + id);
    }

    /* ── window insets ─────────────────────────────────────────── */

    private JSONObject readInsets() {
        JSONObject out = new JSONObject();
        try {
            View decor = cordova.getActivity().getWindow().getDecorView();
            WindowInsets insets = decor.getRootWindowInsets();
            float density = ctx().getResources().getDisplayMetrics().density;
            if (density <= 0f) density = 1f;

            int top = 0, right = 0, bottom = 0, left = 0;
            if (insets != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    top = bars.top;
                    right = bars.right;
                    bottom = bars.bottom;
                    left = bars.left;
                } else {
                    top = insets.getSystemWindowInsetTop();
                    right = insets.getSystemWindowInsetRight();
                    bottom = insets.getSystemWindowInsetBottom();
                    left = insets.getSystemWindowInsetLeft();
                }
            }

            out.put("top", top / density);
            out.put("right", right / density);
            out.put("bottom", bottom / density);
            out.put("left", left / density);
        } catch (JSONException ignored) {
        }
        return out;
    }

    /* ── system bar appearance ─────────────────────────────────── */

    private void applySystemBars() {
        cordova.getActivity().runOnUiThread(() -> {
            Window window = cordova.getActivity().getWindow();
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(false);
            controller.setAppearanceLightNavigationBars(false);
        });
    }
}
