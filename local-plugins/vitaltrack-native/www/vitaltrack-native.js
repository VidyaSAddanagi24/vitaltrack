var exec = require('cordova/exec');

/**
 * Window insets are reported in CSS pixels (dp), ready for CSS custom properties.
 */
module.exports = {
    getInsets: function (success, error) {
        exec(
            function (value) { success && success(value); },
            function (err) { error && error(err); },
            'VitalTrackNative', 'getInsets', []
        );
    },
    applySystemBars: function () {
        exec(null, null, 'VitalTrackNative', 'applySystemBars', []);
    },
    requestSync: function (server, path, method, token, body, success, error) {
        var json;
        try {
            json = body == null ? null : JSON.stringify(body);
        } catch (e) {
            if (error) error({ status: 0, message: 'Invalid request body' });
            return;
        }
        exec(success, function (err) {
            if (error) error({
                status: err && Number(err.status) || 0,
                message: err && typeof err.message === 'string' ? err.message : 'Sync request failed'
            });
        }, 'VitalTrackNative', 'requestSync', [server, path, method, token || '', json]);
    }
};
