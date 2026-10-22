import { useEffect, useState } from "react";
import { api, ApiError, type Session } from "@/lib/api";
import { Button } from "@/components/ui/button";

export function LoginPage({ onLogin }: { onLogin: (session: Session) => void }) {
  const [config, setConfig] = useState<{ localLogin?: boolean; oidcConfigured?: boolean }>({ localLogin: true });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<typeof config>("/auth/config").then(setConfig).catch(() => {});
  }, []);

  return (
    <div className="grid h-full place-items-center p-6">
      <form
        className="w-full max-w-[380px] rounded-dialog border border-border bg-card p-8 shadow-sm"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            onLogin(await api<Session>("/auth/local/login", { method: "POST", body: { email, password } }));
          } catch (err) {
            setError(err as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="mb-6 flex items-center gap-2 text-lg font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-control bg-primary text-sm text-primary-foreground">F</span>
          登录 Forge 控制台
        </div>
        {config.localLogin !== false ? (
          <>
            <label className="block text-sm">
              邮箱
              <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" className="mt-1.5 h-9 w-full rounded-control border border-border bg-card px-3 outline-none focus:ring-4 focus:ring-ring" />
            </label>
            <label className="mt-4 block text-sm">
              密码
              <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1.5 h-9 w-full rounded-control border border-border bg-card px-3 outline-none focus:ring-4 focus:ring-ring" />
            </label>
            {error && <p role="alert" className="mt-3 text-sm text-destructive">{error.message}{error.code ? `（${error.code}）` : ""}</p>}
            <Button type="submit" className="mt-6 w-full" loading={busy}>登录</Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">请使用统一 SSO 登录。</p>
        )}
        {config.oidcConfigured && (
          <a href="/auth/oidc/login" className="mt-3 flex h-9 items-center justify-center rounded-control border border-border text-sm font-medium hover:bg-muted">使用统一 SSO 登录</a>
        )}
      </form>
    </div>
  );
}
