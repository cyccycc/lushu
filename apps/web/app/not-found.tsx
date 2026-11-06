import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 px-4 py-20">
      <h1 className="font-serif text-3xl">没有这一页</h1>
      <p className="text-muted-foreground">行程链接只存在于创建它的这台机器上。</p>
      <Button nativeButton={false} render={<Link href="/" />} className="w-fit rounded-full">
        回到首页
      </Button>
    </main>
  );
}
