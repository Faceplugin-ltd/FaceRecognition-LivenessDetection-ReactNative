package com.facerecognitionsdk

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.SystemClock
import android.util.Base64
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.faceplugin.facerecognitionsdk.FaceRecognitionSDK
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

/**
 * React Native bridge over the LX Face Recognition SDK AAR
 * (FaceRecognitionSDK.activate / init / Image.detect / Image.template / similarity).
 *
 * Every SDK call runs on one single-thread executor, so calls are serialized.
 * The legacy bridge API (faceDetection, templateExtraction, VideoWorker, …) is kept
 * and mapped onto the LX API; VideoWorker is emulated per ingested frame.
 */
class FaceRecognitionSdkModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), ActivityEventListener {

  private val executor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "face-recognition-sdk").apply { isDaemon = true }
  }
  @Volatile private var lastLiveBitmap: Bitmap? = null
  @Volatile private var landmarkMode: Int = LANDMARK_MODE_68
  private var folderPromise: Promise? = null

  init {
    reactContext.addActivityEventListener(this)
  }

  // VideoWorker emulation state (only touched on [executor]).
  private var workerRunning = false
  private var workerThreshold = FaceRecognitionSDK.MATCH_THRESHOLD
  private var workerDb: List<ByteArray> = emptyList()

  override fun getName(): String = NAME

  override fun getConstants(): MutableMap<String, Any> = hashMapOf(
    "SDK_SUCCESS" to FaceRecognitionSDK.SDK_SUCCESS,
    "SDK_LICENSE_INVALID" to FaceRecognitionSDK.SDK_LICENSE_INVALID,
    "SDK_LICENSE_EXPIRED" to FaceRecognitionSDK.SDK_LICENSE_EXPIRED,
    "SDK_NOT_ACTIVATED" to FaceRecognitionSDK.SDK_NOT_ACTIVATED,
    "SDK_INIT_FAILED" to FaceRecognitionSDK.SDK_INIT_FAILED,
    "DETECT_POSE" to DETECT_POSE,
    "DETECT_LANDMARKS" to DETECT_LANDMARKS,
    "DETECT_AGE" to DETECT_AGE,
    "DETECT_GENDER" to DETECT_GENDER,
    "DETECT_EMOTION" to DETECT_EMOTION,
    "DETECT_MASK" to DETECT_MASK,
    "DETECT_QUALITY" to DETECT_QUALITY,
    "DETECT_FACE_QUALITY" to DETECT_FACE_QUALITY,
    "DETECT_EYES" to DETECT_EYES,
    "DETECT_LIVENESS" to DETECT_LIVENESS,
    "DETECT_GLASSES" to DETECT_GLASSES,
    "DETECT_LIVENESS_ACCURATE" to DETECT_LIVENESS_ACCURATE,
    "DETECT_ALL" to -1,
    "LANDMARK_MODE_14" to 14,
    "LANDMARK_MODE_68" to 68,
    "LANDMARK_MODE_468" to 468,
    "MATCH_THRESHOLD" to FaceRecognitionSDK.MATCH_THRESHOLD.toDouble(),
    "LIVENESS_THRESHOLD" to FaceRecognitionSDK.LIVENESS_THRESHOLD.toDouble(),
    "ENGINE" to "lx",
    "SDK_VERSION" to "Face Recognition SDK",
    "FILES_DIR" to reactContext.filesDir.absolutePath,
    "SUPPORTS_SMILE" to true,
    "SUPPORTS_MOUTH_OPEN" to true,
  )

  @ReactMethod
  fun pickFolderImages(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.reject("E_ACTIVITY", "No activity")
      return
    }
    folderPromise = promise
    activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_FOLDER)
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQ_FOLDER) return
    val promise = folderPromise ?: return
    folderPromise = null
    if (resultCode != Activity.RESULT_OK || data?.data == null) {
      promise.resolve(Arguments.createArray())
      return
    }
    val tree = data.data!!
    try {
      activity.contentResolver.takePersistableUriPermission(
        tree,
        Intent.FLAG_GRANT_READ_URI_PERMISSION,
      )
    } catch (_: Exception) {
    }
    val arr = Arguments.createArray()
    FolderImages.list(activity, tree).forEach { item ->
      val map = Arguments.createMap()
      map.putString("uri", item.uri)
      map.putString("fileName", item.fileName)
      arr.pushMap(map)
    }
    promise.resolve(arr)
  }

  override fun onNewIntent(intent: Intent) {}

  @ReactMethod
  fun addListener(eventName: String?) {
    // Required for RN built-in EventEmitter
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // Required for RN built-in EventEmitter
  }

  // ---------------------------------------------------------------- license / lifecycle

  @ReactMethod
  fun getMachineCode(promise: Promise) = run(promise, "E_MACHINE_CODE") {
    FaceRecognitionSDK.machineCode(reactContext.applicationContext) ?: ""
  }

  @ReactMethod
  fun getLicenseStatus(promise: Promise) = run(promise, "E_LICENSE_STATUS") {
    val l = FaceRecognitionSDK.license()
    JSONObject()
      .put("licensed", l.licensed)
      .put("level", l.level)
      .put("levelName", l.levelName ?: "None")
      .put("recognition", l.recognition)
      .put("liveness", l.liveness)
      .put("label", l.label ?: "")
      .toString()
  }

  @ReactMethod
  fun setActivation(license: String, promise: Promise) = run(promise, "E_ACTIVATION") {
    FaceRecognitionSDK.activate(reactContext.applicationContext, license)
  }

  @ReactMethod
  fun init(promise: Promise) = run(promise, "E_INIT") {
    FaceRecognitionSDK.init(reactContext.applicationContext)
  }

  @ReactMethod
  fun deinit(promise: Promise) = run(promise, "E_DEINIT") {
    clearDetectedFaces()
    FaceRecognitionSDK.close()
    null
  }

  @ReactMethod
  fun lastLicenseError(promise: Promise) {
    try {
      promise.resolve(FaceRecognitionSDK.lastLicenseError() ?: "")
    } catch (t: Throwable) {
      promise.reject("E_LICENSE_ERROR", t.message, t)
    }
  }

  /** The LX engine has one landmark set; the mode is remembered for API compatibility only. */
  @ReactMethod
  fun setLandmarkMode(mode: Int, promise: Promise) {
    landmarkMode = mode
    promise.resolve(0)
  }

  @ReactMethod
  fun getLandmarkMode(promise: Promise) {
    promise.resolve(landmarkMode)
  }

  @ReactMethod
  fun estimatorStatus(promise: Promise) {
    promise.resolve(
      JSONObject()
        .put("engine", "lx")
        .put("liveness", true)
        .put("quality", true)
        .put("pose", true)
        .put("ageGender", true)
        .put("eyes", true)
        .put("smile", true)
        .put("mouthOpen", true)
        .put("points", true)
        .toString()
    )
  }

  @ReactMethod
  fun runDocumentsSmoke(promise: Promise) {
    promise.resolve("{\"ok\":false,\"skipped\":true}")
  }

  // ---------------------------------------------------------------- new API (demo)

  /**
   * Decode once (EXIF upright, long side ≤ maxSide) and write a JPEG to the cache.
   * Later calls on the returned URI see the exact same pixels, so boxes line up.
   */
  @ReactMethod
  fun prepareImage(imageUri: String, maxSide: Double, promise: Promise) = run(promise, "E_IMAGE") {
    val bitmap = loadBitmap(imageUri, maxSide.toInt()) ?: throw IllegalArgumentException("Could not decode image")
    val file = File(reactContext.cacheDir, "frs_prepared_${System.nanoTime()}.jpg")
    file.writeBytes(ImageUtils.jpeg(bitmap, 95))
    val map = Arguments.createMap()
    map.putString("uri", "file://${file.absolutePath}")
    map.putDouble("width", bitmap.width.toDouble())
    map.putDouble("height", bitmap.height.toDouble())
    map
  }

  /**
   * Detect with explicit options and (optionally) extract templates on the same decoded image.
   * Options JSON: liveness, quality, pose, ageGender, eyes, expression, points (booleans),
   * templates (max faces to template, 0 = none), sortBySize (largest first), maxSide.
   * Result JSON: { width, height, detectMs, templateMs, faces: [ face… ] }.
   */
  @ReactMethod
  fun detectFaces(imageUri: String, optionsJson: String?, promise: Promise) = run(promise, "E_DETECT") {
    val o = parseJson(optionsJson)
    val maxSide = o.optInt("maxSide", ImageUtils.ENGINE_MAX_SIDE)
    val bitmap = loadBitmap(imageUri, maxSide) ?: throw IllegalArgumentException("Could not decode image")
    val opts = FaceRecognitionSDK.DetectOptions().apply {
      liveness = o.optBoolean("liveness", false)
      quality = o.optBoolean("quality", false)
      pose = o.optBoolean("pose", false)
      ageGender = o.optBoolean("ageGender", false)
      eyes = o.optBoolean("eyes", false)
      expression = o.optBoolean("expression", false)
      points = o.optBoolean("points", false)
    }
    val maxTemplates = o.optInt("templates", 0)
    val out = JSONObject()
    out.put("width", bitmap.width)
    out.put("height", bitmap.height)
    val image = FaceRecognitionSDK.Image.from(bitmap)
    if (image == null) {
      out.put("detectMs", 0.0).put("templateMs", 0.0).put("faces", JSONArray())
      return@run out.toString()
    }
    try {
      val t0 = SystemClock.elapsedRealtimeNanos()
      var faces: List<FaceRecognitionSDK.Face> = image.detect(opts) ?: emptyList()
      val detectMs = (SystemClock.elapsedRealtimeNanos() - t0) / 1e6
      if (o.optBoolean("sortBySize", false)) {
        faces = faces.sortedByDescending { it.bounds.width().toLong() * it.bounds.height() }
      }
      var templateMs = 0.0
      val arr = JSONArray()
      faces.forEachIndexed { i, f ->
        val j = faceJson(f)
        if (i < maxTemplates) {
          val ts = SystemClock.elapsedRealtimeNanos()
          val bytes = try { image.template(f) } catch (_: Throwable) { null }
          val ms = (SystemClock.elapsedRealtimeNanos() - ts) / 1e6
          templateMs += ms
          j.put("templateMs", ms)
          if (bytes != null && bytes.isNotEmpty()) {
            j.put("template", Base64.encodeToString(bytes, Base64.NO_WRAP))
            j.put("templateBytes", bytes.size)
          } else {
            j.put("template", JSONObject.NULL)
            j.put("templateBytes", 0)
          }
        }
        arr.put(j)
      }
      out.put("detectMs", detectMs)
      out.put("templateMs", templateMs)
      out.put("faces", arr)
    } finally {
      image.close()
    }
    out.toString()
  }

  /** 1:N similarity in one bridge call. Bad / empty candidates score -1. */
  @ReactMethod
  fun similarityMany(probeB64: String, candidatesB64: ReadableArray, promise: Promise) = run(promise, "E_SIMILARITY") {
    val probe = Base64.decode(probeB64, Base64.DEFAULT)
    val out = Arguments.createArray()
    for (i in 0 until candidatesB64.size()) {
      val s = candidatesB64.getString(i)
      if (s.isNullOrEmpty()) {
        out.pushDouble(-1.0)
        continue
      }
      val score = try {
        FaceRecognitionSDK.similarity(probe, Base64.decode(s, Base64.DEFAULT)).toDouble()
      } catch (_: Throwable) {
        -1.0
      }
      out.pushDouble(if (score.isNaN()) -1.0 else score)
    }
    out
  }

  /**
   * Write a JPEG of the image (or a face crop) into app-private storage.
   * [path] is absolute, or relative to the app files dir. Options JSON:
   * box {x1,y1,x2,y2}, mode "full" | "padded" | "square", padding (0.12), scale (1.8), maxSide, quality (92).
   * Resolves the file:// URI.
   */
  @ReactMethod
  fun writeFaceImage(imageUri: String, path: String, optionsJson: String?, promise: Promise) = run(promise, "E_WRITE") {
    val o = parseJson(optionsJson)
    val maxSide = o.optInt("maxSide", ImageUtils.ENGINE_MAX_SIDE)
    val bitmap = loadBitmap(imageUri, maxSide) ?: throw IllegalArgumentException("Could not decode image")
    val boxJson = o.optJSONObject("box")
    val box = boxJson?.let { Rect(it.optInt("x1"), it.optInt("y1"), it.optInt("x2"), it.optInt("y2")) }
    val out: Bitmap = when (o.optString("mode", if (box == null) "full" else "padded")) {
      "square" -> if (box != null) ImageUtils.squareAround(bitmap, box, o.optDouble("scale", 1.8).toFloat()) else bitmap
      "padded" -> if (box != null) ImageUtils.cropPadded(bitmap, box, o.optDouble("padding", 0.12).toFloat()) ?: bitmap else bitmap
      else -> bitmap
    }
    val file = resolveFile(path)
    file.parentFile?.mkdirs()
    file.writeBytes(ImageUtils.jpeg(out, o.optInt("quality", 92)))
    "file://${file.absolutePath}"
  }

  @ReactMethod
  fun deleteFiles(paths: ReadableArray, promise: Promise) = run(promise, "E_DELETE") {
    var n = 0
    for (i in 0 until paths.size()) {
      val p = paths.getString(i)
      if (p.isNullOrEmpty()) continue
      if (resolveFile(p).delete()) n++
    }
    n
  }

  /** Deletes every file inside [path] (absolute or relative to the files dir); keeps the directory. */
  @ReactMethod
  fun deleteDirectory(path: String, promise: Promise) = run(promise, "E_DELETE") {
    var n = 0
    resolveFile(path).listFiles()?.forEach { if (it.isFile && it.delete()) n++ }
    n
  }

  // ---------------------------------------------------------------- legacy API on LX

  @ReactMethod
  fun detect(imageUri: String, crop: Boolean, flags: Double, promise: Promise) = run(promise, "E_DETECT") {
    val bitmap = loadBitmap(imageUri, 0) ?: throw IllegalArgumentException("Could not decode image: $imageUri")
    val faces = detectOn(bitmap, optionsFromFlags(flags))
    JSONObject().put("faces", JSONArray().apply { faces.forEach { put(faceJson(it)) } }).toString()
  }

  @ReactMethod
  fun faceDetection(imageUri: String, paramJson: String?, promise: Promise) = run(promise, "E_FACE_DETECTION") {
    val bitmap = loadBitmap(imageUri, 0) ?: throw IllegalArgumentException("Could not decode image: $imageUri")
    val faces = detectOn(bitmap, optionsFromParam(paramJson))
    JSONArray().apply { faces.forEach { put(faceJson(it)) } }.toString()
  }

  @ReactMethod
  fun templateExtraction(imageUri: String, faceBoxJson: String, promise: Promise) = run(promise, "E_TEMPLATE") {
    val bitmap = loadBitmap(imageUri, 0) ?: throw IllegalArgumentException("Could not decode image: $imageUri")
    val id = JSONObject(faceBoxJson).optString("detectionId", "")
    val face = detectedFaces[id]
      ?: throw IllegalArgumentException("Missing or expired detection result")
    val bytes = FaceRecognitionSDK.template(bitmap, face)
    if (bytes == null || bytes.isEmpty()) throw IllegalStateException("template returned null")
    Base64.encodeToString(bytes, Base64.NO_WRAP)
  }

  /** 1.4× square around the box, scaled to 200×200 (same window as before; see mapLandmarksToCrop). */
  @ReactMethod
  fun cropFace(imageUri: String, faceBoxJson: String, promise: Promise) = run(promise, "E_CROP") {
    val bitmap = loadBitmap(imageUri, 0) ?: throw IllegalArgumentException("Could not decode image: $imageUri")
    val box = boxFromJson(faceBoxJson) ?: throw IllegalArgumentException("Invalid face box JSON")
    val cx = (box.left + box.right) / 2f
    val cy = (box.top + box.bottom) / 2f
    var cw = (box.width() * 1.4f).toInt()
    if (cw < 2) cw = max(2, max(box.width(), box.height()))
    val x1 = max(0f, cx - cw / 2f).toInt()
    val y1 = max(0f, cy - cw / 2f).toInt()
    val x2 = min(bitmap.width - 1f, cx + cw / 2f).toInt()
    val y2 = min(bitmap.height - 1f, cy + cw / 2f).toInt()
    if (x2 - x1 < 2 || y2 - y1 < 2) throw IllegalStateException("cropFace: empty crop")
    val cropped = Bitmap.createBitmap(bitmap, x1, y1, x2 - x1 + 1, y2 - y1 + 1)
    val scaled = Bitmap.createScaledBitmap(cropped, 200, 200, true)
    Base64.encodeToString(ImageUtils.jpeg(scaled, 85), Base64.NO_WRAP)
  }

  /** Template of the largest face: { "feature": base64 } or {} when no face. */
  @ReactMethod
  fun extractFeature(imageUri: String, promise: Promise) = run(promise, "E_FEATURE") {
    val bitmap = loadBitmap(imageUri, 0) ?: throw IllegalArgumentException("Could not decode image: $imageUri")
    val image = FaceRecognitionSDK.Image.from(bitmap) ?: return@run "{}"
    try {
      val face = (image.detect(FaceRecognitionSDK.DetectOptions()) ?: emptyList())
        .maxByOrNull { it.bounds.width().toLong() * it.bounds.height() } ?: return@run "{}"
      val bytes = image.template(face) ?: return@run "{}"
      JSONObject().put("feature", Base64.encodeToString(bytes, Base64.NO_WRAP)).toString()
    } finally {
      image.close()
    }
  }

  @ReactMethod
  fun similarity(feature1B64: String, feature2B64: String, promise: Promise) = run(promise, "E_SIMILARITY") {
    val f1 = Base64.decode(feature1B64, Base64.DEFAULT)
    val f2 = Base64.decode(feature2B64, Base64.DEFAULT)
    FaceRecognitionSDK.similarity(f1, f2).toDouble()
  }

  @ReactMethod
  fun quality(imageUri: String, crop: Boolean, promise: Promise) = run(promise, "E_QUALITY") {
    val bitmap = loadBitmap(imageUri, 0) ?: throw IllegalArgumentException("Could not decode image: $imageUri")
    val opts = FaceRecognitionSDK.DetectOptions().apply { quality = true }
    val faces = detectOn(bitmap, opts)
    JSONObject().put("faces", JSONArray().apply { faces.forEach { put(faceJson(it)) } }).toString()
  }

  // ---------------------------------------------------------------- VideoWorker (emulated)

  @ReactMethod
  fun startVideoWorker(configJson: String?, promise: Promise) = run(promise, "E_VIDEO_WORKER") {
    workerThreshold = parseJson(configJson).optDouble("matchThreshold", FaceRecognitionSDK.MATCH_THRESHOLD.toDouble()).toFloat()
    // A new session starts without a gallery: the capture guide never matches frames.
    // IdentifySession syncs its gallery right after starting.
    workerDb = emptyList()
    workerRunning = true
    0
  }

  @ReactMethod
  fun stopVideoWorker(promise: Promise) = run(promise, "E_VIDEO_WORKER") {
    workerRunning = false
    null
  }

  @ReactMethod
  fun syncVideoWorkerDatabase(featuresB64: ReadableArray, matchThreshold: Double, promise: Promise) = run(promise, "E_SYNC_DB") {
    val list = ArrayList<ByteArray>(featuresB64.size())
    for (i in 0 until featuresB64.size()) {
      val s = featuresB64.getString(i) ?: continue
      list.add(Base64.decode(s, Base64.DEFAULT))
    }
    workerDb = list
    workerThreshold = matchThreshold.toFloat()
    0
  }

  @ReactMethod
  fun probeLiveImage(imageUri: String, promise: Promise) = run(promise, "E_IMAGE") {
    // Bounds only. This runs once per preview frame and all the caller wants is the size, so
    // decoding the whole snapshot here cost a full-resolution bitmap per frame for nothing.
    val size = ImageUtils.boundsFromUri(reactContext, imageUri)
    val (w, h) = if (size != null && size.first > 0 && size.second > 0) {
      size
    } else {
      val bitmap = loadBitmap(imageUri, 0)
        ?: throw IllegalArgumentException("Could not decode image: $imageUri")
      bitmap.width to bitmap.height
    }
    val map = Arguments.createMap()
    map.putDouble("width", w.toDouble())
    map.putDouble("height", h.toDouble())
    map
  }

  /**
   * Detect on the frame [applyLiveFrame] already prepared and cached, so the live loop does not
   * have to write that frame out as a JPEG and read it back just to detect on it.
   */
  @ReactMethod
  fun detectLastLiveFrame(optionsJson: String?, promise: Promise) = run(promise, "E_DETECT") {
    val frame = lastLiveBitmap ?: throw IllegalStateException("No live frame")
    val o = parseJson(optionsJson)
    val opts = FaceRecognitionSDK.DetectOptions().apply {
      liveness = o.optBoolean("liveness", false)
      quality = o.optBoolean("quality", false)
      pose = o.optBoolean("pose", false)
      ageGender = o.optBoolean("ageGender", false)
      eyes = o.optBoolean("eyes", false)
      expression = o.optBoolean("expression", false)
      points = o.optBoolean("points", false)
    }
    val out = JSONObject()
    out.put("width", frame.width)
    out.put("height", frame.height)
    val image = FaceRecognitionSDK.Image.from(frame)
    if (image == null) {
      out.put("detectMs", 0.0).put("faces", JSONArray())
      return@run out.toString()
    }
    try {
      val t0 = SystemClock.elapsedRealtimeNanos()
      val faces: List<FaceRecognitionSDK.Face> = image.detect(opts) ?: emptyList()
      out.put("detectMs", (SystemClock.elapsedRealtimeNanos() - t0) / 1e6)
      val arr = JSONArray()
      faces.forEach { arr.put(faceJson(it)) }
      out.put("faces", arr)
    } finally {
      image.close()
    }
    out.toString()
  }

  @ReactMethod
  fun applyLiveFrame(
    imageUri: String,
    rotateDegrees: Double,
    maxEdge: Double,
    feedWorker: Boolean,
    flipVertical: Boolean,
    promise: Promise
  ) = run(promise, "E_FRAME") {
    val bitmap = loadBitmap(imageUri, 0) ?: throw IllegalArgumentException("Could not decode image: $imageUri")
    val prepared = applyLiveTransform(
      bitmap,
      rotateDegrees.toFloat(),
      maxEdge.toInt().coerceAtLeast(1),
      flipVertical
    )
    lastLiveBitmap = prepared
    if (feedWorker) {
      if (workerRunning) runWorkerFrame(prepared)
      liveFrameMap(prepared, ingested = true, uri = null)
    } else {
      liveFrameMap(prepared, ingested = true, uri = writeLiveJpeg(prepared))
    }
  }

  @ReactMethod
  fun exportLastLiveFrame(promise: Promise) = run(promise, "E_FRAME") {
    val prepared = lastLiveBitmap ?: throw IllegalStateException("No live frame")
    liveFrameMap(prepared, ingested = true, uri = writeLiveJpeg(prepared))
  }

  @ReactMethod
  fun writeStatus(json: String, promise: Promise) {
    try {
      File(reactContext.filesDir, "facerecognition_status.json").writeText(json)
      promise.resolve(null)
    } catch (t: Throwable) {
      promise.reject("E_STATUS", t.message, t)
    }
  }

  /** One tracking event per ingested frame (plus a match event) — VideoWorker JSON shape. */
  private fun runWorkerFrame(frame: Bitmap) {
    val image = FaceRecognitionSDK.Image.from(frame) ?: return
    try {
      // Pose and landmarks only, as the native capture guide asks for.
      val opts = FaceRecognitionSDK.DetectOptions().apply { pose = true; points = true }
      val faces = image.detect(opts) ?: emptyList()
      val arr = JSONArray()
      var matchEvent: JSONObject? = null
      faces.forEachIndexed { i, f ->
        val b = f.bounds
        val o = JSONObject()
        o.put("track_id", i)
        o.put("faceRegion", JSONObject().put("x", b.left).put("y", b.top).put("width", b.width()).put("height", b.height()))
        o.put(
          "facePose",
          JSONObject().put("yaw", num(f.yaw, 0.0)).put("pitch", num(f.pitch, 0.0)).put("roll", num(f.roll, 0.0))
        )
        val pts = JSONArray()
        val p = f.points
        if (p != null) {
          var k = 0
          while (k + 1 < p.size) {
            pts.put(JSONObject().put("x", p[k].toDouble()).put("y", p[k + 1].toDouble()))
            k += 2
          }
        }
        o.put("facePoints", pts)
        if (!f.eyesOpen.isNaN()) o.put("eyes_open", f.eyesOpen.toDouble())
        o.put("weak", false)
        if (i == 0 && workerDb.isNotEmpty()) {
          val feature = try { image.template(f) } catch (_: Throwable) { null }
          if (feature != null && feature.isNotEmpty()) {
            var best = -1
            var bestScore = -1f
            workerDb.forEachIndexed { idx, t ->
              val s = try { FaceRecognitionSDK.similarity(feature, t) } catch (_: Throwable) { -1f }
              if (s > bestScore) { bestScore = s; best = idx }
            }
            val matched = best >= 0 && bestScore >= workerThreshold
            o.put("match", JSONObject().put("matched", matched).put("person_index", best).put("score", bestScore.toDouble()))
            if (matched) {
              matchEvent = JSONObject().put("event", "match").put("track_id", i).put("matched", true)
                .put("person_index", best).put("score", bestScore.toDouble())
            }
          }
        }
        arr.put(o)
      }
      emitVideoWorkerEvent(
        JSONObject().put("event", "tracking").put("frame_width", frame.width).put("frame_height", frame.height)
          .put("faces", arr).toString()
      )
      matchEvent?.let { emitVideoWorkerEvent(it.toString()) }
    } catch (_: Throwable) {
      // a bad frame must not stop the camera loop
    } finally {
      image.close()
    }
  }

  // ---------------------------------------------------------------- helpers

  /** Runs [block] on the SDK executor and resolves its value (Unit/null → null). */
  private fun run(promise: Promise, code: String, block: () -> Any?) {
    executor.execute {
      try {
        val v = block()
        promise.resolve(if (v is Unit) null else v)
      } catch (t: Throwable) {
        promise.reject(code, t.message ?: t.javaClass.simpleName, t)
      }
    }
  }

  private fun emitVideoWorkerEvent(json: String) {
    if (!reactContext.hasActiveReactInstance()) return
    val map: WritableMap = Arguments.createMap()
    map.putString("json", json)
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(EVENT_VIDEO_WORKER, map)
  }

  private fun loadBitmap(uriOrBase64: String, maxSide: Int): Bitmap? {
    val bmp = if (uriOrBase64.startsWith("data:") || looksLikeBase64(uriOrBase64)) {
      ImageUtils.bitmapFromBase64(uriOrBase64)
    } else {
      ImageUtils.bitmapFromUri(reactContext, uriOrBase64)
    } ?: return null
    val argb = if (bmp.config == Bitmap.Config.ARGB_8888) bmp else bmp.copy(Bitmap.Config.ARGB_8888, false) ?: bmp
    return ImageUtils.scaleDown(argb, maxSide)
  }

  private fun looksLikeBase64(s: String): Boolean {
    if (s.startsWith("content:") || s.startsWith("file:") || s.startsWith("/")) return false
    return s.length > 256 && !s.contains("://")
  }

  private fun resolveFile(path: String): File {
    val p = if (path.startsWith("file://")) path.removePrefix("file://") else path
    val f = File(p)
    return if (f.isAbsolute) f else File(reactContext.filesDir, p)
  }

  private fun parseJson(json: String?): JSONObject = try {
    if (json.isNullOrBlank()) JSONObject() else JSONObject(json)
  } catch (_: Exception) {
    JSONObject()
  }

  private fun detectOn(bitmap: Bitmap, opts: FaceRecognitionSDK.DetectOptions): List<FaceRecognitionSDK.Face> {
    val image = FaceRecognitionSDK.Image.from(bitmap) ?: return emptyList()
    return try {
      image.detect(opts) ?: emptyList()
    } finally {
      image.close()
    }
  }

  private fun allOptions() = FaceRecognitionSDK.DetectOptions().apply {
    liveness = true; quality = true; pose = true; ageGender = true; eyes = true; expression = true; points = true
  }

  private fun optionsFromParam(paramJson: String?): FaceRecognitionSDK.DetectOptions {
    val o = parseJson(paramJson)
    if (o.optBoolean("allAttributes", false)) return allOptions()
    return FaceRecognitionSDK.DetectOptions().apply {
      liveness = o.optBoolean("check_liveness", false)
      quality = o.optBoolean("check_quality", false)
      pose = o.optBoolean("check_pose", true)
      ageGender = o.optBoolean("estimate_age_gender", false)
      eyes = o.optBoolean("check_eye_closeness", false) || o.optBoolean("check_face_occlusion", false)
      expression = o.optBoolean("check_emotion", false)
      points = o.optBoolean("check_landmarks", true)
    }
  }

  private fun optionsFromFlags(flags: Double): FaceRecognitionSDK.DetectOptions {
    val bits = flags.toLong()
    if (bits < 0 || bits >= 0xffffffffL) return allOptions()
    fun has(bit: Int) = (bits and bit.toLong()) != 0L
    return FaceRecognitionSDK.DetectOptions().apply {
      pose = has(DETECT_POSE)
      points = has(DETECT_LANDMARKS)
      ageGender = has(DETECT_AGE) || has(DETECT_GENDER)
      expression = has(DETECT_EMOTION)
      quality = has(DETECT_QUALITY) || has(DETECT_FACE_QUALITY)
      eyes = has(DETECT_EYES)
      liveness = has(DETECT_LIVENESS) || has(DETECT_LIVENESS_ACCURATE)
    }
  }

  private fun boxFromJson(json: String?): Rect? = try {
    val o = JSONObject(json ?: "")
    Rect(o.optInt("x1"), o.optInt("y1"), o.optInt("x2"), o.optInt("y2"))
  } catch (_: Exception) {
    null
  }

  private fun num(v: Float, fallback: Double): Double = if (v.isNaN()) fallback else v.toDouble()

  private fun numOrNull(v: Float): Any = if (v.isNaN()) JSONObject.NULL else v.toDouble()

  /**
   * One LX face in the FaceBox JSON shape (legacy fields kept), plus the raw LX values.
   * Values the engine did not compute are null (raw) / 0 or "" (legacy fields).
   */
    // Keep the original SDK result across the JSON bridge, never re-detect by box.
    // Bounded to the most recent 256 faces; stale handles fail explicitly.
    private val detectedFaces = LinkedHashMap<String, FaceRecognitionSDK.Face>()

    private fun rememberFace(face: FaceRecognitionSDK.Face): String {
        val id = java.util.UUID.randomUUID().toString()
        detectedFaces[id] = face
        while (detectedFaces.size > 256) detectedFaces.remove(detectedFaces.keys.first())
        return id
    }

    fun clearDetectedFaces() { detectedFaces.clear() }

  private fun faceJson(f: FaceRecognitionSDK.Face): JSONObject {
    val b = f.bounds
    val o = JSONObject()
    o.put("detectionId", rememberFace(f))
    o.put("x1", b.left)
    o.put("y1", b.top)
    o.put("x2", b.right)
    o.put("y2", b.bottom)
    o.put("score", numOrNull(f.score))
    o.put("yaw", num(f.yaw, 0.0))
    o.put("roll", num(f.roll, 0.0))
    o.put("pitch", num(f.pitch, 0.0))
    o.put("poseComputed", !f.yaw.isNaN())
    if (f.liveness.isNaN()) {
      o.put("liveness", 0.0)
      o.put("livenessLabel", "")
    } else {
      o.put("liveness", f.liveness.toDouble())
      o.put("livenessLabel", if (f.liveness > FaceRecognitionSDK.LIVENESS_THRESHOLD) "Live" else "Fake")
    }
    o.put("quality", numOrNull(f.quality))
    o.put("face_quality", if (f.quality.isNaN()) num(f.score, 0.0) else f.quality.toDouble())
    o.put("face_luminance", 0.0)
    if (f.eyesOpen.isNaN()) {
      o.put("eyes_open", JSONObject.NULL)
      o.put("left_eye_closed", 0.0)
      o.put("right_eye_closed", 0.0)
    } else {
      val closed = 1.0 - f.eyesOpen
      o.put("eyes_open", f.eyesOpen.toDouble())
      o.put("left_eye_closed", closed)
      o.put("right_eye_closed", closed)
    }
    o.put("smile", numOrNull(f.smile))
    o.put("emotionLabel", if (f.smile.isNaN()) "" else if (f.smile >= SMILE_THRESHOLD) "Smiling" else "Neutral")
    o.put("mouth_opened", numOrNull(f.mouthOpen))
    o.put("face_occlusion", 0.0)
    o.put("age", if (f.age > 0) f.age else 0)
    o.put("gender", f.gender)
    o.put("genderLabel", f.genderLabel ?: "")
    o.put("maskLabel", "")
    o.put("qualityLabel", "")
    // Open/Closed words depend on the app's eye threshold, so the engine does not label eyes.
    o.put("eyesLeftLabel", "")
    o.put("eyesRightLabel", "")
    o.put("glassesLabel", "")
    o.put("sunglassesLabel", "")
    o.put("occlusionLabel", "")
    o.put("attributes", JSONObject())
    val lm = JSONArray()
    val p = f.points
    val n = if (p == null) 0 else p.size / 2
    for (i in 0 until n * 2) lm.put(p!![i].toDouble())
    o.put("landmarkCount", n)
    o.put("landmarks", lm)
    return o
  }

  private fun liveFrameMap(prepared: Bitmap, ingested: Boolean, uri: String?): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("ingested", ingested)
    map.putDouble("width", prepared.width.toDouble())
    map.putDouble("height", prepared.height.toDouble())
    if (uri != null) map.putString("uri", uri) else map.putNull("uri")
    return map
  }

  private fun writeLiveJpeg(prepared: Bitmap): String {
    val file = File(reactContext.cacheDir, "frs_live_${System.currentTimeMillis()}.jpg")
    file.outputStream().use { out ->
      prepared.compress(Bitmap.CompressFormat.JPEG, 85, out)
    }
    return "file://${file.absolutePath}"
  }

  /** Rotate by degrees (JS policy), optionally mirror on Y, then scale long edge ≤ maxEdge. */
  private fun applyLiveTransform(
    src: Bitmap,
    rotateDegrees: Float,
    maxEdge: Int,
    flipVertical: Boolean
  ): Bitmap {
    var frame = src
    val deg = rotateDegrees % 360f
    if (kotlin.math.abs(deg) > 0.01f || flipVertical) {
      val matrix = android.graphics.Matrix().apply {
        if (kotlin.math.abs(deg) > 0.01f) postRotate(deg)
        if (flipVertical) postScale(1f, -1f)
      }
      frame = Bitmap.createBitmap(frame, 0, 0, frame.width, frame.height, matrix, true)
    }
    return ImageUtils.scaleDown(frame, maxEdge)
  }

  companion object {
    const val NAME = "FaceRecognitionSdk"
    const val EVENT_VIDEO_WORKER = "FaceRecognitionVideoWorkerEvent"
    const val SMILE_THRESHOLD = 0.5f

    const val DETECT_POSE = 1 shl 0
    const val DETECT_LANDMARKS = 1 shl 1
    const val DETECT_AGE = 1 shl 2
    const val DETECT_GENDER = 1 shl 3
    const val DETECT_EMOTION = 1 shl 4
    const val DETECT_MASK = 1 shl 5
    const val DETECT_QUALITY = 1 shl 6
    const val DETECT_FACE_QUALITY = 1 shl 7
    const val DETECT_EYES = 1 shl 8
    const val DETECT_LIVENESS = 1 shl 9
    const val DETECT_GLASSES = 1 shl 11
    const val DETECT_LIVENESS_ACCURATE = 1 shl 16
    const val LANDMARK_MODE_68 = 68
    const val REQ_FOLDER = 0x4652
  }
}
