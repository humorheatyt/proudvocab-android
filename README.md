# ProudVocab Android

نسخهٔ اندروید ProudVocab برای یادگیری واژه از ویدیوی محلی و زیرنویس. رابط و موتور واژگان از نسخهٔ دسکتاپ پروژه گرفته شده و برای اجرا در Android WebView با انتخابگر فایل بومی، ذخیره‌سازی محلی و چیدمان موبایل سازگار شده است.

## امکانات

- پخش ویدیوی محلی و زیرنویس‌های SRT، VTT، ASS/SSA و SUB؛ امکان انتخاب چند ویدیو و ساخت فهرست پخش از یک پوشه.
- لمس واژه‌های زیرنویس برای ترجمه، سطح CEFR، ذخیره در آرشیو و مرور فاصله‌دار؛ بازی‌ها، تنظیمات، خروجی CSV/Anki/JSON و بازیابی پشتیبان.
- تمام ابزارهای یادگیری محلی در این نسخه فعال‌اند؛ بررسی و سرور لایسنس/پریمیوم در بیلد اندروید وجود ندارد.
- واژه‌ها، تنظیمات و پیشرفت فقط در فضای خصوصی برنامه ذخیره می‌شود. همگام‌سازی Google Drive در این پورت اندرویدی پیاده‌سازی نشده؛ برای جابه‌جایی داده از Export/Restore استفاده کنید.
- برای ترجمه و بعضی اطلاعات واژگان اینترنت لازم است؛ فایل ویدیویی/زیرنویس به سرور آپلود نمی‌شود.

## نصب و سازگاری

- حداقل سیستم‌عامل: Android 9 (API 28). هدف ساخت: Android 15 (API 35).
- برای انتخاب فایل از Android Storage Access Framework (انتخابگر فایل سیستمی) استفاده می‌شود؛ برنامه مجوز عمومی حافظه، عکس یا ویدیو نمی‌خواهد. فقط فایل/پوشه‌ای که خودتان انتخاب می‌کنید به برنامه دسترسی می‌دهد.
- Poco X3 Pro با Android 11/12 و ABIهای ARM64 سازگار است. چون امکان آزمایش فیزیکی این مدل در محیط ساخت وجود ندارد، بخش مخصوص Poco در [چک‌لیست QA](QA_CHECKLIST.md) باید پیش از انتشار نهایی روی دستگاه واقعی تیک بخورد.
- سازگاری کدک به WebView و Android بستگی دارد. برای کمترین دردسر، ویدیوی MP4 با H.264 و صدای AAC پیشنهاد می‌شود؛ MKV/HEVC ممکن است بسته به فایل و نسخهٔ WebView پخش نشود.

## ساخت محلی

پیش‌نیاز: JDK 17، Android SDK Platform 35 و Build Tools 35.0.0.

```bash
npm test
./gradlew testDebugUnitTest lint assembleDebug assembleRelease
```

APK آزمایشی: `app/build/outputs/apk/debug/app-debug.apk`

APK بیلد Release: `app/build/outputs/apk/release/app-release.apk`

در این sandbox ابزارهای JDK/Android SDK نصب نیستند؛ اجرای Gradle، lint و بررسی APK در workflow گیت‌هاب انجام می‌شود. آزمون‌های JavaScript و پارسر زیرنویس در محیط توسعه قابل اجرا هستند.

## GitHub Actions و انتشار

- `Android CI` با push/PR، آزمون‌های جاوااسکریپت، بررسی syntax، Gradle unit tests، lint و ساخت APKهای debug/release را اجرا می‌کند و APKها را به‌صورت artifact می‌گذارد.
- `Android APK Release` با tagهای `v*` یا `workflow_dispatch` اجرا می‌شود و APK و checksum را به GitHub Release پیوست می‌کند.
- اگر keystore تنظیم نشده باشد، APK انتشار برای sideload قابل نصب است اما با debug key امضا می‌شود و ممکن است نصب نسخهٔ بعدی به حذف نسخهٔ قبلی نیاز داشته باشد. برای به‌روزرسانی بدون حذف، این repository secrets را تنظیم کنید: `ANDROID_KEYSTORE_BASE64`، `ANDROID_KEYSTORE_PASSWORD`، `ANDROID_KEY_ALIAS` و `ANDROID_KEY_PASSWORD`.
- این Release برای sideload است و امضای Play Store ندارد. فایل keystore و رمز آن را هرگز به مخزن اضافه نکنید.

## مجوزهای برنامه

در Manifest فقط مجوز `INTERNET` درخواست شده است. انتخاب فایل و پوشه با SAF انجام می‌شود و به `READ_EXTERNAL_STORAGE`، `READ_MEDIA_VIDEO`، دوربین، میکروفون، موقعیت مکانی یا مخاطبین احتیاج نیست. دسترسی اینترنت برای ترجمه/واژه‌نامه است.

## منشأ کد

رابط دسکتاپ و موتور واژگان از `melonityhub/proudvocab` در revision `8dbec172d2305cd45a97ff0f59abdc34fa1342d7` گرفته شده‌اند. پل Android، Activity، انتخابگر SAF، ذخیره‌سازی بومی، چیدمان موبایل و workflowهای ساخت در این مخزن اضافه شده‌اند. جزئیات در [UPSTREAM.md](UPSTREAM.md) آمده است.
