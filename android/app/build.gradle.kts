import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
val gleoPackage=providers.gradleProperty("pickmeupGleoCallerPackage").getOrElse("")
val gleoFingerprint=providers.gradleProperty("pickmeupGleoCallerSha256").getOrElse("")
val releaseEndpoint=providers.gradleProperty("pickmeupApiBaseUrl").getOrElse("")
// The browser and vehicle map use the same existing JavaScript key. Never duplicate it in source.
val mapKeyFile=rootProject.file("../web/.env.local")
val mapKey=providers.environmentVariable("VITE_KAKAO_MAP_KEY").orNull
    ?: mapKeyFile.takeIf {it.isFile}?.readLines()?.firstOrNull {it.startsWith("VITE_KAKAO_MAP_KEY=")}
        ?.substringAfter('=')?.trim()?.trim('"','\'').orEmpty()
require(mapKey.isEmpty() || Regex("[a-zA-Z0-9]+").matches(mapKey)) { "Invalid Kakao JavaScript key" }
fun mapOrigin(value: String): String {
    val uri=URI(value)
    require(uri.scheme=="https" && !uri.host.isNullOrEmpty() && uri.userInfo==null && uri.query==null && uri.fragment==null && uri.path in listOf("","/")) { "Map origin must be an HTTPS origin" }
    return value.trimEnd('/')+"/"
}
val releaseSigning=listOf("PICKMEUP_KEYSTORE", "PICKMEUP_STORE_PASSWORD", "PICKMEUP_KEY_ALIAS", "PICKMEUP_KEY_PASSWORD")
    .associateWith { providers.environmentVariable(it).getOrElse("") }
require(gleoPackage.isEmpty() || Regex("[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)+").matches(gleoPackage)) { "Invalid Gleo caller package" }
require(gleoFingerprint.isEmpty() || Regex("[a-fA-F0-9]{64}").matches(gleoFingerprint)) { "Gleo fingerprint must be 64 hex characters" }
android {
    namespace = "io.pickmeup.automotive"
    compileSdk = 36
    useLibrary("android.car", false)
    buildFeatures { buildConfig = true }
    signingConfigs {
        if(releaseSigning.values.all { it.isNotBlank() }) create("pickmeupRelease") {
            storeFile=file(releaseSigning.getValue("PICKMEUP_KEYSTORE"))
            storePassword=releaseSigning.getValue("PICKMEUP_STORE_PASSWORD")
            keyAlias=releaseSigning.getValue("PICKMEUP_KEY_ALIAS")
            keyPassword=releaseSigning.getValue("PICKMEUP_KEY_PASSWORD")
        }
    }
    defaultConfig {
        applicationId = "io.pickmeup.automotive"
        minSdk = 28
        targetSdk = 34
        versionCode = 46
        versionName = "0.3.43"
        testInstrumentationRunner = "io.pickmeup.automotive.verification.ServerMigrationInstrumentation"
        buildConfigField("boolean","FILMING_MODE","false")
        buildConfigField("String","KAKAO_MAP_JS_KEY","\"$mapKey\"")
        buildConfigField("String","GLEO_CALLER_PACKAGE","\"$gleoPackage\"")
        buildConfigField("String","GLEO_CALLER_SHA256","\"$gleoFingerprint\"")
        manifestPlaceholders["gleoCallerPackage"]=gleoPackage.ifEmpty { "io.pickmeup.automotive" }
    }
    buildTypes {
        getByName("debug") {
            val endpoint=providers.gradleProperty("pickmeupDebugApiBaseUrl").getOrElse("https://pickmeup.calkok.uk/api")
            val defaultOrigin=if(endpoint.startsWith("https://"))URI(endpoint).let {"${it.scheme}://${it.rawAuthority}"} else "https://localhost:5173"
            buildConfigField("String","KAKAO_MAP_ORIGIN","\"${mapOrigin(providers.gradleProperty("pickmeupMapOrigin").getOrElse(defaultOrigin))}\"")
            require((endpoint.startsWith("https://") || endpoint=="http://127.0.0.1:4310") && !endpoint.contains('"'))
            buildConfigField("String","API_BASE_URL","\"$endpoint\"")
        }
        getByName("release") {
            val origin=providers.gradleProperty("pickmeupMapOrigin").getOrElse(
                releaseEndpoint.takeIf {it.isNotBlank()}?.let {val u=URI(it);"${u.scheme}://${u.rawAuthority}"} ?: "https://localhost:5173")
            buildConfigField("String","KAKAO_MAP_ORIGIN","\"${mapOrigin(origin)}\"")
            val endpoint = releaseEndpoint
            require(endpoint.isEmpty() || (endpoint.startsWith("https://") && !endpoint.contains('"'))) { "Release API URL must use HTTPS" }
            buildConfigField("String", "API_BASE_URL", "\"$endpoint\"")
            signingConfig=signingConfigs.findByName("pickmeupRelease")
        }
        create("filming") {
            initWith(getByName("debug"))
            matchingFallbacks += listOf("debug")
            versionNameSuffix = "-filming"
            buildConfigField("boolean","FILMING_MODE","true")
            buildConfigField("String","API_BASE_URL","\"http://127.0.0.1:4311\"")
        }
    }
    sourceSets.getByName("filming") {
        java.srcDir("src/debug/java")
        res.srcDir("src/debug/res")
    }
    testBuildType = providers.gradleProperty("pickmeupTestBuildType").getOrElse("debug")
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

val verifyReleaseConfiguration by tasks.registering {
    doLast {
        require(mapKey.isNotBlank()) { "Release requires the existing VITE_KAKAO_MAP_KEY" }
        val url=runCatching { URI(releaseEndpoint) }.getOrNull()
        val host=url?.host.orEmpty().lowercase()
        require(url?.scheme=="https" && host.isNotEmpty() && url.userInfo==null && url.query==null && url.fragment==null && url.path=="/api" &&
            host !in listOf("localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "example.com") &&
            !host.endsWith(".localhost") && !host.endsWith(".test") && !host.endsWith(".invalid") && !host.endsWith(".example.com")) {
            "Release requires the deployed public HTTPS API URL ending in /api (-PpickmeupApiBaseUrl=...)"
        }
        require(releaseSigning.values.all { it.isNotBlank() } && file(releaseSigning.getValue("PICKMEUP_KEYSTORE")).isFile) {
            "Release requires PICKMEUP_KEYSTORE, PICKMEUP_STORE_PASSWORD, PICKMEUP_KEY_ALIAS and PICKMEUP_KEY_PASSWORD"
        }
        require(gleoPackage.isNotEmpty() && gleoFingerprint.isNotEmpty()) { "Release requires the approved Gleo caller package and SHA-256 fingerprint" }
    }
}
tasks.matching { it.name=="preReleaseBuild" }.configureEach { dependsOn(verifyReleaseConfiguration) }
kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}
dependencies {
    implementation("ai.pleos.playground:NaviHelper:3.0.5")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
}

val stageDebugApk by tasks.registering(Copy::class) {
    dependsOn("packageDebug")
    from(layout.buildDirectory.dir("outputs/apk/debug"))
    into(project.file("build/outputs/apk/debug"))
}
tasks.matching { it.name == "assembleDebug" }.configureEach { finalizedBy(stageDebugApk) }

val stageFilmingApk by tasks.registering(Copy::class) {
    dependsOn("packageFilming")
    from(layout.buildDirectory.dir("outputs/apk/filming"))
    into(project.file("build/outputs/apk/filming"))
}
tasks.matching { it.name == "assembleFilming" }.configureEach { finalizedBy(stageFilmingApk) }

val stageReleaseApk by tasks.registering(Copy::class) {
    dependsOn("assembleRelease")
    from(layout.buildDirectory.dir("outputs/apk/release"))
    into(project.file("build/outputs/apk/release"))
}
