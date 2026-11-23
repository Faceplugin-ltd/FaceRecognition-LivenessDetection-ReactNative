package com.facerecognitionsdk

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import java.io.File
import java.util.Locale

/** Image files directly inside a SAF tree URI — same rule as the Android app ImportActivity. */
internal object FolderImages {
  private val EXTS = setOf("png", "jpg", "jpeg", "heic", "heif", "bmp", "webp")

  data class Item(val uri: String, val fileName: String)

  fun list(context: Context, tree: Uri): List<Item> {
    val out = ArrayList<Item>()
    val destDir = File(context.cacheDir, "frs_import").apply { mkdirs() }
    try {
      val children = DocumentsContract.buildChildDocumentsUriUsingTree(
        tree,
        DocumentsContract.getTreeDocumentId(tree),
      )
      context.contentResolver.query(
        children,
        arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_MIME_TYPE,
        ),
        null,
        null,
        null,
      )?.use { c ->
        while (c.moveToNext()) {
          val docId = c.getString(0) ?: continue
          val name = c.getString(1) ?: continue
          val mime = c.getString(2).orEmpty()
          val ext = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
          if (!(mime.startsWith("image/") || ext in EXTS)) continue
          val docUri = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
          val dest = uniqueFile(destDir, name)
          context.contentResolver.openInputStream(docUri)?.use { input ->
            dest.outputStream().use { input.copyTo(it) }
          } ?: continue
          out += Item("file://${dest.absolutePath}", dest.name)
        }
      }
    } catch (_: Exception) {
    }
    return out.sortedBy { it.fileName.lowercase(Locale.ROOT) }
  }

  private fun uniqueFile(dir: File, name: String): File {
    val safe = name.ifBlank { "photo" }
    var dest = File(dir, safe)
    var n = 1
    while (dest.exists()) {
      dest = File(dir, "${dest.nameWithoutExtension}-$n.${dest.extension}")
      n++
    }
    return dest
  }
}
