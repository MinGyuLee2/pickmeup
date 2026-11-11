# AWS 서울 배포

Ubuntu 24.04 Lightsail 한 대에서 Caddy(HTTPS), API, PostgreSQL 17을 운영한다. 서버 요금제와 크레딧 적용 여부는 생성 전에 해당 AWS 계정에서 확인한다. 기존 `deploy/compose.yaml`의 SENS 구성은 별도로 유지한다.

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

## 전환 전에 확인할 사항

- `/`와 `/api/health`가 인증서 검증을 생략하지 않고 HTTPS 200을 반환하는지 확인한다. `/api/me`는 비인증 상태에서 401, 다른 Origin의 요청은 403이어야 한다.
- 카카오 기존 앱의 웹 허용 도메인에 새 HTTPS 주소를 **추가**한다. 기존 도메인과 키는 유지한다. SDK HTTP 확인과 실제 브라우저 지도 렌더링 확인은 구분해서 기록한다.
- SOLAPI 기존 키의 IP 제한에 새 서버 고정 IP를 추가해야 하는지 확인한다. 전체 허용으로 바꾸거나 키를 재발급하지 않는다. 기존 대기 작업을 바로 발송하지 않는다.
- 현재 APK의 API 주소는 자동으로 바뀌지 않는다. Android의 암호화 계정 정보는 `API_BASE_URL`에 묶여 있으므로 URL만 바꾼 APK를 설치하면 기존 연결을 재사용하지 못한다. 계정·차량 연결을 보존할 마이그레이션과 최종 DB 동기화를 완료한 뒤 전환한다. 기존 앱을 삭제하거나 보안 바인딩을 제거하지 않는다.
- 두 DB를 동시에 운영 DB로 사용하지 않는다. 새 서버의 온라인 백업 복원본은 전환 준비본이며, 기존 클라이언트는 전환 전까지 기존 서버를 사용한다.
- Caddy 인증서와 PostgreSQL 볼륨을 보존한다. `docker compose down -v`를 실행하지 않는다. DB 백업과 APP_SECRET은 함께 안전하게 보관한다.

현재 단계와 실제 검증 결과는 로컬 `SESSION_HANDOFF.txt`와 `docs/AWS_DEPLOYMENT.md`에 기록한다. 실문자·실차 시험이 끝나지 않았다면 완료로 적지 않는다.
