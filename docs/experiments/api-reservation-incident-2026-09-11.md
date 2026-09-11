# 2026-09-11 API token reservation incident

- Production retained the old chat model name; corrected the server-owned OPENAI_CHAT_MODEL to the approved Nemotron model.
- First production smoke used whitespace-based token reservations. Query embedding reserved 9 tokens and became outcome_unknown; chat reserved 1164 tokens but settled 1383 tokens (208 micro-USD), blocking dec-012-cov009.
- Fix: API runtime reserves a UTF-8 byte upper bound, with per-message framing allowance for chat. Existing caps and explicit full-cap evaluation reservations remain enforced. No provider retry/fallback or allowance increase was introduced.
- Regression: Korean query provider usage greater than whitespace estimate must fit the reservation; subsequent chat remains executable. Runtime tests 7/7, API typecheck and focused ESLint passed.
- Recovery must preserve all original reservations and actual usage. Unknown embedding requires an additional conservative held reservation up to the 8192-token/33-micro-USD cap before unblocking. Do not mark that unknown usage settled or refund it.
