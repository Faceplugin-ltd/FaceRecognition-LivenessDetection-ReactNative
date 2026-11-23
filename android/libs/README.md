# Android runtime (customer install)

Place **`facerecognitionsdk.aar`** here after `yarn add face-recognition-sdk`:

```text
node_modules/face-recognition-sdk/android/libs/facerecognitionsdk.aar
```

The bridge is written against the **LX** Face Recognition SDK AAR
(`FaceRecognitionSDK.activate / init / Image.detect / Image.template / similarity`),
built from `Face-Recognition-LivenessDetection-Android-LX-SDK` (`dist/facerecognitionsdk.aar`,
the same file the Android demo app has in `app/libs/`).

Do not commit the AAR.
