# 작업 방식

- **`main` 에 바로 push 한다.** 브랜치를 따로 파거나 PR 을 만들지 않는다.
  저장소 주인 혼자 쓰는 웹앱이고, `main` 에 올라가면 `.github/workflows/pages.yml`
  이 그대로 GitHub Pages 에 배포한다.
- 커밋은 무엇을 왜 바꿨는지 한국어로 적는다. 기존 커밋 메시지의 결을 따른다.

# 프로젝트

빌드 단계가 없는 정적 웹앱이다. 모듈은 브라우저가 그대로 읽는 ES 모듈이고,
번들러·패키지 매니저·테스트 러너가 없다.

```sh
python3 -m http.server 8000   # http://localhost:8000
```

마이크와 Wake Lock, 서비스워커는 보안 컨텍스트를 요구한다. `localhost` 이거나
HTTPS 여야 한다.

## 확인

테스트 스위트가 없으므로, 바꾼 것은 실제로 띄워서 확인한다. 마이크가 없는
환경에서는 `getUserMedia` 를 오실레이터 + `MediaStreamAudioDestinationNode` 로
바꿔치기하면 검출 경로까지 그대로 돌려볼 수 있다.

`src/*.js` 를 건드렸으면 `sw.js` 의 `VERSION` 을 올린다. 안 올리면 캐시된 옛 셸이
계속 나간다.

## 코드

- 주석은 한국어로, 무엇을 하는지가 아니라 **왜 그렇게 했는지**를 적는다.
  특히 그렇게 하지 않으면 무엇이 깨지는지를 남긴다.
- 화면은 완전한 검정(`#000`)이 기본이다. OLED 배터리 때문이므로 큰 면적을
  밝게 칠하지 않는다.
- 손가락으로 쓰는 화면이다. `html, body` 가 `touch-action: none` 이라, 스크롤이나
  끌기가 필요한 요소에는 `touch-action` 을 직접 돌려줘야 한다.
- 설정값은 `src/store.js` 를 거쳐 localStorage 에 넣는다. 저장 실패는 조용히 무시한다.
