import { LoginForm } from "@/components/login-form";
import { Card, CardContent } from "@/components/ui/card";

export default function LoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-4 py-12">
      <div className="space-y-2">
        <h1 className="font-serif text-4xl">登录</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          登录之后，新的路书会记在这个邮箱下。行程仍只存在这台机器上，也不会因此开通预订或付款。
        </p>
      </div>
      <Card>
        <CardContent className="pt-1">
          <LoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
