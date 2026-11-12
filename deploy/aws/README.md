# AWS 서울 배포

Ubuntu 24.04 Lightsail 한 대에서 Caddy(HTTPS), API, PostgreSQL 17을 운영한다. 서버 요금제와 크레딧 적용 여부는 생성 전에 해당 AWS 계정에서 확인한다. 기존 `deploy/compose.yaml`의 SENS 구성은 별도로 유지한다.

## 개발 주행의 실제 문자 연결

기존 허용 IP와 SOLAPI 키를 유지하려면 `filming` 프로필의 문자 릴레이를 같은 서버에서 실행한다. `FILMING_PUBLIC_ORIGIN`은 현재 개발 웹의 HTTPS origin으로 지정한다. 기존 `APP_SECRET`에서 용도별 서명을 만들며, 키를 APK·웹이나 이미지에 포함하지 않는다. Caddy의 `/internal/filming-sms`는 서명·시간 검증을 통과한 요청만 처리하고, 문자 링크도 해당 origin의 `/filming/s`·`/filming/setup`으로 제한한다.

릴레이는 `pickmeup_filming_delivery_v1` 스키마에 작업 ID·본문 지문·수신번호/링크의 용도별 HMAC 지문·공급자 결과만 남긴다. 운영 계정·차량·픽업 테이블은 사용하지 않는다. 작업 ID 중복 전송을 막으며, 전송 여부가 불확실한 요청은 자동 재전송하지 않는다. 명확한 일시 거절만 최대 3회 재시도하며 ETA 문구가 바뀌어도 수신번호와 링크는 바꿀 수 없다. 이전 버전의 원장 행은 같은 본문만 재시도할 수 있다. 개발 문자에는 시간당 20회 상한을 둔다. 호스트에 4312 포트를 공개하지 않는다.

기존 비밀 마운트를 보존한 채 `filming-sms` 이미지만 빌드·시작하고, 새 Caddy 경로를 적용한 웹 이미지를 사용한다. 운영 API·worker를 재생성할 필요는 없다.

```sh
docker compose --env-file deploy.env -f deploy/aws/compose.yaml --profile filming build filming-sms web
docker compose --env-file deploy.env -f deploy/aws/compose.yaml --profile filming up -d --no-deps filming-sms web
```

Mac의 비공개 `.local/filming-demo/sms.env`에는 `FILMING_SMS_MODE=solapi`와 `FILMING_SMS_RELAY_URL=https://기존서버/internal/filming-sms`만 설정한다. 계정 비밀은 기존 `.env`를 사용한다. `/health`에 `externalSms:true`가 확인되기 전에는 연결 완료로 보지 않는다. `scripts/filming-smoke.mjs`는 문자 확인을 요청하지 않아 실제 발송 없이 점검할 수 있다.

개발 문자도 기존 서비스 주소로 직접 열려면 서버의 `FILMING_PUBLIC_ORIGIN`과 Mac의 `FILMING_PUBLIC_ORIGIN`을 같은 기존 서비스 HTTPS origin으로 지정하고, 서버의 `FILMING_WEB_UPSTREAM`은 기존 개발 터널 HTTPS origin으로 지정한다. `/filming/*`는 TLS를 유지한 채 기존 터널로 전달하며, [ngrok 공식 안내](https://ngrok.com/docs/pricing-limits/free-plan-limits#removing-the-interstitial-page)의 요청 헤더로 중간 안내를 표시하지 않는다. 새 문자에는 서비스 도메인이 들어가며, 이미 발송된 터널 주소 문자의 내용은 바뀌지 않는다.

Mac은 이 서비스 origin에서 온 개발 API 요청의 Origin만 기존 내부 origin으로 정규화한다. 예전 터널 origin은 유지하고, 다른 origin은 그대로 API에 전달해 거부한다. 수신 토큰·인증코드·쿠키를 URL 리다이렉트로 전달하지 않으며, 운영 `/api` 경로에는 이 처리를 적용하지 않는다.

## 기존 설정과 데이터 준비

프로젝트 루트에서 기존 Node 환경으로 실행한다. 서비스 키나 계정을 새로 만들지 않는다.

```sh
./scripts/with-env.sh node scripts/prepare-aws.mjs
```

이 명령은 기존 실행 환경과 같은 순서로 설정을 읽고 `.local/aws-deploy/`에 다음을 만든다. 이 폴더를 Git에 올리지 않는다.

- `secrets/`: 기존 APP_SECRET, DB 비밀번호, SOLAPI·카카오·Web Push 설정. 상위 폴더는 0700, 컨테이너에 개별 마운트되는 파일은 0444이다.
- `deploy.env`: 공개 서비스 주소, 기존 카카오 JavaScript 키, 서버 비밀 폴더 경로. 0600으로 보관한다.
- `database-*.dump`: 원본 PostgreSQL의 public 스키마 논리 백업. 촬영·시험 스키마는 포함하지 않는다.
- `snapshot.json`: 동일한 DB 스냅샷에서 계산한 17개 테이블의 행 수와 전체 행 지문. 정렬은 `COLLATE "C"`, 시간대는 UTC로 고정한다.

이미 내보낸 자격 증명과 값이 다르면 덮어쓰지 않고 중단한다. 백업은 실행 중인 DB에서 읽기만 한다. 실제 전환 직전에는 기존 쓰기 작업을 멈추고 최종 백업을 다시 만들어야 한다.

## 새 서버 준비와 실행

`bootstrap.sh`는 **새 Ubuntu 서버 전용**이다. Docker 공식 저장소에서 Engine·Compose를 설치하고, 개인 설정·백업 폴더와 2GB 스왑을 준비한다. 기존 서버에 무조건 실행하지 않는다. Lightsail이 실행 스크립트 앞에 코드를 붙여도 동작하도록 POSIX sh를 사용한다.

고정 IP를 서버에 연결하고, SSH는 관리자의 현재 IP로 제한한다. 외부에는 TCP 80·443만 허용한다. DB와 API 포트는 호스트에 공개하지 않는다. Cloudflare에는 서비스용 서브도메인 A 레코드만 추가한다. 기존 루트 도메인·메일·SSL 설정은 보존한다. DNS only를 사용하며 Caddy가 유효한 공개 인증서를 발급·갱신한다.

소스는 `/srv/pickmeup`, 비밀 파일은 `/srv/pickmeup-secrets`, 백업은 `/srv/pickmeup-backups`로 보낸다. `.env`, `.local`, 서명 키, Android 데이터는 소스 묶음에 포함하지 않는다.

```sh
cd /srv/pickmeup
sudo env COMPOSE_PARALLEL_LIMIT=1 docker compose --env-file deploy.env -f deploy/aws/compose.yaml build api
sudo env COMPOSE_PARALLEL_LIMIT=1 docker compose --env-file deploy.env -f deploy/aws/compose.yaml build web
sudo docker compose --env-file deploy.env -f deploy/aws/compose.yaml up -d --wait db
```

백업 SHA-256을 확인하고 **비어 있는 새 DB에만** `pg_restore --no-owner --no-acl --single-transaction --exit-on-error`로 복원한다. 새 DB에도 기본 public 스키마가 있으므로 archive 목록에서 `SCHEMA - public`과 그 스키마 COMMENT 항목만 제외한다. 원본 스키마를 삭제하거나 기존 테이블을 덮어쓰지 않는다. 원본과 복원본의 모든 행 수·전체 행 지문이 일치한 다음 실행한다.

```sh
sudo docker compose --env-file deploy.env -f deploy/aws/compose.yaml up -d --wait api web
sudo docker compose --env-file deploy.env -f deploy/aws/compose.yaml ps
```

기본 시작 대상은 DB·API·웹뿐이다. 문자 worker는 `messaging`, 푸시 worker는 `push` 프로필로 분리돼 있다. 기존 대기 메시지, 실제 수신자, 공급자 IP 제한을 검토하기 전에는 이 프로필을 활성화하지 않는다. worker가 꺼져 있으면 새 인증·안내 문자와 Web Push는 발송되지 않는다.

## 기존 클라이언트 전환과 확인

현재 일반 debug/release 0.3.43은 AWS HTTPS API를 사용한다. 이전 공개 주소 또는 일반 debug의 loopback 주소에 묶인 레코드는 명시된 단방향 전환만 허용한다. 기존 토큰으로 새 API의 차량 ID를 확인한 뒤 암호화 레코드의 서버 바인딩을 이전하며, 이전 암호문도 별도로 보존한다. 서명이 다른 APK를 설치하기 위해 기존 앱을 삭제하지 않는다.

기존 일반 API 쓰기를 중단한 상태에서 17개 테이블의 전체 행 지문 일치를 확인했고, AWS를 유일한 운영 DB로 전환했다. `scripts/legacy-api-bridge.mjs`는 기존 클라이언트의 loopback 요청을 고정된 AWS HTTPS API로 전달한다. 자체 DB 연결·문자 발송 기능은 없다. 이전 웹 Origin을 검증한 뒤 새 Origin으로 변환하며, 허용하지 않은 Origin은 거부한다. 기존 터널을 사용할 동안 이 listener를 유지한다. 로컬 public DB는 전환 전 보관본이므로 현재 AWS DB 위에 다시 복원하지 않는다. 촬영용 별도 스키마는 유지할 수 있다.

- `/`와 `/api/health`가 인증서 검증을 생략하지 않고 HTTPS 200을 반환하는지 확인한다. `/api/me`는 비인증 상태에서 401, 다른 Origin의 요청은 403이어야 한다.
- 카카오 기존 앱의 웹 허용 도메인에 새 HTTPS 주소를 **추가**한다. 기존 도메인과 키는 유지한다. SDK HTTP 확인과 실제 브라우저 지도 렌더링 확인은 구분해서 기록한다.
- SOLAPI 기존 키의 IP 제한에 새 서버 고정 IP를 추가해야 하는지 확인한다. 전체 허용으로 바꾸거나 키를 재발급하지 않는다. 기존 대기 작업을 바로 발송하지 않는다.
- 다른 주소로 다시 이전할 때도 API 주소만 변경하지 않는다. 명시적인 이전 허용 정책·같은 차량 인증·최종 동기화가 필요하다. 임의 서버나 새 주소에서 과거 주소로의 역방향 이전은 허용하지 않는다.
- 두 DB를 동시에 운영 DB로 사용하지 않는다. 전환 후에는 AWS DB의 새 백업을 기준으로 운영하며, 보관된 전환 전 로컬 DB로 일반 API를 다시 실행하지 않는다.
- Caddy 인증서와 PostgreSQL 볼륨을 보존한다. `docker compose down -v`를 실행하지 않는다. DB 백업과 APP_SECRET은 함께 안전하게 보관한다.

현재 단계와 실제 검증 결과는 로컬 `SESSION_HANDOFF.txt`와 `docs/AWS_DEPLOYMENT.md`에 기록한다. 실문자·실차 시험이 끝나지 않았다면 완료로 적지 않는다.
