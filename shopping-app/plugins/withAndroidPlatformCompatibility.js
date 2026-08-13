const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withAndroidStyles,
} = require("expo/config-plugins");

const ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android";
const TOOLS_NAMESPACE = "http://schemas.android.com/tools";
const CAMERA_FEATURE = "android.hardware.camera";
const SPLASH_STYLE = "Theme.App.SplashScreen";
const SPLASH_BEHAVIOR_ITEM = "android:windowSplashScreenBehavior";

function upsertOptionalCameraFeature(androidManifest) {
  const manifest = androidManifest.manifest;
  const features = Array.isArray(manifest["uses-feature"])
    ? manifest["uses-feature"]
    : [];
  const cameraFeatures = features.filter(
    (feature) => feature?.$?.["android:name"] === CAMERA_FEATURE,
  );

  const cameraFeature = cameraFeatures[0] ?? { $: {} };
  cameraFeature.$ = {
    ...cameraFeature.$,
    "android:name": CAMERA_FEATURE,
    "android:required": "false",
  };

  manifest.$ = {
    ...manifest.$,
    "xmlns:android": manifest.$?.["xmlns:android"] ?? ANDROID_NAMESPACE,
  };
  manifest["uses-feature"] = [
    ...features.filter(
      (feature) => feature?.$?.["android:name"] !== CAMERA_FEATURE,
    ),
    cameraFeature,
  ];
  return androidManifest;
}

function addSplashBehaviorTargetApi(styles) {
  styles.resources.$ = {
    ...styles.resources.$,
    "xmlns:tools": styles.resources.$?.["xmlns:tools"] ?? TOOLS_NAMESPACE,
  };

  const splashBehavior = AndroidConfig.Styles.getStylesItem({
    name: SPLASH_BEHAVIOR_ITEM,
    xml: styles,
    parent: { name: SPLASH_STYLE },
  });
  if (splashBehavior) {
    splashBehavior.$ = {
      ...splashBehavior.$,
      "tools:targetApi": "33",
    };
  }
  return styles;
}

function withAndroidPlatformCompatibility(config) {
  config = withAndroidManifest(config, (manifestConfig) => {
    manifestConfig.modResults = upsertOptionalCameraFeature(
      manifestConfig.modResults,
    );
    return manifestConfig;
  });

  return withAndroidStyles(config, (stylesConfig) => {
    stylesConfig.modResults = addSplashBehaviorTargetApi(
      stylesConfig.modResults,
    );
    return stylesConfig;
  });
}

module.exports = createRunOncePlugin(
  withAndroidPlatformCompatibility,
  "with-android-platform-compatibility",
  "1.0.0",
);
module.exports.addSplashBehaviorTargetApi = addSplashBehaviorTargetApi;
module.exports.upsertOptionalCameraFeature = upsertOptionalCameraFeature;
