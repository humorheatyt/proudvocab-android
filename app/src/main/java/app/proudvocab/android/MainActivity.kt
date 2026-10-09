package app.proudvocab.android

import android.app.Activity
import android.content.Intent
import android.database.Cursor
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.AtomicFile
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.documentfile.provider.DocumentFile
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.min

class MainActivity : ComponentActivity() {
    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var pickerLauncher: ActivityResultLauncher<Intent>
    private lateinit var assetLoader: WebViewAssetLoader
    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor: ExecutorService = Executors.newCachedThreadPool()
    private val activeConnections = ConcurrentHashMap<String, HttpURLConnection>()
    private val initialFiles = mutableListOf<String>()
    private val pendingEvents = mutableListOf<Pair<String, JSONObject>>()
    private var pageLoaded = false
    private var operation: PickerOperation? = null
    private var webFileCallback: ValueCallback<Array<Uri>>? = null
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var isImmersive = false
    private var keepScreenAwake = false

    private val preferences by lazy { getSharedPreferences("pv_file_grants", MODE_PRIVATE) }
    private val dataFile by lazy { File(filesDir, "proudvocab-data/store.json") }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(7, 10, 18)
        window.navigationBarColor = Color.rgb(7, 10, 18)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.setBackgroundDrawableResource(android.R.color.black)

        pickerLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            handlePickerResult(result.resultCode, result.data)
        }
        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(ASSET_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        root = FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(7, 10, 18))
            ViewCompat.setOnApplyWindowInsetsListener(this) { view, insets ->
                val safeInsets = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
                )
                view.setPadding(safeInsets.left, safeInsets.top, safeInsets.right, safeInsets.bottom)
                insets
            }
        }
        webView = WebView(this).apply {
            setBackgroundColor(Color.rgb(7, 10, 18))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = false
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = true
            settings.allowFileAccessFromFileURLs = false
            settings.allowUniversalAccessFromFileURLs = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            settings.displayZoomControls = false
            settings.textZoom = 100
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.safeBrowsingEnabled = true
            overScrollMode = View.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            addJavascriptInterface(AndroidJavascriptBridge(), "AndroidBridge")
            webViewClient = LocalContentWebViewClient()
            webChromeClient = LocalContentWebChromeClient()
            setDownloadListener { url, _, _, _, _ ->
                url?.let { if (it.startsWith("http://") || it.startsWith("https://")) openExternal(it) }
            }
        }
        root.addView(webView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)
        ViewCompat.requestApplyInsets(root)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (customView != null) {
                    hideCustomView()
                } else if (isImmersive) {
                    setImmersiveMode(false)
                } else if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        captureIncomingIntent(intent)
        webView.loadUrl(APP_URL)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val before = synchronized(initialFiles) { initialFiles.size }
        captureIncomingIntent(intent)
        val added = synchronized(initialFiles) { initialFiles.drop(before) }
        if (added.isNotEmpty() && pageLoaded) {
            val payload = JSONObject().put("filePaths", JSONArray(added))
            dispatchEvent("pv:open-files", payload)
        }
    }

    override fun onPause() {
        // Persist player progress and extension state even when Android moves
        // the activity to the background without destroying the WebView.
        if (::webView.isInitialized) {
            webView.evaluateJavascript(
                "try{window.__pvBus&&window.__pvBus.flushStorage&&window.__pvBus.flushStorage();}catch(e){}",
                null,
            )
            webView.onPause()
        }
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) webView.onResume()
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("AndroidBridge")
            webView.stopLoading()
            webView.loadUrl("about:blank")
            webView.destroy()
        }
        ioExecutor.shutdownNow()
        activeConnections.values.forEach { it.disconnect() }
        activeConnections.clear()
        super.onDestroy()
    }

    private fun captureIncomingIntent(incoming: Intent?) {
        if (incoming == null) return
        val uris = mutableListOf<Uri>()
        when (incoming.action) {
            Intent.ACTION_VIEW -> incoming.data?.let { uris.add(it) }
            Intent.ACTION_SEND -> {
                @Suppress("DEPRECATION")
                val shared = incoming.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                shared?.let { uris.add(it) }
                incoming.clipData?.let { clip ->
                    for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(uris::add)
                }
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                @Suppress("DEPRECATION")
                val shared = incoming.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
                shared?.let(uris::addAll)
                incoming.clipData?.let { clip ->
                    for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(uris::add)
                }
            }
        }
        uris.distinct().forEach { uri ->
            persistReadGrant(uri, incoming.flags)
            val name = queryDisplayName(uri) ?: uri.lastPathSegment ?: "media"
            val virtual = registerDocument(uri, name, null, null)
            if (isVideoName(name) || isSubtitleName(name) || incoming.type?.startsWith("video/") == true) {
                synchronized(initialFiles) { initialFiles.add(virtual) }
            }
        }
    }

    private fun handlePickerResult(resultCode: Int, data: Intent?) {
        val pending = operation
        operation = null
        if (pending == null) return
        val granted = resultCode == Activity.RESULT_OK && data != null
        val uris = if (granted) collectResultUris(data!!) else emptyList()
        uris.forEach { persistReadGrant(it, data?.flags ?: 0) }

        when (pending.kind) {
            PickerKind.WEB_FILE -> {
                val callback = webFileCallback
                webFileCallback = null
                callback?.onReceiveValue(if (granted) uris.toTypedArray() else null)
            }
            PickerKind.VIDEO, PickerKind.SUBTITLE -> {
                val files = uris.mapNotNull { uri ->
                    val name = queryDisplayName(uri) ?: uri.lastPathSegment ?: return@mapNotNull null
                    registerDocument(uri, name, null, null)
                }
                complete(pending.requestId, JSONObject()
                    .put("canceled", files.isEmpty())
                    .put("filePaths", JSONArray(files)))
            }
            PickerKind.FOLDER -> {
                val treeUri = uris.firstOrNull()
                if (treeUri == null) {
                    complete(pending.requestId, JSONObject().put("canceled", true).put("filePaths", JSONArray()))
                } else {
                    val flags = (data?.flags ?: 0) and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    try { contentResolver.takePersistableUriPermission(treeUri, flags or Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                    catch (_: SecurityException) { /* temporary grant remains usable this session */ }
                    complete(pending.requestId, JSONObject().put("canceled", false).put("filePaths", JSONArray().put(treeUri.toString())))
                }
            }
            PickerKind.SAVE -> {
                val target = uris.firstOrNull()
                if (target == null) {
                    complete(pending.requestId, JSONObject().put("ok", false).put("canceled", true))
                } else {
                    ioExecutor.execute {
                        val result = runCatching {
                            contentResolver.openOutputStream(target, "wt")?.use { output ->
                                output.write(pending.bytes ?: ByteArray(0))
                                output.flush()
                            } ?: throw IllegalStateException("Storage provider did not open the file")
                            JSONObject().put("ok", true).put("uri", target.toString())
                        }.getOrElse { error -> JSONObject().put("ok", false).put("error", error.message ?: "Export failed") }
                        complete(pending.requestId, result)
                    }
                }
            }
        }
    }

    private fun collectResultUris(data: Intent): List<Uri> {
        val found = mutableListOf<Uri>()
        data.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(found::add)
        }
        data.data?.let { found.add(it) }
        return found.distinct()
    }

    private fun persistReadGrant(uri: Uri, flags: Int) {
        val grantFlags = flags and Intent.FLAG_GRANT_READ_URI_PERMISSION
        if (grantFlags == 0) return
        try { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        catch (_: SecurityException) { /* providers may grant a temporary, non-persistable URI */ }
    }

    private fun launchDocumentPicker(requestId: String, kind: String) {
        onMain {
            if (operation != null) {
                complete(requestId, JSONObject().put("canceled", true).put("filePaths", JSONArray()))
                return@onMain
            }
            val pickerKind = if (kind == "subtitle") PickerKind.SUBTITLE else PickerKind.VIDEO
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, if (pickerKind == PickerKind.SUBTITLE) {
                    arrayOf("text/*", "application/x-subrip", "application/octet-stream")
                } else {
                    arrayOf("video/*", "application/octet-stream")
                })
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, pickerKind == PickerKind.VIDEO)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }
            operation = PickerOperation(pickerKind, requestId)
            try { pickerLauncher.launch(intent) }
            catch (error: Exception) {
                operation = null
                complete(requestId, JSONObject().put("canceled", true).put("filePaths", JSONArray()).put("error", error.message ?: "Could not open document picker"))
            }
        }
    }

    private fun launchFolderPicker(requestId: String) {
        onMain {
            if (operation != null) {
                complete(requestId, JSONObject().put("canceled", true).put("filePaths", JSONArray()))
                return@onMain
            }
            operation = PickerOperation(PickerKind.FOLDER, requestId)
            try {
                pickerLauncher.launch(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                })
            } catch (error: Exception) {
                operation = null
                complete(requestId, JSONObject().put("canceled", true).put("filePaths", JSONArray()).put("error", error.message ?: "Could not open folder picker"))
            }
        }
    }

    private fun launchSavePicker(requestId: String, fileName: String, mimeType: String, bytes: ByteArray) {
        onMain {
            if (operation != null) {
                complete(requestId, JSONObject().put("ok", false).put("error", "Another file picker is already open"))
                return@onMain
            }
            val safeName = fileName.substringAfterLast('/').substringAfterLast('\\').ifBlank { "proudvocab-export.json" }
            operation = PickerOperation(PickerKind.SAVE, requestId, safeName, bytes)
            try {
                pickerLauncher.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = mimeType.ifBlank { mimeForName(safeName) }
                    putExtra(Intent.EXTRA_TITLE, safeName)
                    addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                })
            } catch (error: Exception) {
                operation = null
                complete(requestId, JSONObject().put("ok", false).put("error", error.message ?: "Could not open save dialog"))
            }
        }
    }

    private fun launchWebFileChooser(params: WebChromeClient.FileChooserParams, callback: ValueCallback<Array<Uri>>): Boolean {
        onMain {
            webFileCallback?.onReceiveValue(null)
            webFileCallback = callback
            if (operation != null) {
                webFileCallback = null
                callback.onReceiveValue(null)
                return@onMain
            }
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                val acceptTypes = params.acceptTypes.map { it.trim() }.filter { it.isNotEmpty() && it != "*/*" }.toTypedArray()
                if (acceptTypes.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes)
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }
            operation = PickerOperation(PickerKind.WEB_FILE, null)
            try { pickerLauncher.launch(intent) }
            catch (_: Exception) {
                operation = null
                webFileCallback = null
                callback.onReceiveValue(null)
            }
        }
        return true
    }

    private fun listVideos(treeUriString: String): JSONObject {
        val treeUri = Uri.parse(treeUriString)
        val rootDocument = DocumentFile.fromTreeUri(this, treeUri)
            ?: return JSONObject().put("ok", false).put("files", JSONArray())
        val treeId = runCatching { DocumentsContract.getTreeDocumentId(treeUri) }.getOrNull()
        val files = rootDocument.listFiles().mapNotNull { document ->
            val name = document.name ?: return@mapNotNull null
            if (!isVideoName(name)) return@mapNotNull null
            val path = registerDocument(document.uri, name, treeUriString, treeId)
            JSONObject().put("name", name).put("path", path).put("size", document.length()).put("mtime", document.lastModified())
        }.sortedBy { it.optString("name").lowercase(Locale.ROOT) }
        return JSONObject().put("ok", true).put("files", JSONArray(files))
    }

    private fun scanSubtitles(videoPath: String): JSONObject {
        val id = virtualId(videoPath) ?: return JSONObject().put("ok", false).put("files", JSONArray())
        val treeText = preferences.getString("tree:$id", null)
            ?: return JSONObject().put("ok", true).put("files", JSONArray())
        val parentId = preferences.getString("parent:$id", null)
            ?: return JSONObject().put("ok", true).put("files", JSONArray())
        val videoName = preferences.getString("name:$id", null) ?: displayNameFromVirtualPath(videoPath)
        val videoStem = videoName.substringBeforeLast('.', videoName).lowercase(Locale.ROOT)
        val treeUri = Uri.parse(treeText)
        val childrenUri = runCatching { DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId) }.getOrNull()
            ?: return JSONObject().put("ok", true).put("files", JSONArray())
        val found = mutableListOf<JSONObject>()
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        contentResolver.query(childrenUri, projection, null, null, null)?.use { cursor ->
            while (cursor.moveToNext()) {
                val name = cursor.stringColumn(DocumentsContract.Document.COLUMN_DISPLAY_NAME) ?: continue
                if (!isSubtitleName(name)) continue
                val documentId = cursor.stringColumn(DocumentsContract.Document.COLUMN_DOCUMENT_ID) ?: continue
                val subtitleUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId)
                val stem = name.substringBeforeLast('.', name).lowercase(Locale.ROOT)
                val path = registerDocument(subtitleUri, name, treeText, parentId)
                found.add(JSONObject()
                    .put("name", name)
                    .put("path", path)
                    .put("size", cursor.longColumn(DocumentsContract.Document.COLUMN_SIZE))
                    .put("exact", stem == videoStem)
                    .put("related", stem.startsWith(videoStem.take(8))))
            }
        }
        found.sortWith(compareByDescending<JSONObject> { it.optBoolean("exact") }
            .thenByDescending { it.optBoolean("related") }
            .thenBy { it.optString("name").lowercase(Locale.ROOT) })
        return JSONObject().put("ok", true).put("files", JSONArray(found.take(60)))
    }

    private fun fileInfo(path: String): JSONObject {
        val uri = resolveDocument(path) ?: return JSONObject().put("ok", false).put("error", "file-not-found")
        val name = queryDisplayName(uri) ?: displayNameFromVirtualPath(path)
        if (name.isBlank()) return JSONObject().put("ok", false).put("error", "empty-file-name")
        val size = querySize(uri)
        val modified = queryLastModified(uri)
        return JSONObject()
            .put("ok", true)
            .put("name", name)
            .put("dir", "")
            .put("ext", extension(name))
            .put("size", size)
            .put("mtime", modified)
            .put("isVideo", isVideoName(name))
            .put("isSubtitle", isSubtitleName(name))
    }

    private fun readBytes(path: String, maxBytes: Long): JSONObject {
        val uri = resolveDocument(path) ?: return JSONObject().put("ok", false).put("error", "file-not-found")
        val name = queryDisplayName(uri) ?: displayNameFromVirtualPath(path)
        val size = querySize(uri)
        if (size > maxBytes) return JSONObject().put("ok", false).put("error", "file-too-big").put("size", size)
        return runCatching {
            val stream = contentResolver.openInputStream(uri) ?: throw IllegalStateException("Storage provider did not open this file")
            val bytes = stream.use { readLimited(it, maxBytes) }
            JSONObject().put("ok", true)
                .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                .put("size", bytes.size)
                .put("name", name)
        }.getOrElse { error -> JSONObject().put("ok", false).put("error", error.message ?: "Could not read file") }
    }

    private fun readLimited(input: InputStream, maxBytes: Long): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > maxBytes) throw IllegalArgumentException("file-too-big")
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }

    private fun registerDocument(uri: Uri, name: String, treeUri: String?, parentDocumentId: String?): String {
        val id = UUID.randomUUID().toString()
        preferences.edit()
            .putString("uri:$id", uri.toString())
            .putString("name:$id", name)
            .apply {
                if (!treeUri.isNullOrBlank() && !parentDocumentId.isNullOrBlank()) {
                    putString("tree:$id", treeUri)
                    putString("parent:$id", parentDocumentId)
                }
            }
            .apply()
        return "pv-file://$id/${Uri.encode(name)}"
    }

    private fun resolveDocument(path: String): Uri? {
        val parsed = Uri.parse(path)
        if (parsed.scheme != "pv-file") return if (parsed.scheme == "content") parsed else null
        val id = parsed.host ?: return null
        val saved = preferences.getString("uri:$id", null) ?: return null
        return runCatching { Uri.parse(saved) }.getOrNull()
    }

    private fun virtualId(path: String): String? {
        val parsed = Uri.parse(path)
        return if (parsed.scheme == "pv-file") parsed.host else null
    }

    private fun displayNameFromVirtualPath(path: String): String {
        val raw = Uri.parse(path).lastPathSegment ?: path.substringAfterLast('/')
        return Uri.decode(raw)
    }

    private fun queryDisplayName(uri: Uri): String? = queryString(uri, OpenableColumns.DISPLAY_NAME)

    private fun querySize(uri: Uri): Long = queryLong(uri, OpenableColumns.SIZE)

    private fun queryLastModified(uri: Uri): Long = queryLong(uri, DocumentsContract.Document.COLUMN_LAST_MODIFIED)

    private fun queryString(uri: Uri, column: String): String? {
        return runCatching {
            contentResolver.query(uri, arrayOf(column), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.stringColumn(column) else null
            }
        }.getOrNull()
    }

    private fun queryLong(uri: Uri, column: String): Long {
        return runCatching {
            contentResolver.query(uri, arrayOf(column), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.longColumn(column) else -1L
            } ?: -1L
        }.getOrDefault(-1L)
    }

    private fun Cursor.stringColumn(name: String): String? {
        val index = getColumnIndex(name)
        return if (index >= 0 && !isNull(index)) getString(index) else null
    }

    private fun Cursor.longColumn(name: String): Long {
        val index = getColumnIndex(name)
        return if (index >= 0 && !isNull(index)) getLong(index) else -1L
    }

    private fun mediaResponse(request: WebResourceRequest): WebResourceResponse {
        val path = request.url.getQueryParameter("path")
        val uri = path?.let(::resolveDocument)
            ?: return webResponse(404, "Not Found", emptyMap(), ByteArray(0).inputStream())
        val afd = runCatching { contentResolver.openAssetFileDescriptor(uri, "r") }.getOrNull()
            ?: return webResponse(404, "Not Found", emptyMap(), ByteArray(0).inputStream())
        val size = afd.length.takeIf { it >= 0 } ?: afd.parcelFileDescriptor.statSize.takeIf { it >= 0 } ?: querySize(uri)
        val mime = (contentResolver.getType(uri)?.takeUnless { it == "application/octet-stream" }
            ?: mimeForName(queryDisplayName(uri) ?: displayNameFromVirtualPath(path)))
        val headers = linkedMapOf(
            "Accept-Ranges" to "bytes",
            "Cache-Control" to "no-cache",
            "Access-Control-Allow-Origin" to "*",
            "Content-Type" to mime,
        )
        val range = request.requestHeaders.entries.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
        if (range != null && size > 0) {
            val parsed = parseRange(range, size)
            if (parsed == null) {
                afd.close()
                headers["Content-Range"] = "bytes */$size"
                return webResponse(416, "Range Not Satisfiable", headers, ByteArray(0).inputStream())
            }
            val (start, end) = parsed
            val stream = afd.createInputStream()
            if (!skipFully(stream, start)) {
                stream.close()
                headers["Content-Range"] = "bytes */$size"
                return webResponse(416, "Range Not Satisfiable", headers, ByteArray(0).inputStream())
            }
            headers["Content-Range"] = "bytes $start-$end/$size"
            headers["Content-Length"] = (end - start + 1).toString()
            return webResponse(206, "Partial Content", headers, LimitedInputStream(stream, end - start + 1))
        }
        if (size >= 0) headers["Content-Length"] = size.toString()
        return webResponse(200, "OK", headers, afd.createInputStream())
    }

    private fun webResponse(status: Int, reason: String, headers: Map<String, String>, body: InputStream) =
        WebResourceResponse(headers["Content-Type"] ?: "application/octet-stream", null, status, reason, headers, body)

    private fun parseRange(value: String, size: Long): Pair<Long, Long>? {
        val match = Regex("bytes=(\\d*)-(\\d*)", RegexOption.IGNORE_CASE).find(value.trim()) ?: return null
        val startText = match.groupValues[1]
        val endText = match.groupValues[2]
        if (startText.isBlank() && endText.isBlank()) return null
        val start: Long
        val end: Long
        if (startText.isBlank()) {
            val suffix = endText.toLongOrNull()?.coerceAtLeast(0) ?: return null
            start = (size - suffix).coerceAtLeast(0)
            end = size - 1
        } else {
            start = startText.toLongOrNull() ?: return null
            end = if (endText.isBlank()) size - 1 else endText.toLongOrNull() ?: return null
        }
        if (size <= 0 || start < 0 || start >= size || end < start) return null
        return start to min(end, size - 1)
    }

    private fun skipFully(input: InputStream, amount: Long): Boolean {
        var remaining = amount
        while (remaining > 0) {
            val skipped = input.skip(remaining)
            if (skipped > 0) {
                remaining -= skipped
            } else if (input.read() >= 0) {
                remaining--
            } else {
                return false
            }
        }
        return true
    }

    private class LimitedInputStream(input: InputStream, private var remaining: Long) : FilterInputStream(input) {
        override fun read(): Int {
            if (remaining <= 0) return -1
            val value = super.read()
            if (value >= 0) remaining--
            return value
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (remaining <= 0) return -1
            val count = super.read(buffer, offset, min(length.toLong(), remaining).toInt())
            if (count > 0) remaining -= count
            return count
        }

        override fun skip(count: Long): Long {
            val skipped = super.skip(min(count, remaining))
            remaining -= skipped
            return skipped
        }
    }

    private fun handleNetworkRequest(request: JSONObject): JSONObject {
        val id = request.optString("id", UUID.randomUUID().toString())
        val urlText = request.optString("url")
        val uri = Uri.parse(urlText)
        if (uri.scheme !in setOf("https", "http") || uri.host.isNullOrBlank()) {
            return JSONObject().put("ok", false).put("status", 0).put("error", "Unsupported network URL")
        }
        if (uri.host.equals("script.google.com", true) || uri.host.equals("prime-vocab-mobile.vercel.app", true)) {
            return JSONObject().put("ok", false).put("status", 0).put("error", "Remote licence services are disabled in this Android build")
        }

        var connection: HttpURLConnection? = null
        try {
            val timeout = request.optInt("timeoutMs", 15000).coerceIn(1000, 120000)
            val active = (URL(urlText).openConnection() as HttpURLConnection).apply {
                connectTimeout = timeout
                readTimeout = timeout
                instanceFollowRedirects = true
                requestMethod = request.optString("method", "GET").uppercase(Locale.ROOT)
                doInput = true
            }
            connection = active
            activeConnections[id] = active
            val inputHeaders = request.optJSONObject("headers")
            if (inputHeaders != null) {
                val keys = inputHeaders.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    val value = inputHeaders.optString(key)
                    if (key.isNotBlank() && !key.equals("Host", true) && !key.equals("Content-Length", true)) {
                        active.setRequestProperty(key, value)
                    }
                }
            }
            val method = active.requestMethod
            val rawBody = request.opt("body")
            val body = if (rawBody == null || rawBody == JSONObject.NULL) "" else rawBody.toString()
            if (body.isNotEmpty() && method !in setOf("GET", "HEAD")) {
                active.doOutput = true
                active.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            }
            val status = active.responseCode
            val stream = if (status >= 400) active.errorStream else active.inputStream
            val bytes = stream?.use { readLimited(it, NETWORK_RESPONSE_LIMIT) } ?: ByteArray(0)
            val headers = JSONObject()
            active.headerFields.forEach { (key, values) ->
                if (key != null && values != null) headers.put(key.lowercase(Locale.ROOT), values.joinToString(", "))
            }
            return JSONObject()
                .put("ok", true)
                .put("status", status)
                .put("statusText", active.responseMessage ?: "")
                .put("headers", headers)
                .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        } catch (error: Exception) {
            return JSONObject().put("ok", false).put("status", 0)
                .put("error", if (error is InterruptedException) "aborted" else error.message ?: "Network request failed")
        } finally {
            activeConnections.remove(id)
            connection?.disconnect()
        }
    }

    private fun openExternal(rawUrl: String): Boolean {
        val uri = runCatching { Uri.parse(rawUrl) }.getOrNull() ?: return false
        if (uri.scheme !in setOf("https", "http", "mailto")) return false
        return runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        }.getOrDefault(false)
    }

    private fun setImmersiveMode(enabled: Boolean) {
        isImmersive = enabled
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                if (enabled) {
                    controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    controller.hide(WindowInsets.Type.systemBars())
                } else {
                    controller.show(WindowInsets.Type.systemBars())
                }
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (enabled) {
                (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
            } else {
                View.SYSTEM_UI_FLAG_VISIBLE
            }
        }
        if (::root.isInitialized) ViewCompat.requestApplyInsets(root)
    }

    private fun setKeepScreenAwake(enabled: Boolean) {
        keepScreenAwake = enabled
        onMain {
            if (enabled) window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun showCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (customView != null) {
            callback.onCustomViewHidden()
            return
        }
        customView = view
        customViewCallback = callback
        webView.visibility = View.GONE
        root.addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setImmersiveMode(true)
    }

    private fun hideCustomView() {
        val view = customView ?: return
        root.removeView(view)
        customView = null
        customViewCallback?.onCustomViewHidden()
        customViewCallback = null
        webView.visibility = View.VISIBLE
        setImmersiveMode(false)
    }

    private fun storeLoad(): JSONObject {
        return runCatching {
            val atomic = AtomicFile(dataFile)
            val raw = atomic.openRead().bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
            val source = JSONObject(raw)
            JSONObject().put("ok", true).put("data", JSONObject()
                .put("local", source.optJSONObject("local") ?: JSONObject())
                .put("sync", source.optJSONObject("sync") ?: JSONObject())
                .put("meta", source.optJSONObject("meta") ?: JSONObject()))
        }.getOrElse {
            JSONObject().put("ok", false).put("data", JSONObject().put("local", JSONObject()).put("sync", JSONObject()))
        }
    }

    private fun storeSave(data: JSONObject): JSONObject {
        val atomic = AtomicFile(dataFile)
        var output: java.io.FileOutputStream? = null
        return try {
            dataFile.parentFile?.mkdirs()
            val payload = JSONObject()
                .put("local", data.optJSONObject("local") ?: JSONObject())
                .put("sync", data.optJSONObject("sync") ?: JSONObject())
                .put("meta", (data.optJSONObject("meta") ?: JSONObject()).put("savedAt", System.currentTimeMillis()))
                .toString()
            val stream = atomic.startWrite()
            output = stream
            stream.write(payload.toByteArray(StandardCharsets.UTF_8))
            atomic.finishWrite(stream)
            JSONObject().put("ok", true)
        } catch (error: Exception) {
            if (output != null) atomic.failWrite(output)
            JSONObject().put("ok", false).put("error", error.message ?: "Could not save local data")
        }
    }

    private fun mimeForName(name: String): String {
        return when (extension(name)) {
            "mp4", "m4v" -> "video/mp4"
            "mov" -> "video/quicktime"
            "webm" -> "video/webm"
            "mkv" -> "video/x-matroska"
            "vtt" -> "text/vtt"
            "srt" -> "application/x-subrip"
            "ass", "ssa", "sub", "txt", "csv" -> "text/plain"
            "json" -> "application/json"
            "mp3" -> "audio/mpeg"
            "m4a" -> "audio/mp4"
            "ogg", "opus" -> "audio/ogg"
            "wav" -> "audio/wav"
            "pdf" -> "application/pdf"
            else -> "application/octet-stream"
        }
    }

    private fun extension(name: String): String = name.substringAfterLast('.', "").lowercase(Locale.ROOT)

    private fun isVideoName(name: String): Boolean = extension(name) in VIDEO_EXTENSIONS
    private fun isSubtitleName(name: String): Boolean = extension(name) in SUBTITLE_EXTENSIONS

    private fun dispatchEvent(name: String, payload: JSONObject) {
        if (!pageLoaded || !::webView.isInitialized) {
            pendingEvents.add(name to payload)
            return
        }
        val script = "window.__pvAndroidEvent&&window.__pvAndroidEvent(${JSONObject.quote(name)},${JSONObject.quote(payload.toString())});"
        webView.evaluateJavascript(script, null)
    }

    private fun complete(requestId: String?, result: JSONObject) {
        if (requestId.isNullOrBlank() || !::webView.isInitialized) return
        val script = "window.__pvAndroidResolve&&window.__pvAndroidResolve(${JSONObject.quote(requestId)},${JSONObject.quote(result.toString())});"
        onMain { webView.evaluateJavascript(script, null) }
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
    }

    private inner class LocalContentWebViewClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse? {
            if (request.url.host == ASSET_HOST && request.url.path == "/media") {
                return mediaResponse(request)
            }
            return assetLoader.shouldInterceptRequest(request.url)
        }

        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (uri.scheme == "about") return false
            if (uri.host == ASSET_HOST && (uri.path?.startsWith("/assets/") == true || uri.path == "/media")) return false
            if (uri.scheme == "https" || uri.scheme == "http" || uri.scheme == "mailto") {
                openExternal(uri.toString())
                return true
            }
            return true
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            if (url?.startsWith(APP_URL) == true) {
                pageLoaded = true
                val queued = pendingEvents.toList()
                pendingEvents.clear()
                queued.forEach { (name, payload) -> dispatchEvent(name, payload) }
            }
        }

        override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: android.net.http.SslError?) {
            handler?.cancel()
        }

        override fun onRenderProcessGone(view: WebView?, detail: android.webkit.RenderProcessGoneDetail?): Boolean {
            Log.e(TAG, "WebView renderer exited (crashed=${detail?.didCrash()})")
            Toast.makeText(this@MainActivity, "ProudVocab is restarting its player. Please reopen your video.", Toast.LENGTH_LONG).show()
            mainHandler.postDelayed({ if (!isFinishing) recreate() }, 250)
            return true
        }
    }

    private inner class LocalContentWebChromeClient : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?,
        ): Boolean {
            if (filePathCallback == null || fileChooserParams == null) return false
            return launchWebFileChooser(fileChooserParams, filePathCallback)
        }

        override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
            if (view != null && callback != null) showCustomView(view, callback)
            else super.onShowCustomView(view, callback)
        }

        override fun onHideCustomView() {
            hideCustomView()
        }

        override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
            val level = when (consoleMessage.messageLevel()) {
                ConsoleMessage.MessageLevel.ERROR -> Log.ERROR
                ConsoleMessage.MessageLevel.WARNING -> Log.WARN
                else -> Log.DEBUG
            }
            Log.println(level, "ProudVocabWeb", "${consoleMessage.message()} (${consoleMessage.sourceId()}:${consoleMessage.lineNumber()})")
            return true
        }
    }

    inner class AndroidJavascriptBridge {
        @android.webkit.JavascriptInterface
        fun dispatch(requestId: String, channel: String, rawArgs: String) {
            val args = runCatching { JSONArray(rawArgs) }.getOrElse { JSONArray() }
            when (channel) {
                "pv:open-dialog" -> launchDocumentPicker(requestId, args.optJSONObject(0)?.optString("kind", "video") ?: "video")
                "pv:open-directory" -> launchFolderPicker(requestId)
                "pv:save-file" -> {
                    val item = args.optJSONObject(0) ?: JSONObject()
                    val name = item.optString("name", "proudvocab-export.json")
                    val mime = item.optString("mime", mimeForName(name))
                    val bytes = runCatching { Base64.decode(item.optString("base64", ""), Base64.DEFAULT) }.getOrDefault(ByteArray(0))
                    launchSavePicker(requestId, name, mime, bytes)
                }
                else -> ioExecutor.execute {
                    val result = runCatching { handleRequest(channel, args) }
                        .getOrElse { error -> JSONObject().put("__pvBridgeError", error.message ?: "Native request failed") }
                    complete(requestId, result)
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun abort(requestId: String) {
            activeConnections.remove(requestId)?.disconnect()
        }

        @android.webkit.JavascriptInterface
        fun consumeInitialFiles(): String {
            synchronized(initialFiles) {
                val result = JSONArray(initialFiles).toString()
                initialFiles.clear()
                return result
            }
        }

        @android.webkit.JavascriptInterface
        fun setKeepScreenOn(enabled: Boolean) {
            setKeepScreenAwake(enabled)
        }
    }

    private fun handleRequest(channel: String, args: JSONArray): JSONObject {
        val first = args.opt(0)
        return when (channel) {
            "pv:app-info" -> JSONObject().apply {
                put("version", BuildConfig.VERSION_NAME)
                put("platform", "android")
                put("arch", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
                put("locale", Locale.getDefault().toLanguageTag())
                put("packaged", true)
            }
            "pv:store-load" -> storeLoad()
            "pv:store-save" -> storeSave(first as? JSONObject ?: JSONObject())
            "pv:store-path" -> JSONObject().put("path", dataFile.absolutePath)
            "pv:file-info" -> fileInfo(first?.toString().orEmpty())
            "pv:read-bytes" -> readBytes(first?.toString().orEmpty(), args.optLong(1, MAX_SUBTITLE_BYTES))
            "pv:scan-subtitles" -> scanSubtitles(first?.toString().orEmpty())
            "pv:list-videos" -> listVideos(first?.toString().orEmpty())
            "pv:net-fetch" -> handleNetworkRequest(first as? JSONObject ?: JSONObject())
            "pv:open-external" -> {
                val externalUrl = first?.toString().orEmpty()
                onMain { openExternal(externalUrl) }
                JSONObject().put("ok", true)
            }
            "pv:show-in-folder" -> JSONObject().put("ok", false)
            "pv:window-action" -> {
                val action = first?.toString().orEmpty()
                if (action == "fullscreen") onMain { setImmersiveMode(!isImmersive) }
                JSONObject().put("ok", action == "fullscreen")
            }
            "pv:is-fullscreen" -> JSONObject().put("fullscreen", isImmersive)
            "pv:set-progress" -> JSONObject().put("ok", true)
            "pv:media-url" -> JSONObject().put("url", "https://appassets.androidplatform.net/media?path=${urlEncode(first?.toString().orEmpty())}")
            else -> JSONObject().put("ok", false).put("error", "Unsupported Android bridge channel: $channel")
        }
    }

    private fun urlEncode(value: String): String = URLEncoder.encode(value, "UTF-8")

    private data class PickerOperation(
        val kind: PickerKind,
        val requestId: String?,
        val name: String? = null,
        val bytes: ByteArray? = null,
    )

    private enum class PickerKind { VIDEO, SUBTITLE, FOLDER, SAVE, WEB_FILE }

    companion object {
        private const val TAG = "ProudVocab"
        private const val ASSET_HOST = "appassets.androidplatform.net"
        private const val APP_URL = "https://appassets.androidplatform.net/assets/www/index.html"
        private const val MAX_SUBTITLE_BYTES = 64L * 1024 * 1024
        private const val NETWORK_RESPONSE_LIMIT = 16L * 1024 * 1024
        private val VIDEO_EXTENSIONS = setOf(
            "mp4", "m4v", "mov", "webm", "mkv", "ogv", "avi", "wmv", "flv",
            "mpg", "mpeg", "ts", "m2ts", "3gp", "vob",
        )
        private val SUBTITLE_EXTENSIONS = setOf("srt", "vtt", "ass", "ssa", "sub")
    }
}
