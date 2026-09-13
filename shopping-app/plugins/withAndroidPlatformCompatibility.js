const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withAndroidStyles,
  withAppBuildGradle,
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
  config = withAppBuildGradle(config, (gradleConfig) => {
    gradleConfig.modResults.contents = addWindowsNativeBuildDirectory(gradleConfig.modResults.contents);
    return gradleConfig;
  });
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

function addWindowsNativeBuildDirectory(contents) {
  const marker = '// EventAutoPin: Windows native build path';
  contents = contents.replace(/\n?\/\/ EventAutoPin: Windows native build path\nif \(System[\s\S]*?\n}\n?/, '');
  return contents.trimEnd() + `
${marker}
if (System.getProperty('os.name').toLowerCase().contains('windows')) {
    // CMake/Ninjaの260文字制限を避け、checkoutごとに中間生成物を分離する。
    def buildKey = java.security.MessageDigest.getInstance('SHA-256')
        .digest(rootDir.canonicalPath.getBytes('UTF-8')).encodeHex().toString().substring(0, 8)
    def driveRoot = rootDir.toPath().root.toFile()
    android.externalNativeBuild.cmake.buildStagingDirectory = new File(driveRoot, '.ec/' + buildKey)
    android.defaultConfig.externalNativeBuild.cmake.arguments '-DCMAKE_OBJECT_PATH_MAX=250'
}
`;
}

module.exports = createRunOncePlugin(
  withAndroidPlatformCompatibility,
  "with-android-platform-compatibility",
  "1.0.0",
);
module.exports.addSplashBehaviorTargetApi = addSplashBehaviorTargetApi;
module.exports.upsertOptionalCameraFeature = upsertOptionalCameraFeature;
module.exports.addWindowsNativeBuildDirectory = addWindowsNativeBuildDirectory;
