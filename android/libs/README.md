# Android runtime (customer install)

Place **`facerecognitionsdk.aar`** here after `yarn add face-recognition-sdk`:

```text
node_modules/face-recognition-sdk/android/libs/facerecognitionsdk.aar
```

The bridge is written against the Face Recognition SDK AAR
(`FaceRecognitionSDK.activate / init / Image.detect / Image.template / similarity`) —
the same `facerecognitionsdk.aar` the Android demo app has in `app/libs/`.

Do not commit the AAR.
