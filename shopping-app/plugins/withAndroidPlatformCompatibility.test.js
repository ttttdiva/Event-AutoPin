const assert = require("node:assert/strict");
const {
  addSplashBehaviorTargetApi,
  upsertOptionalCameraFeature,
} = require("./withAndroidPlatformCompatibility");
const appConfig = require("../app.json");

const cameraPlugin = appConfig.expo.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === "expo-camera",
);
const imagePickerPlugin = appConfig.expo.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === "expo-image-picker",
);
assert.equal(cameraPlugin?.[1]?.recordAudioAndroid, false);
assert.equal(imagePickerPlugin?.[1]?.microphonePermission, false);

const manifest = {
  manifest: {
    $: {},
    "uses-feature": [
      {
        $: {
          "android:name": "android.hardware.camera",
          "android:required": "true",
        },
      },
      { $: { "android:name": "android.hardware.camera.autofocus" } },
      { $: { "android:name": "android.hardware.camera" } },
    ],
  },
};

upsertOptionalCameraFeature(manifest);
upsertOptionalCameraFeature(manifest);

const cameraFeatures = manifest.manifest["uses-feature"].filter(
  (feature) => feature.$["android:name"] === "android.hardware.camera",
);
assert.equal(cameraFeatures.length, 1);
assert.equal(cameraFeatures[0].$["android:required"], "false");
assert.equal(
  manifest.manifest["uses-feature"].some(
    (feature) =>
      feature.$["android:name"] === "android.hardware.camera.autofocus",
  ),
  true,
);

const styles = {
  resources: {
    $: {},
    style: [
      {
        $: { name: "Theme.App.SplashScreen", parent: "Theme.SplashScreen" },
        item: [
          {
            _: "icon_preferred",
            $: { name: "android:windowSplashScreenBehavior" },
          },
        ],
      },
    ],
  },
};

addSplashBehaviorTargetApi(styles);
addSplashBehaviorTargetApi(styles);

const splashBehavior = styles.resources.style[0].item[0];
assert.equal(splashBehavior.$["tools:targetApi"], "33");
assert.equal(styles.resources.$["xmlns:tools"], "http://schemas.android.com/tools");

console.log("Android platform compatibility plugin tests passed");
