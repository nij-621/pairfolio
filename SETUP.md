# Pairfolio 셋업 (1회, 두 분이 직접 하는 부분)

## 1. 스키마 설치
1. Supabase 대시보드 → **SQL Editor**
2. `migrations/001_init.sql` 내용 전체 복사
3. **붙여넣기 전에 맨 아래 seed 절의 이메일 두 줄 수정**:
   - 본인 이메일의 `member_code`가 맞는지 확인 (KM=규문, MK=민경)
   - `SPOUSE_EMAIL_HERE` → 배우자 실제 이메일
4. Run 실행 → "Success" 확인

## 2. 회원가입 차단
- **Authentication → Sign In / Providers → Email** → "Allow new users to sign up" **끄기**

## 3. 사용자 2명 수동 생성
- **Authentication → Users → Add user → Create new user**
- 두 분 각각: 이메일 + 비밀번호 입력, **Auto Confirm User 체크**
- 이메일은 1번에서 seed에 넣은 주소와 정확히 같아야 함

## 4. 비밀번호를 잊었을 때
- 관리자(대시보드 접근자)가 **Authentication → Users → 해당 유저 → Reset password**로 수동 재설정
- (이메일 발송 방식은 커스텀 SMTP가 필요해서 쓰지 않음)

## 5. 로컬 테스트
```
powershell -ExecutionPolicy Bypass -File serve.ps1
```
→ http://localhost:8126 접속, 로그인 확인

## 백업 습관
- 월 1회 앱의 **더보기 → JSON (전체 백업)** 다운로드 → 안전한 곳에 보관
