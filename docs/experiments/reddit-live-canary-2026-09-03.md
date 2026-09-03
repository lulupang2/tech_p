# Reddit live canary observation

- Executed: 2026-09-03 (Asia/Seoul)
- Request: `GET https://www.reddit.com/robots.txt`
- Response: HTTP 200, `text/plain; charset=utf-8`
- Relevant directives: `User-agent: *` / `Disallow: /`
- Result: **BLOCKED — `REDDIT_ROBOTS_DISALLOWED`**

The collector must stop before Reddit page navigation for this response. No login, CAPTCHA, header, or robots-policy bypass was attempted, and no Reddit corpus was collected.
