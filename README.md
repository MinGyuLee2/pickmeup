# Pick Me Up · 픽미업

차량에서 만날 장소와 상대를 선택해 길안내와 도착 알림을 시작하고, 상대는 문자 링크로 도착 시간과 차량 위치를 확인하는 픽업 서비스입니다.

현재 차량 앱 버전은 **0.3.43**입니다. Android Automotive/Pleos 차량 앱, Fastify API, React 수신자 웹으로 구성됩니다.

## 공모전 제출 APK

[이민규_픽미업_release.apk](apk/이민규_픽미업_release.apk) · 버전 0.3.43 / code 46 · 서명된 release

실행 방법, 테스트 환경, 서버 의존성과 검증 범위는 [APK 안내](apk/README.md)에 정리했습니다. 파일 무결성은 [SHA256SUMS](apk/SHA256SUMS)로 확인할 수 있습니다. 제출 APK에는 촬영용 가상 주행 재생기와 debug 제어 Receiver가 포함되지 않습니다.

## 심사자 실행 순서

1. Pleos Connect **2.1**, 전체 화면 **2560 × 1440** 환경에 위 release APK를 설치합니다. 차량·앱 분할 화면에서도 시험했습니다. 일반 Android 휴대전화용 앱은 아닙니다.
2. 차량 앱 목록에서 픽미업을 열고 **바로 시작**을 누릅니다. 휴대전화 인증이나 계정 연결은 필수가 아닙니다.
3. 순정 내비에서 만날 곳을 정하고 차량 연락처 또는 번호 직접 입력으로 상대를 선택합니다. 처음 입력할 때는 정차 상태가 필요합니다.
4. **길안내·도착 알림 시작**을 누릅니다. 확인창에서 문자 없이 시작해도 공유·메시지 복사로 링크와 인증코드를 전달할 수 있습니다. **바로 메시지 보내기**가 켜져 있으면 확인창 없이 실제 문자 발송을 요청합니다.
5. 상대는 웹에서 4자리 코드를 입력하고, 약관에 동의한 뒤 지도를 움직여 기다릴 핀을 확정합니다. 차량에 지도·로드뷰가 표시되며 **나왔어요** 응답을 확인할 수 있습니다. 만나면 공유를 종료합니다.

운영 웹/API는 `https://pickmeup.calkok.uk`입니다. 수신자 화면은 유효한 픽업 링크와 코드가 필요하므로 웹의 첫 화면만으로 픽업을 체험할 수는 없습니다. 카카오 지도·문자 공급자·차량 SDK 연결에는 인터넷이 필요합니다.

문자를 보내기로 한 픽업은 시작 안내 외에 **5분 이내 도착 임박 문자 1건**이 추가될 수 있습니다. 수동 재전송은 별도 1회 제한이며, 발송 접수와 전달 확인은 구분합니다. 실제 번호로 시험하면 문자 발송 비용이 발생합니다.

## 검증 환경과 범위

| 항목 | 확인한 범위 |
|---|---|
| 차량 앱 | Pleos Connect 2.1 에뮬레이터, 2560 × 1440, Android API 36, NaviHelper 3.0.5 |
| 음성 | Gleo가 합성 입력 음성을 인식해 실제 START/GET/STOP 액션을 호출하는 흐름. 플랫폼 호출자 서명 검증 사용 |
| 일반 release | 순정 내비 경로 선택·안내 시작, 서버 인증·수신 웹 왕복, 재실행·동일 서명 업데이트 보존 |
| 실제 iPhone | 개발 경로 재생 환경의 실제 문자 수신·코드 인증·핀·5분 전 소리·나왔어요·종료 화면 |
| 주행·지도 | 개발 재생 데이터로 앱/웹 좌표와 ETA 동기화 확인. 순정 내비·계기판은 이 재생기에 연동되지 않음 |

실차 주행, 양산 차량의 연락처 동기화 권한, 다양한 Gleo 자연어 표현의 성공률은 아직 검증하지 않았습니다. 수신자의 핀은 순정 내비 목적지를 자동 변경하지 않으며, 보조 지도와 촬영된 거리 사진인 로드뷰에 표시됩니다. 예상 경로는 서버의 경로 API가 계산하므로 순정 내비의 선택 경로와 다를 수 있습니다. iPhone 알림은 **웹을 열어둔 동안의 화면·소리 안내**이며, 화면 잠금·웹 종료 뒤 알림을 보장하지 않습니다.

## 주요 기능

- 최근 픽업 조합, 차량 연락처 선택·번호 입력, 내비게이션 목적지와 Gleo 음성 시작
- 문자 발송 전 확인, 바로 보내기 설정 유지, 링크 공유·메시지 복사·재전송
- 픽업별 인증코드, 링크별 인증 분리, 잠금 복구와 통신 재연결
- 수신자의 나왔어요 응답, 도착 알림, 한 번 동의 후 중앙 핀으로 기다릴 위치 지정
- 차량 지도·카카오 로드뷰 자동 분할, 정차 중 지도 조작과 처음 위치 복귀
- 픽업 종료·만료·링크 교체 시 위치와 수신 접근 정리

## 구성

| 경로 | 내용 |
|---|---|
| `android/` | Kotlin 차량 앱, Gleo·내비게이션 연동, 지도·로드뷰 |
| `api/` | Fastify API, PostgreSQL 마이그레이션, 문자·푸시 처리 |
| `web/` | React 수신자 웹, 카카오 지도, 위치 선택·도착 알림 |
| `scripts/` | 개발 환경·빌드·검증 스크립트 |
| `deploy/` | 컨테이너 배포 설정과 환경 예제 |

기획서·지원서·접수양식·제출 초안, 디자인 시안, 화면 캡처와 개인 작업 기록은 이 저장소의 현재 소스에 포함하지 않습니다. 실제 환경 설정·키·DB·서명 파일·빌드 결과도 제외합니다.

## 개발 환경

- Node.js 22.12 이상, 23 미만
- JDK 17, Android SDK 36
- PostgreSQL
- Android 앱: minSdk 28 / targetSdk 34 / compileSdk 36
- Pleos NaviHelper 3.0.5: Gradle에 지정된 공식 Maven 저장소에서 해석합니다.

`android/local.properties`에 본인의 Android SDK 경로를 설정합니다. 이 파일은 Git에서 제외됩니다. `scripts/with-env.sh`는 macOS Homebrew 환경을 기본값으로 사용하며 `PICKMEUP_JAVA_HOME`, `PICKMEUP_ANDROID_HOME`으로 경로를 바꿀 수 있습니다.

## 로컬 실행

```sh
npm ci
cp .env.example .env
cp web/.env.example web/.env.local
```

`.env`에 로컬 DB 연결과 한 번 생성한 안정적인 `APP_SECRET`을 설정하고, `web/.env.local`에 도메인 제한을 적용한 카카오 JavaScript 키를 설정합니다. 문자·서명·경로 계산용 REST 키는 서버 또는 로컬 비공개 설정에만 보관합니다.

```sh
npm run dev:api
npm run dev:web
```

API는 시작할 때 `api/migrations/`를 적용합니다. 기본 로컬 API 포트는 4310, 웹 포트는 5173입니다.

문자 발송 worker는 별도 프로세스입니다. `SMS_MODE=local`은 가상 인증·발송용이며, 실제 문자 공급자를 설정한 상태에서 worker를 시작하면 발송이 발생할 수 있습니다. 기존 계정·차량 연결을 유지하려면 DB, `APP_SECRET`, 차량 앱의 기기 데이터를 보존해야 합니다.

가상 주행 빌드는 원래 계정과 별도의 개발 데이터로 동작합니다. 개발 화면은 일반 화면과 같고, 문자도 실제 발송하려면 기존 서버의 인증된 문자 릴레이와 `.local/filming-demo/sms.env`의 `FILMING_SMS_MODE=solapi`, `FILMING_SMS_RELAY_URL`을 연결합니다. 릴레이 연결 전에는 실제 발송으로 표시하지 않습니다. 활성화 전에 남아 있던 대기 문자는 취소하며, 새 요청에도 기존 발송 확인·재전송 제한이 적용됩니다. 서버 구성은 [AWS 배포 안내](deploy/aws/README.md)를 참고하세요.

```sh
cd android
./gradlew assembleDebug
```

기본 debug도 AWS 배포 API를 사용합니다. 로컬 API 시험은 별도 AVD에서 `-PpickmeupDebugApiBaseUrl=http://127.0.0.1:4310 -PpickmeupMapOrigin=https://pickmeup.calkok.uk`로 빌드합니다. 기존 배포 주소의 연결 정보는 같은 차량 인증이 확인된 뒤 새 주소로 이전하며, 암호화된 이전 레코드도 보존합니다.

Gleo 호출자 패키지·인증서와 지도 origin은 Gradle 속성으로 주입합니다. 기본 debug의 빈 호출자 설정은 음성 호출을 허용하지 않습니다. 실제 기기 플랫폼의 승인된 패키지·서명 SHA-256을 확인해 `-PpickmeupGleoCallerPackage=... -PpickmeupGleoCallerSha256=...`로 설정합니다.

소스에서 release를 빌드할 때는 기존 서명 파일과 `PICKMEUP_KEYSTORE`, `PICKMEUP_STORE_PASSWORD`, `PICKMEUP_KEY_ALIAS`, `PICKMEUP_KEY_PASSWORD`, `PICKMEUP_GLEO_CALLER_PACKAGE`, `PICKMEUP_GLEO_CALLER_SHA256`을 비공개 환경 변수로 제공하고 `scripts/android-release.sh https://pickmeup.calkok.uk/api`를 실행합니다. 서명 키는 저장소에 포함하지 않으며 기존 설치의 키를 새로 만들거나 교체하지 않습니다. 배포용 서명과 API 주소 검증은 `android/app/build.gradle.kts`에 있습니다.

## 검증

```sh
npm run build
npm test --workspace api
bash scripts/web-map-alert-test.sh
bash scripts/web-roadview-test.sh
bash scripts/web-api-test.sh
bash scripts/web-pin-selection-test.sh
bash scripts/web-location-test.sh
cd android
./gradlew testDebugUnitTest lintDebug
```

API 테스트는 별도 PostgreSQL 스키마를 만들어 사용한 뒤 정리합니다. 자동 테스트·에뮬레이터·브라우저 검증과 실제 휴대전화·실차 주행 검증은 구분합니다. 실제 문자 전달, 차량 SDK 권한과 주행 환경은 별도 검증이 필요합니다.

## 촬영용 경로 재생

기존 에뮬레이터·Gleo 호출자 설정과 로컬 오디오 도구가 준비된 개발 환경에서 별도 `filming` 빌드를 사용할 수 있습니다. 이 빌드는 원래 계정 설정을 읽지 않고, 독립된 암호화 저장소와 DB 스키마에서 가상 상대·주행을 사용합니다. 일반 debug/release에는 재생기와 촬영 제어 Receiver가 포함되지 않습니다.

```sh
scripts/filming-demo.sh prepare
scripts/filming-demo.sh start
scripts/filming-demo.sh install
```

PC 촬영 콘솔은 `http://127.0.0.1:5187`입니다. 기존에 설정한 HTTPS 도메인의 `/filming/`에서 수신자 화면을 제공하며, 일반 웹과 API 경로는 유지합니다. 기본값은 가상 발송이며, 앞서 설명한 릴레이를 명시적으로 설정하면 실제 문자를 보냅니다. 음성 응답만 녹음할 때는 `FILMING_AUDIO_ONLY=1`로 발송을 차단할 수 있습니다. 녹음한 명령은 실제 Gleo ASR·서명 보호 액션을 거치며, Intent 직접 호출을 음성 성공으로 대체하지 않습니다.

```sh
node scripts/filming-smoke.mjs
scripts/filming-demo.sh stop
scripts/filming-demo.sh restore
```

`restore`는 일반 APK를 데이터 보존 업데이트하고 원래 계정·차량 저장소로 돌아갑니다. 휴대전화 재인증이나 설정 백업 덮어쓰기는 하지 않습니다.

## 관련 링크

AWS 서울용 설정과 기존 DB·키 보존 절차는 [배포 안내](deploy/aws/README.md)에 있습니다. 문자·푸시 worker는 기본으로 시작하지 않습니다.

- [랜딩 페이지](https://mingyulee2.github.io/pickmeup-landing/)
- [랜딩 페이지 소스](https://github.com/MinGyuLee2/pickmeup-landing)
