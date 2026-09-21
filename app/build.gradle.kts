plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.example.calliq"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.example.calliq"
        minSdk = 24
        targetSdk = 35
        versionCode = 8
        versionName = "1.7"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        /*
         * The "this is the latest build" card shown when the app opens. Type anything into
         * caller-IQ-project/BUILD_NOTE.txt before building — it is read on EVERY build, so the
         * card always shows what was in the file when this APK was made. Leave the file empty to
         * switch the card off. (Read through Gradle's own file API so the configuration cache
         * notices when it changes.)
         */
        val buildNote = providers.fileContents(rootProject.layout.projectDirectory.file("BUILD_NOTE.txt"))
            .asText.orNull.orEmpty().trim().take(300)
        val javaLiteral = buildNote.replace("\\", "\\\\").replace("\"", "\\\"").replace("\r", "").replace("\n", "\\n")
        buildConfigField("String", "BUILD_NOTE", "\"$javaLiteral\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }

    packaging {
        jniLibs {
            useLegacyPackaging = false
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")

    // WorkManager for reliable background call log syncing
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Kotlin Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // React Native Native Dependencies & JS Engines
    implementation("com.facebook.react:react-android:0.73.6")
    implementation("com.facebook.react:hermes-android:0.73.6")
    implementation("com.facebook.soloader:soloader:0.10.5")
}