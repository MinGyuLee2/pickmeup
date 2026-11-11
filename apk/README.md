# 픽미업 공모전 제출 APK

- 파일: [이민규_픽미업_release.apk](이민규_픽미업_release.apk)
- 버전: 0.3.43 / versionCode 46
- 패키지: `io.pickmeup.automotive`
- 빌드: 기존 RSA 3072 서명 키를 사용한 **release** / APK Signature Scheme v2
- 크기: 8,407,964 bytes
- SHA-256: `5b6dd881b814b43992f9e5474ecae1b6988db5cecef267b07fbbea67f40094d9`

[공식 제출 안내](https://appdevchallenge.auto-hmg.io/guide/submission)의 `apk/팀명_앱이름_release.apk` 규격을 따릅니다. 개인 참가자의 성명을 파일명의 팀명에 사용했습니다.

## 실행 환경과 설치

Pleos Connect 2.1 기반 Android Automotive 환경에서 시험했습니다. 최소 Android API 28, target API 34, compile API 36이며 Pleos NaviHelper 3.0.5를 사용합니다. 일반 휴대전화용 APK가 아닙니다. 차량 플랫폼의 내비게이션 권한과 지원되는 Gleo 환경이 필요합니다.

기존 release 0.3.42에는 같은 서명의 데이터 보존 업데이트가 가능합니다. 기존 배포 주소의 차량 토큰으로 AWS에서 같은 차량임을 확인한 뒤 서버 연결 정보를 이전하고, 암호화된 이전 레코드도 보존합니다. 최근 픽업과 저장 설정은 유지합니다. debug·촬영용 설치에는 동일한 debug 서명의 업데이트를 사용하며, 제출 release는 별도 Pleos 시험 기기/AVD에서 확인할 수 있습니다. 기존 앱 삭제나 데이터 초기화는 필요하지 않습니다.

```sh
# 별도 시험 단말의 연결 ID와 현재 Android 사용자 ID를 확인합니다.
adb devices
adb -s <device-id> shell am get-current-user
adb -s <device-id> install -r --user <user-id> apk/이민규_픽미업_release.apk
```

설치 후 차량 앱 목록에서 픽미업을 엽니다. ‘바로 시작’으로 들어가 만날 곳과 연락할 상대를 고른 뒤 ‘길안내·도착 알림 시작’을 누릅니다. 새 장소 검색은 순정 내비에서 진행합니다. 연락처 사용 가능 여부는 차량·휴대전화 연결 환경에 따라 달라집니다. 문자 없이 시작한 경우 공유·메시지 복사로 링크와 인증코드를 직접 전달할 수 있습니다.

## 서버와 설정

이 APK는 AWS 서울의 `https://pickmeup.calkok.uk/api`에 직접 연결합니다. 수신자 웹도 같은 도메인에서 제공됩니다. 기존 계정·차량 데이터를 보존해 이전했고, 이전 공개 주소의 요청도 같은 AWS API로 전달합니다.

현재 실제 문자·Web Push 발송기는 실행하지 않습니다. SOLAPI 기존 키의 허용 IP에 서버 고정 IP `3.37.194.218`을 등록하고 대기 작업을 검토한 뒤 발송기를 활성화해야 합니다. 브라우저 알림은 별도 권한·환경 검증도 필요합니다. 문자 없이 시작한 뒤 공유·메시지 복사로 링크와 인증코드를 직접 전달할 수 있습니다. 발송 요청 접수와 실제 전달 완료는 구분합니다.

Gleo 호출자 패키지·인증서 검증은 현재 시험한 플랫폼의 설정을 사용합니다. 다른 플랫폼 인증서나 음성 표현의 인식 안정성은 별도 확인이 필요합니다. 서버 비밀 키·DB·계정 토큰·서명 비밀번호·개인키는 APK나 저장소에 포함하지 않습니다. 카카오 JavaScript SDK의 공개 클라이언트 키와 공개 서버 주소는 앱 실행을 위해 포함됩니다.

## 이번 release 검증

- `testReleaseUnitTest`: 104건 통과, 실패·오류 0건
- `lintRelease`: 오류 0건, 기존 경고 34건
- APK v2 서명·zip alignment 검사 통과
- 원래 Pleos AVD의 계정으로 AWS 인증 성공, 차량 토큰·최근 픽업·기존 저장 필드·UI 설정 보존 확인
- 별도 Android Keystore 저장소에 미완료 시작·종료·연결 정보를 넣어 이전 후 보존 확인
- 별도 Pleos AVD의 이전 signed release 0.3.42 위에 0.3.43을 업데이트 설치, 같은 차량·토큰·최근 픽업 유지 확인
- 실제 Android Keystore에서 이전 레코드 보존, 차량 ID 불일치 시 저장 거부, 승인하지 않은 서버 주소 거부 확인
- 실제 release UI의 시작 확인 → 문자 없이 시작 → 순정 내비 경로 선택·안내 시작 → AWS 픽업·SSE·카카오 지도 확인
- 실제 수신자 웹에서 4자리 인증·재접속 유지·대기 핀·나왔어요 응답, 차량 앱 반영과 공유 종료 후 위치 제거 확인
- 메시지 복사 토스트·단말 재실행·프로세스 실행 확인, 시험 단말의 앱 fatal crash 없음
- `android:debuggable` 비활성, cleartext HTTP 비허용
- 촬영용 경로 자산·재생 클래스·debug 제어 Receiver·검증용 instrumentation 제외
- 기존 서명 파일·비밀 설정·원래 AVD 구성 보존 확인

에뮬레이터·가상 상대를 사용한 검증입니다. 실제 휴대전화·실차 주행·실문자 전달·백그라운드 Web Push와 이번 release의 실제 음성 호출은 별도 확인이 남아 있습니다. 개발 중인 서비스의 제출용 release입니다.

## 파일 무결성

저장소 루트에서 다음 명령으로 확인할 수 있습니다.

```sh
cd apk
shasum -a 256 -c SHA256SUMS
```
