package com.facerecognitionsdk

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Rect
import android.net.Uri
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

internal object ImageUtils {
  /** Same cap the engine uses internally, so face boxes come back in this bitmap's coordinates. */
  const val ENGINE_MAX_SIDE = 1280

  fun bitmapFromUri(context: Context, uriString: String): Bitmap? {
    val fixed = if (uriString.startsWith("/")) "file://$uriString" else uriString
    val uri = Uri.parse(fixed)
    val stream: InputStream = context.contentResolver.openInputStream(uri) ?: return null
    stream.use { input ->
      val bytes = input.readBytes()
      val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
      return applyExifOrientation(bytes, bitmap)
    }
  }

  /**
   * Width and height without decoding the pixels, EXIF transposes applied. The live loop asks
   * for the size of every preview frame, and a full decode per frame just to read it is waste.
   */
  fun boundsFromUri(context: Context, uriString: String): Pair<Int, Int>? {
    val fixed = if (uriString.startsWith("/")) "file://$uriString" else uriString
    val uri = Uri.parse(fixed)
    return try {
      val stream: InputStream = context.contentResolver.openInputStream(uri) ?: return null
      stream.use { input ->
        val bytes = input.readBytes()
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        if (opts.outWidth <= 0 || opts.outHeight <= 0) return null
        val orientation = try {
          ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.ORIENTATION_NORMAL,
          )
        } catch (_: Throwable) {
          ExifInterface.ORIENTATION_NORMAL
        }
        val transposed = orientation == ExifInterface.ORIENTATION_ROTATE_90 ||
          orientation == ExifInterface.ORIENTATION_ROTATE_270 ||
          orientation == ExifInterface.ORIENTATION_TRANSPOSE ||
          orientation == ExifInterface.ORIENTATION_TRANSVERSE
        if (transposed) opts.outHeight to opts.outWidth else opts.outWidth to opts.outHeight
      }
    } catch (_: Throwable) {
      null
    }
  }

  fun bitmapFromBase64(base64: String): Bitmap? {
    val cleaned = base64.substringAfter("base64,", base64)
    val bytes = Base64.decode(cleaned, Base64.DEFAULT)
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
    return applyExifOrientation(bytes, bitmap)
  }

  private fun applyExifOrientation(jpegBytes: ByteArray, bitmap: Bitmap): Bitmap {
    return try {
      val exif = ExifInterface(ByteArrayInputStream(jpegBytes))
      val orientation = exif.getAttributeInt(
        ExifInterface.TAG_ORIENTATION,
        ExifInterface.ORIENTATION_NORMAL
      )
      val m = Matrix()
      when (orientation) {
        ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
        ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
        ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
        ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.postScale(-1f, 1f) }
        else -> return bitmap
      }
      Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, m, true)
    } catch (_: Exception) {
      bitmap
    }
  }

  fun scaleDown(src: Bitmap, maxSide: Int): Bitmap {
    if (maxSide <= 0) return src
    val longSide = max(src.width, src.height)
    if (longSide <= maxSide) return src
    val s = maxSide.toFloat() / longSide
    return Bitmap.createScaledBitmap(
      src,
      max(1, (src.width * s).roundToInt()),
      max(1, (src.height * s).roundToInt()),
      true
    )
  }

  /** Face box + [paddingFraction] of the shorter box side (min 4 px), clamped to the image. */
  fun cropPadded(src: Bitmap, box: Rect, paddingFraction: Float): Bitmap? {
    val w = box.width()
    val h = box.height()
    if (w <= 1 || h <= 1) return null
    val pad = max(4, (min(w, h) * paddingFraction).toInt())
    val left = max(0, box.left - pad)
    val top = max(0, box.top - pad)
    val right = min(src.width, box.right + pad)
    val bottom = min(src.height, box.bottom + pad)
    if (right - left <= 1 || bottom - top <= 1) return null
    return try {
      Bitmap.createBitmap(src, left, top, right - left, bottom - top)
    } catch (_: Exception) {
      null
    }
  }

  /** Square crop centred on the face (Probe tile). */
  fun squareAround(src: Bitmap, box: Rect, scale: Float): Bitmap {
    val side = min((max(box.width(), box.height()) * scale).roundToInt(), min(src.width, src.height))
    if (side <= 1) return src
    val left = (box.centerX() - side / 2).coerceIn(0, src.width - side)
    val top = (box.centerY() - side / 2).coerceIn(0, src.height - side)
    return Bitmap.createBitmap(src, left, top, side, side)
  }

  fun jpeg(bitmap: Bitmap, quality: Int): ByteArray {
    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
    return out.toByteArray()
  }
}
