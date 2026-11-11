# 픽미업 공모전 제출 APK

- 파일: [이민규_픽미업_release.apk](이민규_픽미업_release.apk)
- 버전: 0.3.42 / versionCode 45
- 패키지: `io.pickmeup.automotive`
- 빌드: 기존 RSA 3072 서명 키를 사용한 **release** / APK Signature Scheme v2
- 크기: 8,405,856 bytes
- SHA-256: `80e05255f63a69d02e1751040e717b4f34f359daff6a5625d8ba718b4b182c6f`

[공식 제출 안내](https://appdevchallenge.auto-hmg.io/guide/submission)의 `apk/팀명_앱이름_release.apk` 규격을 따릅니다. 개인 참가자의 성명을 파일명의 팀명에 사용했습니다.

## 실행 환경과 설치

Pleos Connect 2.1 기반 Android Automotive 환경에서 시험했습니다. 최소 Android API 28, target API 34, compile API 36이며 Pleos NaviHelper 3.0.5를 사용합니다. 일반 휴대전화용 APK가 아닙니다. 차량 플랫폼의 내비게이션 권한과 지원되는 Gleo 환경이 필요합니다.

기존 debug·촬영용 앱과 release의 서명이 다릅니다. 기존 설치의 계정·차량 데이터를 유지하려면 별도의 Pleos 시험 기기/AVD에 설치하세요. 기존 앱을 삭제하거나 데이터를 초기화하는 절차는 포함하지 않습니다.

```sh
# 별도 시험 단말의 연결 ID와 현재 Android 사용자 ID를 확인합니다.
adb devices
adb -s <device-id> shell am get-current-user
adb -s <device-id> install --user <user-id> apk/이민규_픽미업_release.apk
```

설치 후 차량 앱 목록에서 픽미업을 엽니다. ‘바로 시작’으로 들어가 만날 곳과 연락할 상대를 고른 뒤 ‘길안내·도착 알림 시작’을 누릅니다. 새 장소 검색은 순정 내비에서 진행합니다. 연락처 사용 가능 여부는 차량·휴대전화 연결 환경에 따라 달라집니다. 문자 없이 시작한 경우 공유·메시지 복사로 링크와 인증코드를 직접 전달할 수 있습니다.

## 서버와 설정

이 APK의 API 주소는 `https://enforced-spookily-unweave.ngrok-free.dev/api`입니다. 기존 개발용 HTTPS 서버를 사용하는 빌드이며, 해당 서버와 웹·터널 프로세스가 실행 중이어야 연결됩니다. 영구 운영 배포나 서버 가용성을 보장하는 구성은 아닙니다.

현재 확인용 환경에서는 실제 문자 발송기를 실행하지 않습니다. Web Push 알림 역시 별도 서버·브라우저 권한과 환경 검증이 필요합니다. 문자 발송 요청 접수와 실제 전달 완료를 구분해야 하며, 링크 직접 전달로 수신자 웹 흐름을 확인할 수 있습니다.

Gleo 호출자 패키지·인증서 검증은 현재 시험한 플랫폼의 설정을 사용합니다. 다른 플랫폼 인증서나 음성 표현의 인식 안정성은 별도 확인이 필요합니다. 서버 비밀 키·DB·계정 토큰·서명 비밀번호·개인키는 APK나 저장소에 포함하지 않습니다. 카카오 JavaScript SDK의 공개 클라이언트 키와 공개 서버 주소는 앱 실행을 위해 포함됩니다.

## 이번 release 검증

- `testReleaseUnitTest`: 100건 통과, 실패·오류 0건
- `lintRelease`: 오류 0건, 기존 경고 34건
- APK v2 서명·zip alignment 검사 통과
- 별도 신규 Pleos AVD, Android 사용자 10에 설치 성공 및 MainActivity cold start 성공, 프로세스 실행·앱 crash 없음 확인
- `android:debuggable` 비활성, cleartext HTTP 비허용
- 촬영용 경로 자산·재생 클래스 및 debug 제어 Receiver 제외
- 기존 서명 파일·비밀 설정·원래 AVD 구성 보존 확인

기본 설치·실행 시험은 실차 주행이나 실제 문자 전달, 전체 픽업 흐름의 검증을 대신하지 않습니다. 개발 중인 서비스의 제출용 release입니다.

## 파일 무결성

저장소 루트에서 다음 명령으로 확인할 수 있습니다.

```sh
cd apk
shasum -a 256 -c SHA256SUMS
```
