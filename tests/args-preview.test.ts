import { describe, expect, it } from "vitest";
import { ARGS_PREVIEW_TOTAL_MAX, ARGS_PREVIEW_VALUE_MAX, buildArgsPreview, isSecretValue, isSensitiveKey, keySegments, maskQueryString, maskUrlQuery } from "../packages/governance/src/args-preview.js";

describe("buildArgsPreview", () => {
  it("null/undefined args -> null", () => {
    expect(buildArgsPreview(null)).toBeNull();
    expect(buildArgsPreview(undefined)).toBeNull();
  });

  it("renders key=value pairs and masks sensitive keys case-insensitively", () => {
    const preview = buildArgsPreview({ to: "a@b.com", Password: "hunter2", apiKey: "sk-live-1", Authorization: "Bearer abc", refresh_token: "rt", clientSecret: { v: 1 }, count: 3, ok: true, none: null });
    expect(preview).toBe("to=a@b.com, Password=***, apiKey=***, Authorization=***, refresh_token=***, clientSecret=***, count=3, ok=true, none=null");
    for (const raw of ["hunter2", "sk-live-1", "Bearer abc", "rt,"]) expect(preview).not.toContain(raw);
  });

  it("masks recursively in nested objects and arrays", () => {
    const preview = buildArgsPreview({ conn: { host: "db", auth: { password: "p@ss", user: "u" } }, items: [{ token: "t1", id: 1 }, "x"] })!;
    expect(preview).toBe("conn={host=db, auth={password=***, user=u}}, items=[{token=***, id=1}, x]");
    expect(preview).not.toContain("p@ss");
    expect(preview).not.toContain("t1");
  });

  it("truncates each value to 80 chars", () => {
    const preview = buildArgsPreview({ body: "a".repeat(200) })!;
    const value = preview.slice("body=".length);
    expect(Array.from(value)).toHaveLength(ARGS_PREVIEW_VALUE_MAX);
    expect(value.endsWith("…")).toBe(true);
    expect(buildArgsPreview({ body: "b".repeat(80) })).toBe(`body=${"b".repeat(80)}`);
  });

  it("caps the whole preview at 300 chars", () => {
    const args = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, "x".repeat(70)]));
    const preview = buildArgsPreview(args)!;
    expect(Array.from(preview)).toHaveLength(ARGS_PREVIEW_TOTAL_MAX);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("handles non-object args and deep nesting", () => {
    expect(buildArgsPreview("plain")).toBe("plain");
    expect(buildArgsPreview([1, 2])).toBe("[1, 2]");
    expect(buildArgsPreview({})).toBe("");
    expect(buildArgsPreview({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toBe("a={b={c={d={e={…}}}}}");
  });

  it("key masking by word segment: api_key/apiKey/accessToken/X-Api-Key hit; keyword/monkey/tokenizer do not", () => {
    expect(keySegments("APIKey")).toEqual(["api", "key"]);
    expect(keySegments("X-Api-Key")).toEqual(["x", "api", "key"]);
    expect(keySegments("oauth2AccessToken")).toEqual(["oauth", "2", "access", "token"]);
    for (const key of ["api_key", "apiKey", "APIKey", "accessToken", "X-Api-Key", "password", "DB_PASSWORD", "client.secret", "Authorization", "key", "token2"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ["keyword", "monkey", "tokenizer", "secretary", "author", "cookbook", "pwdx"]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
    expect(buildArgsPreview({ keyword: "合同", monkey: "m", tokenizer: "bpe", "X-Api-Key": "abc123" })).toBe("keyword=合同, monkey=m, tokenizer=bpe, X-Api-Key=***");
  });

  it("value masking: Bearer/Basic/sk-/ghp_/xox/JWT under any key, at any depth, in arrays", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    const preview = buildArgsPreview({
      header: "Bearer abc.def",
      auth2: "  basic dXNlcjpwYXNz",
      openai: "sk-proj-123",
      gh: "ghp_ABCDEF",
      slack: "xoxb-1-2-3",
      jwt,
      nested: { list: ["ok", "sk-inner-999", { deep: jwt }] },
      plain: "eyJ not a jwt",
      skip: "skill",
    })!;
    expect(preview).toBe("header=***, auth2=***, openai=***, gh=***, slack=***, jwt=***, nested={list=[ok, ***, {deep=***}]}, plain=eyJ not a jwt, skip=skill");
    for (const raw of ["abc.def", "dXNlcjpwYXNz", "sk-proj-123", "ghp_ABCDEF", "xoxb-1-2-3", "c2lnbmF0dXJl", "sk-inner-999"]) expect(preview).not.toContain(raw);
    expect(buildArgsPreview("Bearer top-level")).toBe("***");
  });

  it("URL query masking keeps the rest of the URL, then truncates to 80", () => {
    expect(maskUrlQuery("https://x.test/cb?a=1&token=T0K&Signature=S1G&access_token=AT&keep=yes#frag")).toBe("https://x.test/cb?a=1&token=***&Signature=***&access_token=***&keep=yes#frag");
    expect(maskUrlQuery("https://x.test/p?KEY=k1&sig=s&secret=z&q=key")).toBe("https://x.test/p?KEY=***&sig=***&secret=***&q=key");
    expect(maskUrlQuery("ftp://x.test/?token=t")).toBe("ftp://x.test/?token=t");
    expect(maskUrlQuery("not a url ?token=t")).toBe("not a url ?token=t");
    const preview = buildArgsPreview({ callback: "https://hooks.example.com/notify?id=42&sig=deadbeefcafebabe", links: [`http://a.test/?q=1&key=K3Y${"x".repeat(100)}`] })!;
    expect(preview.startsWith("callback=https://hooks.example.com/notify?id=42&sig=***, links=[http://a.test/?q=1&key=***")).toBe(true);
    expect(preview).not.toContain("deadbeefcafebabe");
    expect(preview).not.toContain("K3Y");
    const long = buildArgsPreview({ u: `https://a.test/${"p".repeat(100)}?token=zzz` })!;
    expect(Array.from(long.slice(2))).toHaveLength(ARGS_PREVIEW_VALUE_MAX);
    expect(long).not.toContain("zzz");
  });

  it("plural/variant key words: passwords, pwd, passwd, tokens, secrets, keys, credential(s), cookie(s)", () => {
    for (const key of ["passwords", "DB_PWD", "userPasswd", "refreshTokens", "client_secrets", "apiKeys", "credential", "awsCredentials", "Cookie", "set_cookies", "Set-Cookie", "passwords_reset_count"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    expect(isSensitiveKey("secretary")).toBe(false);
    expect(buildArgsPreview({ pwd: "p1", cookies: ["a=1"], credentials: { user: "u" }, secretary: "Ms Li" })).toBe("pwd=***, cookies=***, credentials=***, secretary=Ms Li");
  });

  it("value prefixes are case-insensitive: SK-, GHP_, XOXB-, BEARER, basic", () => {
    for (const value of ["SK-PROJ-1", "Sk-x", "GHP_abc", "XOXB-1-2", "BEARER abc", "bearer abc", "BASIC dXNl", " sk-trim "]) {
      expect(isSecretValue(value), value).toBe(true);
    }
    for (const value of ["skill", "ghp", "Bearer", "basically"]) expect(isSecretValue(value), value).toBe(false);
    expect(buildArgsPreview({ a: "SK-UPPER-1", b: ["GHP_UP"], c: "BEARER UP" })).toBe("a=***, b=[***], c=***");
  });

  it("URL-looking strings with ? that are not parseable http(s) URLs lose everything after the first ?", () => {
    expect(maskQueryString("ftp://x.test/?token=t&a=1")).toBe("ftp://x.test/?***");
    expect(maskQueryString("/api/v1/hook?sig=abc&x=1")).toBe("/api/v1/hook?***");
    expect(maskQueryString("https://exa mple.com/p?token=t")).toBe("https://exa mple.com/p?***");
    expect(maskQueryString("http://[::1/x?key=k")).toBe("http://[::1/x?***");
    expect(maskQueryString("www.example.com/p?token=t")).toBe("www.example.com/p?***");
    expect(maskQueryString("no question mark")).toBe("no question mark");
    expect(maskQueryString("https://ok.test/p?a=1&token=t")).toBe("https://ok.test/p?a=1&token=***");
    const preview = buildArgsPreview({ path: "/cb?token=SECRETVAL", note: "ok?", list: ["x?y", "app://cb?code=SECRETVAL"] })!;
    expect(preview).toBe("path=/cb?***, note=ok?, list=[x?y, app://cb?***]");
    expect(preview).not.toContain("SECRETVAL");
  });

  it("plain sentences with ? are left unchanged", () => {
    for (const text of ["明天开会?", "要不要发给客户? 金额 500", "Is this OK?", "a?b"]) expect(maskQueryString(text)).toBe(text);
    expect(buildArgsPreview({ question: "明天开会?" })).toBe("question=明天开会?");
  });

  it("JSON-encoded object/array strings are parsed and masked with the same rules", () => {
    expect(buildArgsPreview({ body: '{"password":"x"}' })).toBe("body={password=***}");
    const preview = buildArgsPreview({
      body: ' {"to":"a@b.com","auth":{"apiKey":"K1"},"h":["Bearer B2"],"cb":"https://x.test/?sig=S3"} ',
      list: '[{"token":"T4"},"sk-T5"]',
      bad: '{"password": broken',
    })!;
    expect(preview).toBe('body={to=a@b.com, auth={apiKey=***}, h=[***], cb=https://x.test/?sig=***}, list=[{token=***}, ***], bad=***');
    for (const raw of ["K1", "B2", "S3", "T4", "sk-T5"]) expect(preview).not.toContain(raw);
    expect(buildArgsPreview('{"secret":"top"}')).toBe("{secret=***}");
  });

  it("JSON-like strings ({ or [ followed by \" ' { or [) that do not parse are masked whole; other bracket text is plain", () => {
    expect(buildArgsPreview({ a: '{ "password":"x"' })).toBe("a=***");
    expect(buildArgsPreview({ a: "{'token': 'x'" })).toBe("a=***");
    expect(buildArgsPreview({ a: '[{"k":' })).toBe("a=***");
    expect(buildArgsPreview({ a: '  [ ["sk-' })).toBe("a=***");
    expect(buildArgsPreview("{\"broken")).toBe("***");
    expect(buildArgsPreview({ d: "[草稿] 周报" })).toBe("d=[草稿] 周报");
    expect(buildArgsPreview({ d: "{名字} 你好" })).toBe("d={名字} 你好");
    expect(buildArgsPreview({ d: "[1, 2", e: "{not json}", f: "[1, 2]", g: "{}" })).toBe("d=[1, 2, e={not json}, f=[1, 2], g={}");
    expect(buildArgsPreview({ d: "[草稿] /cb?token=T" })).toBe("d=[草稿] /cb?token=T");
  });

  // Known limitations, pinned to the CURRENT output so any change in behaviour is noticed.
  // These values are NOT masked today; see docs/03-api/admin-api.md "已知限制".
  describe("known limitations (pinned current output)", () => {
    it("secrets after # in a URL are kept", () => {
      expect(buildArgsPreview({ u: "https://app.test/cb#access_token=FRAG1" })).toBe("u=https://app.test/cb#access_token=FRAG1");
      expect(buildArgsPreview({ u: "https://app.test/cb?a=1&token=Q#token=FRAG2" })).toBe("u=https://app.test/cb?a=1&token=***#token=FRAG2");
      expect(buildArgsPreview({ u: "/cb?x=1#token=FRAG3" })).toBe("u=/cb?***");
    });

    it("URL-ish values without a scheme, leading / or www. are not treated as URLs", () => {
      expect(buildArgsPreview({ u: "ex.com/a?token=NOSCHEME" })).toBe("u=ex.com/a?token=NOSCHEME");
      expect(buildArgsPreview({ u: "api.ex.com:8443/v1?key=NOSCHEME2" })).toBe("u=api.ex.com:8443/v1?key=NOSCHEME2");
    });

    it("secrets inside free text are kept", () => {
      expect(buildArgsPreview({ note: "密码是 hunter2，token=abc123" })).toBe("note=密码是 hunter2，token=abc123");
      expect(buildArgsPreview({ note: "use Authorization: Bearer abc" })).toBe("note=use Authorization: Bearer abc");
    });

    it("full-width ？ is not a query separator", () => {
      expect(buildArgsPreview({ u: "/cb？token=FW1" })).toBe("u=/cb？token=FW1");
      expect(buildArgsPreview({ u: "https://x.test/p？token=FW2" })).toBe("u=https://x.test/p？token=FW2");
      expect(buildArgsPreview({ u: "www.x.test/p？token=FW3" })).toBe("u=www.x.test/p？token=FW3");
    });
  });
});
