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
    }
};
