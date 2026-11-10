# Pick Me Up · 픽미업

차량에서 만날 장소와 상대를 선택해 길안내와 도착 알림을 시작하고, 상대는 문자 링크로 도착 시간과 차량 위치를 확인하는 픽업 서비스입니다.

현재 차량 앱 버전은 **0.3.41**입니다. Android Automotive/Pleos 차량 앱, Fastify API, React 수신자 웹으로 구성됩니다.

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

```sh
cd android
./gradlew assembleDebug
```

Gleo 호출자 패키지·인증서와 지도 origin은 Gradle 속성으로 주입합니다. 배포용 서명과 API 주소는 `android/app/build.gradle.kts`의 release 검증 조건을 따릅니다.

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

## 관련 링크

- [랜딩 페이지](https://mingyulee2.github.io/pickmeup-landing/)
- [랜딩 페이지 소스](https://github.com/MinGyuLee2/pickmeup-landing)
