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

/**
 * Bridges the two things the web layer cannot do on its own:
 *  - reading real window insets so the black UI can draw edge to edge
 *  - creating the alert notification channels with long vibration patterns
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
        return false;
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
