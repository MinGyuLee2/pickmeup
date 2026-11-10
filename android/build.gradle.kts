plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.2.10" apply false
}

// Keep compiler caches and classpath jars outside the File Provider-backed Documents folder.
// On this Mac, incremental mmap reads blocked there and the test compiler missed classes.
val normalizedPath = java.text.Normalizer.normalize(rootDir.absolutePath, java.text.Normalizer.Form.NFC)
val cacheKey = normalizedPath.hashCode().toUInt().toString(16)
val outputRoot = providers.gradleProperty("pickmeupBuildRoot")
    .getOrElse("${System.getProperty("user.home")}/.cache/pickmeup/android-$cacheKey")
layout.buildDirectory.set(file("$outputRoot/root"))
subprojects { layout.buildDirectory.set(file("$outputRoot/$name")) }
