plugins {
    id("com.android.application")
}

base {
    archivesName.set("JOKER")
}

android {
    namespace = "app.joker.browser"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.joker.browser"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    // Если заданы JOKER_KEYSTORE, JOKER_KEYSTORE_PASSWORD, JOKER_KEY_ALIAS и JOKER_KEY_PASSWORD, APK подписывается вашим ключом:
    // тогда новые версии ставятся поверх старой. Иначе подписывается отладочным ключом: такой APK тоже сразу
    // ставится на телефон, но обновить его можно только APK, собранным на этом же компьютере.
    val releaseKeystore: String? = System.getenv("JOKER_KEYSTORE")
    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("JOKER_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("JOKER_KEY_ALIAS")
                keyPassword = System.getenv("JOKER_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName(if (releaseKeystore != null) "release" else "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.18.0")
}

// Общая логика подмены лежит в ../extension/core.js (один источник для расширения, ПК-браузера и Android).
// На каждой сборке копируем её в assets как js/core.js.
abstract class SyncCoreTask : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val coreJs: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun run() {
        val dir = outputDir.get().asFile.resolve("js")
        dir.mkdirs()
        coreJs.get().asFile.copyTo(dir.resolve("core.js"), overwrite = true)
    }
}

val syncCore = tasks.register<SyncCoreTask>("syncCore") {
    coreJs.set(rootProject.layout.projectDirectory.file("../extension/core.js"))
    outputDir.set(layout.buildDirectory.dir("generated/joker/assets"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(syncCore, SyncCoreTask::outputDir)
    }
}
