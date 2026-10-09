plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseStoreFile = providers.gradleProperty("PV_RELEASE_STORE_FILE").orNull
    ?: System.getenv("PV_RELEASE_STORE_FILE")
val releaseStorePassword = providers.gradleProperty("PV_RELEASE_STORE_PASSWORD").orNull
    ?: System.getenv("PV_RELEASE_STORE_PASSWORD")
val releaseKeyAlias = providers.gradleProperty("PV_RELEASE_KEY_ALIAS").orNull
    ?: System.getenv("PV_RELEASE_KEY_ALIAS")
val releaseKeyPassword = providers.gradleProperty("PV_RELEASE_KEY_PASSWORD").orNull
    ?: System.getenv("PV_RELEASE_KEY_PASSWORD")
val hasReleaseSigning = !releaseStoreFile.isNullOrBlank()
    && !releaseStorePassword.isNullOrBlank()
    && !releaseKeyAlias.isNullOrBlank()
    && !releaseKeyPassword.isNullOrBlank()

android {
    namespace = "app.proudvocab.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.proudvocab.android"
        minSdk = 28 // Android 9 (Pie) and newer
        targetSdk = 35
        versionCode = providers.gradleProperty("versionCode").orElse("1").get().toInt()
        versionName = providers.gradleProperty("versionName").orElse("0.1.0").get()
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(requireNotNull(releaseStoreFile))
                storePassword = requireNotNull(releaseStorePassword)
                keyAlias = requireNotNull(releaseKeyAlias)
                keyPassword = requireNotNull(releaseKeyPassword)
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            // A repository owner should configure a stable private release key
            // in GitHub Actions. Without one, the CI build remains installable
            // for sideload testing but is signed with the ephemeral debug key.
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
        warningsAsErrors = false
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.0")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.documentfile:documentfile:1.0.1")

    testImplementation("junit:junit:4.13.2")
}
